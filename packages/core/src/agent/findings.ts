/**
 * Findings: what a scout or planner reported about part of a project, kept so the next ask does not start over.
 *
 * Without this a worker's report lived only in the coordinator's context. When the coordinator ran out of budget
 * before reading two finished scouts, the retry delegated the same areas again and 45 % of the files were read twice.
 * A finding is saved the moment its worker delivers, and stays valid while the files it was based on are unchanged:
 * each file's hash is kept next to the report, and compared with the index when someone asks.
 */
import path from "node:path"
import { col, ensureIndexes, nextId } from "../storage/hive"
import type { CodeFindingDoc, CodeGraphDoc } from "../storage/collections"
import { codeFileId } from "./source-index"
import { isReaderAgent } from "./loadout"

/** Longest report kept: it is read back into other agents' contexts. */
const MAX_SUMMARY_CHARS = 12_000
/** A finding older than this is not reused without asking again, even if its files are unchanged. */
export const FINDING_TTL_MS = 24 * 3600 * 1000
/** Tools whose first path argument is a file the run looked at. */
const FILE_TOOLS = new Set(["fs_read", "outline", "parse_ast", "dependents", "tests_for"])

export const roleOf = (agentId: string): string => agentId.replace(/#\d+$/, "")

/** Paths a task names ("revisa packages/core/src/harness y …"), without trailing punctuation. */
export function areasNamedBy(text: string): string[] {
  return [...new Set((text.match(/(?:[\w.@-]+\/)+[\w.-]*/g) ?? []).map(t => t.replace(/[.,;:)]+$/, "").replace(/^\.\//, "").replace(/\/$/, "")))].filter(t => t.includes("/"))
}

const parse = <T,>(raw: string | null | undefined, fallback: T): T => { try { return JSON.parse(raw || "") as T } catch { return fallback } }

export interface FindingFreshness {
  fresh: boolean
  /** Files whose hash differs from the one the finding was based on. */
  changed: string[]
  /** Files that are no longer in the index. */
  missing: string[]
  /** The finding is older than `FINDING_TTL_MS`. */
  old: boolean
}

/** Hash of each file now, from the index, for the paths given (relative to the project root). */
async function currentHashes(projectId: string, paths: string[]): Promise<Map<string, string | undefined>> {
  const graph = await col<CodeGraphDoc>("codeGraph")
  const rows = await Promise.all(paths.map(file => graph.get(codeFileId(projectId, file))))
  return new Map(paths.map((file, i) => [file, rows[i]?.doc.content_hash]))
}

export async function freshnessOf(finding: CodeFindingDoc, now = Date.now()): Promise<FindingFreshness> {
  const files = parse<Record<string, string>>(finding.files_json, {})
  const current = await currentHashes(finding.project_id, Object.keys(files))
  const changed: string[] = []
  const missing: string[] = []
  for (const [file, hash] of Object.entries(files)) {
    const now_ = current.get(file)
    if (now_ === undefined) missing.push(file)
    else if (now_ !== hash) changed.push(file)
  }
  const old = now - finding.created_at > FINDING_TTL_MS
  return { fresh: !changed.length && !missing.length && !old && Object.keys(files).length > 0, changed, missing, old }
}

/** Relative paths of the files a run looked at, read from its tool calls. */
export async function filesReadBy(runId: string, workspace: string): Promise<string[]> {
  await ensureIndexes([["toolRuns", "run_id"]])
  const calls = (await (await col<{ tool_name: string; args_json: string }>("toolRuns")).findBy("run_id", runId)).map(e => e.doc)
  const files = new Set<string>()
  for (const call of calls) {
    if (!FILE_TOOLS.has(call.tool_name)) continue
    const args = parse<{ path?: unknown }>(call.args_json, {})
    if (typeof args.path !== "string" || !args.path) continue
    const rel = path.relative(workspace, path.resolve(workspace, args.path))
    if (rel && !rel.startsWith("..")) files.add(rel)
  }
  return [...files]
}

export interface SaveFindingInput {
  projectId: string
  sessionId: string
  agentId: string
  runId?: string
  workspace: string
  objective: string
  summary: string
  partial: boolean
}

/** Saves a reader's report. Returns null for anyone else's, for an empty report, or when nothing was based on indexed files. */
export async function saveFinding(input: SaveFindingInput): Promise<CodeFindingDoc | null> {
  if (!isReaderAgent(input.agentId) || !input.summary.trim()) return null
  const read = input.runId ? await filesReadBy(input.runId, input.workspace) : []
  const hashes = await currentHashes(input.projectId, read)
  const files = Object.fromEntries([...hashes].filter((entry): entry is [string, string] => !!entry[1]))
  const areas = areasNamedBy(input.objective)
  // Nothing to validate it against: it would be reused with no way to know it is out of date.
  if (!Object.keys(files).length) return null
  const id = await nextId("codeFindings")
  const doc: CodeFindingDoc = {
    id, project_id: input.projectId, role: roleOf(input.agentId), areas_json: JSON.stringify(areas), files_json: JSON.stringify(files),
    objective: input.objective.slice(0, 500), summary: input.summary.slice(0, MAX_SUMMARY_CHARS),
    status: input.partial ? "partial" : "completed", session_id: input.sessionId, created_at: Date.now(),
  }
  await (await col<CodeFindingDoc>("codeFindings")).put(id, doc, { expectedVersion: 0 })
  return doc
}

export async function findingsOf(projectId: string): Promise<CodeFindingDoc[]> {
  await ensureIndexes([["codeFindings", "project_id"]])
  return (await (await col<CodeFindingDoc>("codeFindings")).findBy("project_id", projectId)).map(e => e.doc).sort((a, b) => b.created_at - a.created_at)
}

/** Whether `area` (a directory or a file) is the same as, or inside, `covered`. */
const within = (area: string, covered: string) => area === covered || area.startsWith(`${covered}/`)

export interface FindingMatch { finding: CodeFindingDoc; freshness: FindingFreshness }

/**
 * Findings that speak to the areas a task names: a finding matches when one of its areas contains the named one
 * (or the reverse), or when it read a file under it. Newest first, freshness evaluated.
 */
export async function findingsFor(projectId: string, areas: string[], options: { role?: string; limit?: number } = {}): Promise<FindingMatch[]> {
  if (!areas.length) return []
  const matches: FindingMatch[] = []
  for (const finding of await findingsOf(projectId)) {
    if (options.role && finding.role !== options.role) continue
    const covered = parse<string[]>(finding.areas_json, [])
    const read = Object.keys(parse<Record<string, string>>(finding.files_json, {}))
    const speaks = areas.some(area => covered.some(c => within(area, c) || within(c, area)) || read.some(file => within(file, area)))
    if (speaks) matches.push({ finding, freshness: await freshnessOf(finding) })
    if (matches.length >= (options.limit ?? 3)) break
  }
  return matches
}

/**
 * A finding that can stand in for a new worker: same role, the task names areas and every one of them is covered by
 * the finding's own areas, it is complete, and its files are unchanged. Anything less and the worker should run.
 */
export async function reusableFinding(projectId: string, role: string, taskText: string): Promise<FindingMatch | null> {
  const wanted = areasNamedBy(taskText)
  if (!wanted.length) return null
  for (const match of await findingsFor(projectId, wanted, { role, limit: 5 })) {
    const covered = parse<string[]>(match.finding.areas_json, [])
    if (match.finding.status === "completed" && match.freshness.fresh && wanted.every(area => covered.some(c => within(area, c)))) return match
  }
  return null
}

/** Each scout report handed to a planner is clipped to this: enough for the file:line list, not the whole narrative. */
export const PLANNER_REPORT_CHARS = 4_000
/** Reports of the current session first (they answer this very task), then the project's most recent; at most four. */
export async function recentScoutFindings(projectId: string, sessionId: string, limit = 4): Promise<FindingMatch[]> {
  const scouts = (await findingsOf(projectId)).filter(finding => finding.role === "scout" && finding.status === "completed")
  scouts.sort((a, b) => Number(b.session_id === sessionId) - Number(a.session_id === sessionId) || b.created_at - a.created_at)
  return Promise.all(scouts.slice(0, limit).map(async finding => ({ finding, freshness: await freshnessOf(finding) })))
}

const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h` }

/** A short line per finding, for a context packet. `withSummary` adds the report itself, clipped. */
export function describeFindings(matches: FindingMatch[], options: { withSummary?: boolean; summaryChars?: number } = {}): string {
  return matches.map(({ finding, freshness }) => {
    const areas = parse<string[]>(finding.areas_json, []).join(", ") || "(sin áreas nombradas)"
    const state = freshness.fresh ? "vigente"
      : freshness.old ? "antiguo: confírmalo"
      : `desactualizado (cambiaron ${[...freshness.changed, ...freshness.missing].slice(0, 4).join(", ")}${freshness.changed.length + freshness.missing.length > 4 ? "…" : ""})`
    const head = `- [${finding.role} ${ago(finding.created_at)}, ${finding.status === "partial" ? "parcial, " : ""}${state}] ${areas}`
    return options.withSummary ? `${head}\n${finding.summary.slice(0, options.summaryChars ?? 1_200)}${finding.summary.length > (options.summaryChars ?? 1_200) ? "…" : ""}` : head
  }).join("\n")
}
