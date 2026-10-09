import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPConfig, MCPServerConfig } from "./config";
import { Logger, type LogHandler } from "./logger";
import * as path from "node:path";
import {
  createTransport,
  type TransportType,
} from "./transports/index";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

interface MCPServerState {
  name: string;
  config: MCPServerConfig;
  client: Client | null;
  transport: Transport | null;
  status: "connected" | "disconnected" | "error" | "connecting";
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  reconnectAttempts: number;
  lastError?: string;  // Last connection error for diagnostics
}

function publicUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}
function stableConfig(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableConfig).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableConfig(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export class MCPClientManager {
  private servers: Map<string, MCPServerState> = new Map();
  private config: MCPConfig;
  private log = new Logger("mcp");
  private attempts = new Set<Promise<void>>();
  private connecting = new Map<string, Promise<void>>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private revisions = new Map<string, number>();
  private reconciliation: Promise<void> = Promise.resolve();

  getConfig(): MCPConfig { return structuredClone(this.config); }

  constructor(config: MCPConfig, private factories?: { client: () => Client; transport: (config: MCPServerConfig) => Transport }) {
    this.config = config;
  }

  setLogHandler(handler: LogHandler): void {
    this.log.setHandler(handler);
  }

  async initialize(): Promise<void> {
    const servers = this.config.servers ?? {};

    for (const [name, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled !== false) {
        this.servers.set(name, {
          name,
          config: serverConfig as MCPServerConfig,
          client: null,
          transport: null,
          status: "disconnected",
          tools: [],
          resources: [],
          prompts: [],
          reconnectAttempts: 0,
        });
      }
    }

    this.log.info(`MCP Client initialized with ${this.servers.size} servers`);

    // Initialization includes the first connection attempt for each enabled server.
    await this.connectAll();
  }

  updateConfig(config: MCPConfig): Promise<void> {
    const next = structuredClone(config);
    const pending = this.reconciliation.then(() => this.reconcileConfig(next));
    this.reconciliation = pending.catch(() => {});
    return pending;
  }

  private async reconcileConfig(config: MCPConfig): Promise<void> {
    this.config = config;
    const newServers = this.config.servers ?? {};

    // Eliminar servers que ya no están en la config o fueron deshabilitados
    for (const name of this.servers.keys()) {
      if (!newServers[name] || newServers[name].enabled === false) {
        await this.disconnectServer(name);
        this.servers.delete(name);
      }
    }

    // Añadir o actualizar servers
    for (const [name, serverConfig] of Object.entries(newServers)) {
      if (serverConfig.enabled !== false) {
        const existing = this.servers.get(name);
        if (existing) {
          const configChanged =
            stableConfig(existing.config) !== stableConfig(serverConfig);
          if (configChanged) {
            await this.disconnectServer(name);
            existing.config = serverConfig as MCPServerConfig;
            {
              await this.connectServer(name).catch((err) => {
                this.log.error(
                  `Failed to reconnect ${name} after config update`
                );
              });
            }
          }
        } else {
          // Server nuevo — añadir y conectar inmediatamente
          this.servers.set(name, {
            name,
            config: serverConfig as MCPServerConfig,
            client: null,
            transport: null,
            status: "disconnected",
            tools: [],
            resources: [],
            prompts: [],
            reconnectAttempts: 0,
          });
          // Connect newly added enabled servers immediately.
          await this.connectServer(name).catch((err) => {
            this.log.error(`Failed to connect new server ${name}`);
          });
        }
      }
    }
  }

  private expandPath(p: string): string {
    if (p.startsWith("~")) {
      return path.join(process.env.HOME ?? "", p.slice(1));
    }
    return p;
  }

  private createTransportForServer(state: MCPServerState): Transport {
    if (this.factories) return this.factories.transport(state.config);
    const transportType = state.config.transport as TransportType;

    switch (transportType) {
      case "stdio": {
        const command = state.config.command ?? "npx";
        const args = state.config.args ?? [];

        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value;
        }
        if (state.config.env) {
          for (const [key, value] of Object.entries(state.config.env)) {
            env[key] = this.expandPath(value);
          }
        }

        return createTransport({ type: "stdio", stdio: { command, args, env } });
      }

      case "sse": {
        const url = state.config.url;
        if (!url) throw new Error("SSE transport requires 'url' config");
        return createTransport({
          type: "sse",
          sse: { url, headers: state.config.headers },
        });
      }

      case "websocket": {
        const url = state.config.url;
        if (!url) throw new Error("WebSocket transport requires 'url' config");
        return createTransport({
          type: "websocket",
          websocket: { url, headers: state.config.headers },
        });
      }

      case "http": {
        const url = state.config.url;
        if (!url) throw new Error("Streamable HTTP transport requires 'url' config");
        return createTransport({
          type: "http",
          http: { url, headers: state.config.headers },
        });
      }

      default:
        throw new Error(`Unknown transport type: ${transportType}`);
    }
  }

  connectServer(name: string): Promise<void> {
    const current = this.connecting.get(name);
    if (current) return current;
    const attempt = this.connectOnce(name);
    this.connecting.set(name, attempt);
    this.attempts.add(attempt);
    void attempt.finally(() => {
      this.attempts.delete(attempt);
      if (this.connecting.get(name) === attempt) this.connecting.delete(name);
    }).catch(() => {});
    return attempt;
  }

  private async connectOnce(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`MCP server not found: ${name}`);
    if (state.status === "connected") return;

    const revision = this.revisions.get(name) ?? 0;
    let client: Client | undefined;
    let transport: Transport | undefined;
    const isCurrent = () => this.servers.get(name) === state && (this.revisions.get(name) ?? 0) === revision;
    state.status = "connecting";
    state.lastError = undefined;  // limpiar error anterior
    this.log.info(`Connecting to MCP server: ${name}`);

    try {
      transport = this.createTransportForServer(state);

      client = this.factories?.client() ?? new Client(
        { name: "hive", version: "0.1.0" },
        { capabilities: {} }
      );

      client.onclose = () => {
        if (!isCurrent() || state.status !== "connected") return;
        state.client = null;
        state.transport = null;
        state.status = "error";
        state.tools = []; state.resources = []; state.prompts = [];
        state.lastError = "MCP transport closed";
        this.scheduleReconnect(name, state, revision);
      };
      state.client = client;
      state.transport = transport;
      await client.connect(transport);

      if (!isCurrent()) { await client.close(); return; }
      state.client = client;
      state.transport = transport;
      state.status = "connected";
      state.reconnectAttempts = 0;
      const retry = this.retries.get(name);
      if (retry) clearTimeout(retry);
      this.retries.delete(name);

      await this.discoverCapabilities(name, state);
      if (!isCurrent()) return;

      this.log.info(`Connected to MCP server: ${name}`, {
        tools: state.tools.length,
        resources: state.resources.length,
        prompts: state.prompts.length,
      });
    } catch (error) {
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
      if (!isCurrent()) return;
      state.client = null;
      state.transport = null;
      state.status = "error";
      // Keep the connection error available to dashboard diagnostics.
      state.lastError = "MCP connection failed; verify transport and credentials";
      this.log.error(`Failed to connect to MCP server ${name}: ${state.lastError}`);
      this.scheduleReconnect(name, state, revision);
      throw error;
    }
  }

  private scheduleReconnect(name: string, state: MCPServerState, revision: number): void {
    if (this.retries.has(name)) return;
    const delays = [2000, 5000, 15000, 30000, 60000];
    const timer = setTimeout(() => {
      this.retries.delete(name);
      if (this.servers.get(name) === state && (this.revisions.get(name) ?? 0) === revision) {
        void this.connectServer(name).catch(() => {});
      }
    }, delays[Math.min(state.reconnectAttempts++, delays.length - 1)]);
    timer.unref?.();
    this.retries.set(name, timer);
  }

  private async discoverCapabilities(name: string, state = this.servers.get(name)): Promise<void> {
    if (!state?.client) return;

    try {
      const toolsResult = await state.client.listTools();
      state.tools = (toolsResult.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } catch {
      this.log.debug(`No tools from MCP server: ${name}`);
    }

    try {
      const resourcesResult = await state.client.listResources();
      state.resources = (resourcesResult.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch {
      this.log.debug(`No resources from MCP server: ${name}`);
    }

    try {
      const promptsResult = await state.client.listPrompts();
      state.prompts = (promptsResult.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));
    } catch {
      this.log.debug(`No prompts from MCP server: ${name}`);
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return;
    this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1);
    const timer = this.retries.get(name);
    if (timer) clearTimeout(timer);
    this.retries.delete(name);
    // Detach the previous attempt: its revision cannot publish state after replacement.
    this.connecting.delete(name);

    if (state.client) {
      try {
        await state.client.close();
      } catch {
        // Ignorar errores al cerrar
      }
    }

    state.client = null;
    state.transport = null;
    state.status = "disconnected";
    state.tools = []; state.resources = []; state.prompts = [];
    state.lastError = undefined;

    this.log.info(`Disconnected from MCP server: ${name}`);
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const state = this.servers.get(serverName);
    if (!state?.client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    this.log.debug(`Calling MCP tool: ${serverName}/${toolName}`);

    const result = await state.client.callTool({
      name: toolName,
      arguments: args,
    });

    return result.content;
  }

  async readResource(serverName: string, uri: string): Promise<unknown> {
    const state = this.servers.get(serverName);
    if (!state?.client) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    const result = await state.client.readResource({ uri });
    return result.contents;
  }

  getServerStatus(name: string): MCPServerState["status"] | undefined {
    return this.servers.get(name)?.status;
  }

  getServerTools(name: string): MCPTool[] {
    return this.servers.get(name)?.tools ?? [];
  }

  getServerResources(name: string): MCPResource[] {
    return this.servers.get(name)?.resources ?? [];
  }

  getAllTools(): Map<string, MCPTool[]> {
    const result = new Map<string, MCPTool[]>();
    for (const [name, state] of this.servers) {
      if (state.status === "connected") {
        result.set(name, state.tools);
      }
    }
    return result;
  }

  listServers(): Array<{
    name: string;
    status: string;
    tools: MCPTool[];
    resources: MCPResource[];
    prompts: MCPPrompt[];
    url?: string;
    error?: string;
  }> {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.name,
      status: s.status,
      tools: s.tools,
      resources: s.resources,
      prompts: s.prompts,
      url: s.config.transport === "stdio" ? s.config.command : publicUrl(s.config.url),
      error: s.lastError,
    }));
  }

  getServerDetails(
    name: string
  ):
    | {
      name: string;
      status: string;
      tools: MCPTool[];
      resources: MCPResource[];
      prompts: MCPPrompt[];
      config: MCPServerConfig;
      error?: string;
    }
    | undefined {
    const s = this.servers.get(name);
    if (!s) return undefined;

    // Mask recognized credential headers before exposing server configuration.
    const safeConfig: MCPServerConfig = {
      transport: s.config.transport,
      enabled: s.config.enabled,
      command: s.config.command,
      url: publicUrl(s.config.url),
      headers: s.config.headers ? Object.fromEntries(Object.keys(s.config.headers).map(key => [key, "••••••••"])) : undefined,
      env: s.config.env ? Object.fromEntries(Object.keys(s.config.env).map(key => [key, "••••••••"])) : undefined,
    };

    return {
      name: s.name,
      status: s.status,
      tools: s.tools,
      resources: s.resources,
      prompts: s.prompts,
      config: safeConfig,
      error: s.lastError,
    };
  }

  async connectAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const name of this.servers.keys()) {
      promises.push(
        this.connectServer(name).catch((error) => {
          // No relanzar — el Gateway sigue funcionando sin ese server
          this.log.error(`Failed to connect ${name}`);
        })
      );
    }

    await Promise.allSettled(promises);
  }

  async reconnectAll(): Promise<void> {
    await this.disconnectAll();
    await this.connectAll();
  }

  async disconnectAll(): Promise<void> {
    const attempts = [...this.attempts];
    const promises: Promise<void>[] = [];

    for (const name of this.servers.keys()) {
      promises.push(this.disconnectServer(name));
    }

    await Promise.allSettled(promises);
    await Promise.allSettled(attempts);
  }
}

export function createMCPManager(config: MCPConfig): MCPClientManager {
  return new MCPClientManager(config);
}