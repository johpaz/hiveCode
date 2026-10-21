/**
 * What the swarm can do, and which delegated calls may run at once.
 *
 * The roster feeds the TUI's swarm panel. The parallelism rule is structural: it needs no model, and
 * decides from the calls themselves (reads are always independent; delegations need distinct workers
 * and no two writers in the same workspace).
 */
import path from "node:path"
import { agentAlias, agentFunction, agentTierLevel } from "./agent-identity"
import { col } from "../storage/hive"
import type { AgentDoc, McpServerDoc } from "../storage/collections"
import { getSwarmRuntime } from "./swarm-runtime"
import { MAX_INSTANCES, parseInstanceId } from "./swarm-instances"

/** "activo": connected now; "disponible": enabled, connects on first use; "apagado": disabled. */
export type SwarmMcpState = "activo" | "disponible" | "apagado"

export interface SwarmMcpServer {
  id: string
  name: string
  state: SwarmMcpState
  tools: number
}

export interface SwarmSpecialist {
  id: string
  /** Rol interno: `backend`, `frontend`… Es lo que viaja por el bus. */
  rol: string
  /** Alias visible: `Topo`, `Quetzal`… Es lo que el usuario lee. */
  alias: string
  name: string
  description: string
  /** Una línea en español con qué hace este agente. */
  funcion: string
  /** Nivel jerárquico 0-5, el mismo que usa el grafo de la TUI. */
  nivel: 0 | 1 | 2 | 3 | 4 | 5
  tools: string[]
  mcp: Array<{ name: string; state: SwarmMcpState }>
}

/**
 * What the swarm can do right now: every enabled worker with its tools, and
 * every MCP server with its state. The TUI shows this roster, so it never lists a specialist whose MCP is off, nor a tool that is not connected.
 *
 * This stays the single source of the roster. `agent-identity.ts` only supplies
 * the alias/rol/función display data: a second roster reading a different
 * capability field would drift, and the TUI would show tools the agent lacks.
 */
export async function describeSwarmCapabilities(
  mcpManager: { getServerTools(key: string): unknown[] | undefined } | null,
  opts: { includeSpecialists: boolean; includeCoordinator?: boolean },
): Promise<{ mcpServers: SwarmMcpServer[]; specialists: SwarmSpecialist[] }> {
  const servers = (await (await col<McpServerDoc>("mcpServers")).scan({})).map(e => e.doc)
  const mcpServers: SwarmMcpServer[] = servers.map(server => {
    const tools = mcpManager?.getServerTools(server.id)?.length
      || mcpManager?.getServerTools(server.name)?.length || 0
    return {
      id: server.id,
      name: server.name,
      tools,
      state: !server.enabled ? "apagado" : tools > 0 ? "activo" : "disponible",
    }
  })
  if (!opts.includeSpecialists) return { mcpServers, specialists: [] }

  const byId = new Map(mcpServers.map(s => [s.id, s]))
  const parse = (json: string | null | undefined): string[] => {
    try { return json ? (JSON.parse(json) as unknown[]).map(String) : [] } catch { return [] }
  }
  const specialists = (await (await col<AgentDoc>("agents")).scan({}))
    .map(e => e.doc)
    .filter(a => (a.role === "worker" || (opts.includeCoordinator && a.id === "bee")) && !a.ephemeral && a.enabled && a.status !== "archived")
    .map(a => ({
      id: a.id,
      // `agent_type` es el rol canónico; sin él, el nombre es lo mejor que hay.
      rol: a.agent_type ?? a.name,
      alias: agentAlias(a.agent_type ?? a.name),
      name: a.name,
      description: (a.description ?? a.name).slice(0, 200),
      funcion: agentFunction(a.agent_type ?? a.name),
      nivel: agentTierLevel(a.agent_type ?? a.name),
      tools: parse(a.tools_json).filter(tool => a.tool_allowlist_json == null || parse(a.tool_allowlist_json).includes(tool)),
      mcp: parse(a.mcp_server_ids_json)
        .map(id => byId.get(id))
        .filter((s): s is SwarmMcpServer => !!s)
        .map(s => ({ name: s.name, state: s.state })),
    }))
  return { mcpServers, specialists }
}

/** Tools whose results do not depend on each other; safe to run concurrently. */
const READ_ONLY_TOOLS = /^(fs_read|fs_list|fs_glob|fs_exists|search_in_files|find_imports|parse_ast|git_status|git_diff|git_log|web_search|web_fetch|memory_read|memory_search|artifact_read|artifact_inspect|task_status|agent_find)$/

/** Read-only tools that look inside files: next to a write they may depend on what it changes. */
const FILE_CONTENT_READS = /^(fs_read|fs_list|fs_glob|search_in_files|find_imports|parse_ast|git_status|git_diff|git_log)$/

/** Tools that write one named file. */
const FILE_WRITE_TOOLS = /^(fs_write|fs_edit)$/

type ToolCallLike = { function: { name: string; arguments: unknown } }

/** Workers that may write the workspace: two of them at once would collide. */
function mayWrite(agent: AgentDoc | undefined): boolean {
  return agent?.permission_profile === "write_workspace" || agent?.permission_profile === undefined
}

/**
 * The part of the parallelism decision that needs no model. A batch of
 * delegations is safe when the workers are distinct and at most one of them can
 * write the workspace — or, if several can, when each has its own workspace.
 * Returns undefined when the batch is neither all reads nor all delegations
 * (mixed or mutating batches stay sequential).
 */
export async function structuralParallelism(calls: ToolCallLike[]): Promise<{ kind: "reads" | "writes" | "delegations"; safe: boolean } | undefined> {
  if (calls.length < 2) return undefined
  const names = calls.map(c => c.function.name)
  if (names.every(n => READ_ONLY_TOOLS.test(n))) return { kind: "reads", safe: true }
  // A worker's independent file edits: each call names a different file, and nothing in the batch reads one
  // of them. (Shell, builds and tests may touch anything, so they never join a batch of writes.)
  if (names.every(n => FILE_WRITE_TOOLS.test(n) || READ_ONLY_TOOLS.test(n)) && names.some(n => FILE_WRITE_TOOLS.test(n))) {
    const target = (call: ToolCallLike): string | undefined => {
      try {
        const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments
        const value = args?.path ?? args?.file_path
        return typeof value === "string" && value ? path.normalize(value) : undefined
      } catch { return undefined }
    }
    const written = calls.filter(c => FILE_WRITE_TOOLS.test(c.function.name)).map(target)
    const read = calls.filter(c => !FILE_WRITE_TOOLS.test(c.function.name))
    const safe = written.every(Boolean)
      && new Set(written).size === written.length
      // Web reads name no file of the batch; fs_read of a written file is a dependency, and a search,
      // listing, AST or git read may see the write, so those never share a batch with one.
      && read.every(c => !FILE_CONTENT_READS.test(c.function.name) || (c.function.name === "fs_read" && !written.includes(target(c))))
    return { kind: "writes", safe }
  }
  if (names.every(n => n === "spawn_agent")) {
    const safe = calls.every(call => {
      try { return (typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments)?.parallel !== false } catch { return false }
    })
    return { kind: "delegations", safe }
  }
  if (!names.every(n => n === "task_delegate")) return undefined

  const ids = calls.map(call => {
    try {
      const args = typeof call.function.arguments === "string"
        ? JSON.parse(call.function.arguments)
        : call.function.arguments
      return String(args?.worker_id ?? "")
    } catch { return "" }
  })
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) return { kind: "delegations", safe: false }
  const agentsCol = await col<AgentDoc>("agents")
  // `builder#2` is cloned from `builder` when it is delegated to, so it may not exist yet: judge it by
  // its base profile, and count it as a writer with a workspace of its own (it gets a private copy).
  const resolved = await Promise.all(ids.map(async id => {
    const { base, n } = parseInstanceId(id)
    const doc = (await agentsCol.get(id))?.doc ?? (n >= 2 && n <= MAX_INSTANCES ? (await agentsCol.get(base))?.doc : undefined)
    return doc ? { doc, own: n >= 2 && getSwarmRuntime() ? `instance:${id}` : doc.workspace } : undefined
  }))
  if (resolved.some(entry => !entry)) return { kind: "delegations", safe: false }
  const writers = resolved.filter(entry => mayWrite(entry!.doc))
  if (writers.length <= 1) return { kind: "delegations", safe: true }
  const workspaces = writers.map(entry => entry!.own)
  return { kind: "delegations", safe: workspaces.every(Boolean) && new Set(workspaces).size === workspaces.length }
}
