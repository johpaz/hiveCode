/**
 * MCP Tool Sync — Persist MCP tool definitions to DB and the HiveDB index.
 *
 * When an MCP server connects, its tool definitions are persisted to the
 * `mcpTools` collection and indexed in the HiveDB capability index for
 * search_knowledge. When the server disconnects, all its tools are deleted
 * from both.
 */

import { col } from "../storage/hive"
import type { McpToolDoc } from "../storage/collections"
import { logger } from "../utils/logger"
import { mcpToolFullName } from "../agent/tool-selector"
import {
    replaceCapabilityDocs,
    deleteCapabilitiesByServer,
    type CapabilityDoc,
} from "../agent/capability-search"

const log = logger.child("mcp:tool-sync")

async function getMcpToolsCollection() {
    const mcpToolsCol = await col<McpToolDoc>("mcpTools")
    await mcpToolsCol.createIndex("server_id")
    await mcpToolsCol.createIndex("active")
    return mcpToolsCol
}

export interface MCPToolDefinition {
    name: string
    description: string
    inputSchema?: Record<string, unknown>
}

/**
 * Generate a stable ID for an MCP tool based on server + tool name.
 *
 * This must match the LLM function name exactly because agent-loop resolves
 * search results against executors by this string.
 */
export function mcpToolId(serverName: string, toolName: string): string {
    return mcpToolFullName(serverName, toolName)
}

/**
 * Persist MCP tool definitions to the `mcpTools` collection.
 */
export async function syncMCPToolsToDB(
    serverId: string,
    serverName: string,
    tools: MCPToolDefinition[]
): Promise<void> {
    try {
        const mcpToolsCol = await getMcpToolsCollection()
        const existing = await mcpToolsCol.findBy("server_id", serverId)
        for (const e of existing) await mcpToolsCol.delete(e.id)

        if (tools.length === 0) {
            log.debug(`[mcp:tool-sync] No tools to persist for server ${serverName}`)
            return
        }

        let count = 0
        for (const tool of tools) {
            const id = mcpToolId(serverName, tool.name)
            const now = Math.floor(Date.now() / 1000)
            await mcpToolsCol.put(id, {
                id,
                server_id: serverId,
                server_name: serverName,
                tool_name: tool.name,
                description: tool.description || "",
                category: "mcp",
                active: true,
                created_at: now,
                updated_at: now,
            })
            count++
        }

        log.info(`[mcp:tool-sync] Persisted ${count} MCP tools for server ${serverName} to mcpTools`)
    } catch (err) {
        log.error(`[mcp:tool-sync] Failed to persist MCP tools for server ${serverName}:`, err)
    }
}

/**
 * Sync all active MCP tools from the `mcpTools` collection to the HiveDB
 * capability index.
 */
export async function syncMCPToolsToIndex(): Promise<void> {
    try {
        const mcpToolsCol = await getMcpToolsCollection()
        const mcpTools = (await mcpToolsCol.scan({})).map(e => e.doc).filter(t => t.active)

        const splitCamel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        const docs: CapabilityDoc[] = mcpTools.map(tool => ({
            type: "mcp" as const,
            rawId: tool.id,
            name: `${tool.tool_name} ${splitCamel(tool.tool_name)}`,
            body: tool.description || tool.tool_name,
            tags: tool.category ?? "",
            extraFilters: [{ field: "server_id", value: tool.server_id }],
        }))

        await replaceCapabilityDocs("mcp", docs)

        log.info(`[mcp:tool-sync] Synced ${mcpTools.length} MCP tools to HiveDB index`)
    } catch (err) {
        log.error(`[mcp:tool-sync] Failed to sync MCP tools to HiveDB index:`, err)
    }
}

/**
 * Delete all MCP tool definitions for a server from both the collection and
 * the HiveDB capability index.
 */
export async function clearMCPToolsFromDB(serverId: string): Promise<void> {
    try {
        const mcpToolsCol = await getMcpToolsCollection()
        const existing = await mcpToolsCol.findBy("server_id", serverId)
        for (const e of existing) await mcpToolsCol.delete(e.id)

        await deleteCapabilitiesByServer(serverId)

        log.info(`[mcp:tool-sync] Cleared MCP tools for server_id=${serverId}`)
    } catch (err) {
        log.error(`[mcp:tool-sync] Failed to clear MCP tools for server_id=${serverId}:`, err)
    }
}
