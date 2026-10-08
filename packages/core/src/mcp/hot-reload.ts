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
import { serverRuntimeConfig } from "./server-config";
import { syncMCPToolsToDB, syncMCPToolsToIndex, clearMCPToolsFromDB } from "./tool-sync";
import type { MCPClientManager } from "@johpaz/hivecode-mcp";

const log = logger.child("mcp:hot-reload");

let interval: ReturnType<typeof setInterval> | null = null;
let pending: Promise<void> | null = null;
let known = new Set<string>();
const toolSignatures = new Map<string, string>();
let manager: MCPClientManager | null = null;

export function startMCPHotReload(next: MCPClientManager): void {
  if (interval) return;
  manager = next;
  const tick = () => {
    if (pending) return;
    pending = syncMCPServers(next).catch(error => log.error(`MCP sync failed: ${error.message}`))
      .finally(() => { pending = null; });
  };
  tick();
  interval = setInterval(tick, 2000);
  interval.unref?.();
}

export async function stopMCPHotReload(): Promise<void> {
  if (interval) clearInterval(interval);
  interval = null;
  await pending;
  await manager?.disconnectAll();
  manager = null;
  known.clear();
  toolSignatures.clear();
}

async function syncMCPServers(mcpManager: MCPClientManager): Promise<void> {
  const servers = await col<McpServerDoc>("mcpServers");
  const rows = await servers.scan();
  const enabled = rows.filter(row => row.doc.enabled);
  const invalid = new Set<string>();
  const current = new Set(enabled.map(row => row.doc.id || row.doc.name));
  const config = mcpManager.getConfig();
  const runtime = { ...config.servers };
  let toolsDirty = false;
  for (const name of known) delete runtime[name];
  for (const row of rows) {
    const name = row.doc.id || row.doc.name;
    // Disabled database entries also override any static configuration.
    if (!row.doc.enabled) delete runtime[name];
    else {
      try { runtime[name] = await serverRuntimeConfig(row.doc); }
      catch {
        delete runtime[name]; invalid.add(name);
        log.error(`MCP configuration cannot be decrypted or parsed: ${name}`);
      }
    }
  }
  await mcpManager.updateConfig({ ...config, servers: runtime });
  for (const row of rows) {
    const name = row.doc.id || row.doc.name;
    const status = !row.doc.enabled ? "disconnected" : invalid.has(name) ? "error" : mcpManager.getServerStatus(name) ?? "disconnected";
    const tools = status === "connected" ? mcpManager.getServerTools(name) : [];
    if (row.doc.status !== status || row.doc.tools_count !== tools.length) {
      const latest = await servers.get(row.id);
      if (latest && latest.doc.enabled === row.doc.enabled) await servers.put(row.id, { ...latest.doc, status, tools_count: tools.length }, { expectedVersion: latest.version });
    }
    const signature = JSON.stringify([row.doc.name, tools]);
    if (toolSignatures.get(row.id) !== signature) {
      await syncMCPToolsToDB(row.id, row.doc.name, tools);
      toolSignatures.set(row.id, signature);
      toolsDirty = true;
    }
  }
  for (const name of known) if (!current.has(name)) { await clearMCPToolsFromDB(name); toolSignatures.delete(name); toolsDirty = true; }
  if (toolsDirty) await syncMCPToolsToIndex();
  known = current;
}
