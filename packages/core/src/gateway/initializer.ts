import type { Config } from "../config/loader";
import { logger } from "../utils/logger";
import { col } from "../storage/hive";
import type { AgentDoc, CodeConfigDoc, McpServerDoc, ProviderDoc, SkillDoc, UserDoc } from "../storage/collections";
import { buildAgentLoop } from "../agent/agent-loop";
import { AgentRunner } from "../agent/providers/index";
import { ChannelManager } from "../channels/manager";
import { syncToolsToIndex, syncSkillsToIndex, syncPlaybookToIndex } from "../agent/context-compiler";
import { syncMCPToolsToIndex } from "../mcp/tool-sync";
import { AgentService, createAgentService } from "../agent/service";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { createMCPManager, type MCPClientManager } from "@johpaz/hivecode-mcp";
import { setMCPManager } from "../mcp/singleton";
import { startMCPHotReload } from "../mcp/hot-reload";
import { getProviderApiKey } from "../storage/crypto";


const log = logger.child("gateway:init");

/**
 * Verifica que exista al menos un usuario en la base de datos
 */
export async function verifyDatabaseUsers(): Promise<void> {
  try {
    const users = await col<UserDoc>("users");
    const userCount = await users.count();

    if (userCount === 0) {
      const error = new Error("No users found in the database. A valid user is required to start the Hive Gateway.");
      log.error(error.message);
      log.error("Please run the onboarding process or manually insert a user.");
      throw error;
    }

    log.info(`HiveDB verified: ${userCount} user(s) found`);
  } catch (error) {
    log.error(`HiveDB verification failed: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Escribe el archivo PID del proceso
 */
export async function writePidFile(pidFile: string): Promise<void> {
  try {
    const dir = path.dirname(pidFile);
    mkdirSync(dir, { recursive: true });
    await Bun.write(pidFile, process.pid.toString());
    log.info(`PID file written: ${pidFile}`);
  } catch (error) {
    log.warn(`Could not write PID file: ${(error as Error).message}`);
    // No throw - PID file is not critical
  }
}

/**
 * Carga la configuración del agente desde la base de datos
 * @returns Provider y modelo configurados
 */
export async function loadAgentConfigFromDB(
  config: Config
): Promise<{ provider: string; model: string }> {
  const defaultProvider = "gemini";
  const defaultModel = "gemini-2.5-flash";

  try {
    const agents = await col<AgentDoc>("agents");
    const coordinator = (await agents.findBy("role", "coordinator"))[0]?.doc;

    let provider = coordinator?.provider_id;
    let model = coordinator?.model_id;

    // Fallback to codeConfig if the agent document doesn't have provider/model
    if (!provider || !model) {
      const codeConfig = await col<CodeConfigDoc>("codeConfig");
      const configuredProvider = (await codeConfig.get("default_provider"))?.doc.value;
      if (configuredProvider) {
        provider = configuredProvider;
        const modelKey = `provider_model_${configuredProvider}`;
        model = (await codeConfig.get(modelKey))?.doc.value || defaultModel;
      }
    }

    // Final fallback to hardcoded defaults
    provider = provider || defaultProvider;
    model = model || defaultModel;

    // Cargar API keys de providers activos desde el keystore del sistema.
    const providers = (await (await col<ProviderDoc>("providers")).findBy("active", true)).map(entry => entry.doc);

    if (providers.length > 0) {
      config.models = config.models || {};
      (config.models as any).providers = (config.models as any).providers || {};
      let loadedProviders = 0;

      for (const p of providers) {
        const apiKey = await getProviderApiKey(p.id);
        if (!apiKey) continue;

        (config.models as any).providers[p.name] = {
          apiKey,
          baseUrl: p.base_url || undefined,
          defaultModel: model,
          availableModels: [],
          maxRetries: 3,
          timeoutMs: 30000,
        } as any;
        loadedProviders++;
      }

      log.info(`Loaded ${loadedProviders} active provider key(s) from Bun.secrets`);
    }

    log.info(`Agent config loaded from HiveDB: ${provider}/${model}`);
    return { provider, model };

  } catch (error) {
    log.debug(`Could not read agent config from HiveDB, using defaults: ${defaultProvider}/${defaultModel}`);
    return { provider: defaultProvider, model: defaultModel };
  }
}

/**
 * Inicializa el agent loop
 */
export async function initializeAgentLoop(mcpManager?: any): Promise<void> {
  try {
    await buildAgentLoop({ mcpManager });
    log.info("Agent loop initialized");
  } catch (error) {
    log.warn(`Agent loop initialization failed: ${(error as Error).message}`);
    // No throw - agent loop can be rebuilt later
  }
}

/**
 * Inicializa el runner de LLM
 */
export async function initializeLLMRunner(
  config: Config,
  provider: string,
  model: string
): Promise<AgentRunner> {
  try {
    const runner = new AgentRunner(config);
    log.info(`LLM runner initialized: ${provider}/${model}`);
    return runner;
  } catch (error) {
    log.error(`Failed to initialize LLM runner: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Inicializa el manager de canales
 */
export async function initializeChannelManager(
  config: Config
): Promise<ChannelManager> {
  try {
    const channelManager = new ChannelManager(config);
    await channelManager.initialize();
    await channelManager.startAll();
    log.info("Channel manager initialized and started");
    return channelManager;
  } catch (error) {
    log.error(`Failed to initialize channel manager: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Función principal de inicialización que orquesta todos los módulos
 */
export interface GatewayInitializationResult {
  agent: AgentService;
  runner: AgentRunner;
  channelManager: ChannelManager;
  provider: string;
  model: string;
}

export async function initializeGateway(
  config: Config,
  pidFile: string
): Promise<GatewayInitializationResult> {
  // Setup mode: 0 usuarios en HiveDB
  let setupMode = false;
  try {
    const users = await col<UserDoc>("users");
    setupMode = (await users.count()) === 0;
  } catch {
    setupMode = true;
  }

  if (setupMode) {
    log.info("Setup mode: skipping full initialization — only setup routes will be available");
    await writePidFile(pidFile);
    // Return stubs; server.ts checks isSetupMode() before using these
    return {
      agent: null as any,
      runner: null as any,
      channelManager: null as any,
      provider: "",
      model: "",
    };
  }

  try {
    // 1. Verificar base de datos (crítico)
    await verifyDatabaseUsers();

    // 2. Escribir archivo PID (no crítico)
    await writePidFile(pidFile);

    // 3. Cargar configuración del agente desde DB
    const { provider, model } = await loadAgentConfigFromDB(config);

    // 4a. Sincronizar skills externos (Claude Code global + dirs custom via HIVE_SKILL_DIRS)
    //     Se ejecuta en cada arranque para pickup de skills recién instalados sin reseed.
    try {
      const { SkillLoader, getClaudeSkillsDirs } = await import("@johpaz/hivecode-skills")
      const loader = new SkillLoader({
        workspacePath: process.cwd(),
        skills: {
          extraDirs: [
            ...getClaudeSkillsDirs(),
            ...(process.env.HIVE_SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? []),
          ],
        },
      })
      const allSkills = loader.loadAllSkills()
      const skills = await col<SkillDoc>("skills")
      const now = Date.now()
      for (const s of allSkills) {
        const existing = await skills.get(s.name)
        await skills.put(s.name, {
          id: s.name,
          name: s.name,
          description: s.description || "",
          version: String(s.version || "0.0.1"),
          author: s.author || "Anonymous",
          icon: s.icon || "skill",
          category: s.category || "general",
          permissions: JSON.stringify(s.permissions || []),
          dependencies: JSON.stringify(s.dependencies || []),
          tools: (s.tools || []).join(","),
          triggers: (s.triggers || []).join(","),
          preferred_agents: JSON.stringify(s.preferred_agents || []),
          body: s.content || "",
          version_num: 1,
          active: true,
          created_at: existing?.doc.created_at ?? now,
          updated_at: now,
        }, { expectedVersion: existing?.version ?? 0 })
      }
      log.info(`[initialize] ✅ ${allSkills.length} skills sincronizados (bundled + externos)`)
    } catch (err) {
      log.warn(`[initialize] External skill sync failed: ${(err as Error).message}`)
    }

    // 4. Sync HiveDB capability indexes (tools + skills + playbook + MCP tools)
    log.info("[initialize] Syncing HiveDB capability indexes...")
    try {
      await Promise.all([
        syncToolsToIndex(),
        syncSkillsToIndex(),
        syncPlaybookToIndex(),
        syncMCPToolsToIndex()
      ]);
      log.info("[initialize] ✅ HiveDB capability indexes synced (tools, skills, playbook, MCP tools)")
    } catch (err) {
      log.error(`[initialize] HiveDB capability index sync failed during startup: ${(err as Error).message}`);
      // Consider if we should throw or continue. For now, continue but log error.
    }

    // 5. Crear AgentService (reemplaza la clase Agent legacy)
    const agent = createAgentService();
    await agent.initialize();

    // 6. Inicializar MCP Manager y agent loop
    // MCP se inicializa con los servidores de la config + HiveDB
    let mcpManager: MCPClientManager | null = null;

    // Load MCP servers from HiveDB and merge with config
    const dbServers = await (await col<McpServerDoc>("mcpServers")).findBy("enabled", true);

    const mcpServersFromDB: Record<string, any> = {};
    for (const entry of dbServers) {
      const server = entry.doc;
      try {
        const mcpServerConfig: any = {
          transport: server.transport,
          command: server.command,
          args: server.args ? JSON.parse(server.args) : [],
          url: server.url,
          enabled: true,
        };

        // Decrypt headers if present
        if (server.headers_encrypted && server.headers_iv) {
          const { decryptConfig } = await import("../storage/crypto");
          mcpServerConfig.headers = decryptConfig(server.headers_encrypted, server.headers_iv);
        }

        mcpServersFromDB[server.id || server.name] = mcpServerConfig;
      } catch (error) {
        log.warn(`Failed to load MCP server ${server.name} from DB: ${(error as Error).message}`);
      }
    }

    // Merge config MCP servers with DB servers
    const configMcpServers = config.mcp?.servers || {};
    const mergedMcpServers = { ...configMcpServers, ...mcpServersFromDB };

    if (Object.keys(mergedMcpServers).length > 0) {
      try {
        mcpManager = createMCPManager({
          ...config.mcp,
          servers: mergedMcpServers,
        });
        await mcpManager.initialize();
        setMCPManager(mcpManager); // Save to singleton for global access
        log.info(`MCP Manager initialized with ${Object.keys(mergedMcpServers).length} server(s) from config + DB`);

        // Start hot reload watcher for dynamic server changes
        startMCPHotReload(mcpManager);
        log.info("MCP Hot Reload started - new servers will auto-connect");
      } catch (error) {
        log.warn(`MCP Manager initialization failed: ${(error as Error).message}`);
      }
    } else {
      log.info("No MCP servers found in config or DB");
      // Initialize empty MCP Manager for hot reload to work
      try {
        mcpManager = createMCPManager({ servers: {} });
        await mcpManager.initialize();
        setMCPManager(mcpManager);
        startMCPHotReload(mcpManager);
        log.info("MCP Hot Reload started - waiting for first server");
      } catch (error) {
        log.warn(`Empty MCP Manager initialization failed: ${(error as Error).message}`);
      }
    }

    // Inicializar agent loop con MCP Manager
    await initializeAgentLoop(mcpManager || undefined);

    // 7. Inicializar LLM runner (crítico)
    const runner = await initializeLLMRunner(config, provider, model);

    // 8. Inicializar channel manager (crítico)
    const channelManager = await initializeChannelManager(config);

    return { agent, runner, channelManager, provider, model };

  } catch (error) {
    log.error(`Gateway initialization failed: ${(error as Error).message}`);
    throw error;
  }
}
