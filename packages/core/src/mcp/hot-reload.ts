/**
 * MCP Hot Reload
 *
 * Watches for MCP server changes in HiveDB and updates MCP Manager automatically
 * 
 * Architecture: Direct Connection
 * - MCP servers are tracked in the `mcpServers` collection.
 * - MCP tools are loaded at runtime from connected servers.
 */

import { col } from "../storage/hive";
import type { McpServerDoc } from "../storage/collections";
import { logger } from "../utils/logger";
import { decryptConfig } from "../storage/crypto";
import { syncMCPToolsToDB, syncMCPToolsToIndex, clearMCPToolsFromDB } from "./tool-sync";
import type { MCPClientManager } from "@johpaz/hivecode-mcp";

const log = logger.child("mcp:hot-reload");

let _watchInterval: Timer | null = null;
let _lastKnownServers = new Set<string>();

/**
 * Start watching for MCP server changes
 * Checks every 2 seconds for new/removed servers
 */
export function startMCPHotReload(mcpManager: MCPClientManager): void {
  if (_watchInterval) {
    log.warn("MCP Hot Reload already running");
    return;
  }

  log.info("Starting MCP Hot Reload watcher (2s interval)");

  // Initial sync - sync all currently connected servers
  syncMCPServers(mcpManager).then(() => {
    log.info("Initial MCP server sync complete");
  }).catch(err => {
    log.error(`Initial MCP server sync failed: ${err.message}`);
  });

  // Watch for changes
  _watchInterval = setInterval(() => {
    syncMCPServers(mcpManager);
  }, 2000);
}

/**
 * Stop watching
 */
export function stopMCPHotReload(): void {
  if (_watchInterval) {
    clearInterval(_watchInterval);
    _watchInterval = null;
    log.info("MCP Hot Reload stopped");
  }
}

/**
 * Sync MCP servers from HiveDB to MCP Manager.
 * Note: Only server status is tracked, tools are loaded at runtime
 */
async function syncMCPServers(mcpManager: MCPClientManager): Promise<void> {
  try {
    const serversCol = await col<McpServerDoc>("mcpServers");
    const dbServers = (await serversCol.findBy("enabled", true)).map((entry) => entry.doc);

    const currentServerNames = new Set(dbServers.map(s => s.id || s.name));

    // Detect new servers
    for (const server of dbServers) {
      const serverName = server.id || server.name;

      if (!_lastKnownServers.has(serverName)) {
        log.info(`New MCP server detected: ${serverName} - connecting...`);

        try {
          const mcpServerConfig: any = {
            transport: server.transport,
            command: server.command,
            args: server.args ? JSON.parse(server.args) : [],
            url: server.url,
            enabled: true,
          };

          if (server.headers_encrypted && server.headers_iv) {
            mcpServerConfig.headers = decryptConfig(server.headers_encrypted, server.headers_iv);
          }

          // Update MCP Manager config (auto-connects new servers)
          const currentConfig = (mcpManager as any).config || { servers: {} };
          await mcpManager.updateConfig({
            ...currentConfig,
            servers: {
              ...currentConfig.servers,
              [serverName]: mcpServerConfig,
            },
          });

          // Wait a bit for connection to establish
          await new Promise(resolve => setTimeout(resolve, 500));

          // Get tools count and update status
          const tools = mcpManager.getServerTools(serverName) || [];
          await patchServer(serverName, { status: "connected", tools_count: tools.length });

          // Persist MCP tool definitions to HiveDB and the capability index
          // Use server.name (human-readable) for mcpToolId consistency with context-compiler
          await syncMCPToolsToDB(server.id || server.name, server.name || serverName, tools);
          await syncMCPToolsToIndex();

          log.info(`MCP server ${serverName} connected: ${tools.length} tools available`);
        } catch (err) {
          log.error(`Failed to connect MCP server ${serverName}: ${(err as Error).message}`);
          await patchServer(serverName, { status: "error" });
        }
      }
    }

    // Detect removed servers
    for (const oldServerName of _lastKnownServers) {
      if (!currentServerNames.has(oldServerName)) {
        log.info(`MCP server removed: ${oldServerName} - disconnecting...`);

        try {
          // Remove from MCP Manager
          const currentConfig = (mcpManager as any).config || { servers: {} };
          delete currentConfig.servers[oldServerName];
          await mcpManager.updateConfig(currentConfig);

          // Delete MCP tool definitions from HiveDB and the capability index
          await clearMCPToolsFromDB(oldServerName);

          await patchServer(oldServerName, { status: "disconnected", tools_count: 0 });

          log.info(`MCP server ${oldServerName} disconnected`);
        } catch (err) {
          log.error(`Failed to disconnect MCP server ${oldServerName}: ${(err as Error).message}`);
        }
      }
    }

    _lastKnownServers = currentServerNames;
  } catch (err) {
    log.error(`MCP server sync failed: ${(err as Error).message}`);
  }
}

async function patchServer(id: string, patch: Partial<McpServerDoc>): Promise<void> {
  const servers = await col<McpServerDoc>("mcpServers");
  const entry = await servers.get(id);
  if (!entry) return;
  await servers.put(id, { ...entry.doc, ...patch }, { expectedVersion: entry.version });
}
