import type { MCPServerConfig } from "@johpaz/hivecode-mcp";
import type { McpServerDoc } from "../storage/collections";
import { decryptConfig } from "../storage/crypto";

export async function serverRuntimeConfig(server: McpServerDoc): Promise<MCPServerConfig> {
  return {
    transport: server.transport as MCPServerConfig["transport"],
    command: server.command ?? undefined,
    args: server.args ? JSON.parse(server.args) : [],
    url: server.url ?? undefined,
    enabled: server.enabled,
    env: server.env_encrypted && server.env_iv
      ? await decryptConfig(server.env_encrypted, server.env_iv) as Record<string, string> : undefined,
    headers: server.headers_encrypted && server.headers_iv
      ? await decryptConfig(server.headers_encrypted, server.headers_iv) as Record<string, string> : undefined,
  };
}

export async function findMcpServer(idOrName: string) {
  const servers = await (await import("../storage/hive")).col<McpServerDoc>("mcpServers");
  const byId = await servers.get(idOrName);
  if (byId) return byId;
  return (await servers.scan()).find(entry => entry.doc.name === idOrName);
}

export function publicMcpUrl(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}
