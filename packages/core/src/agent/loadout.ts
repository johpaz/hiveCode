/**
 * Which tools a worker starts with, beyond what its profile allows.
 *
 * A profile lists everything a role MAY use; what it starts with decides what it reaches for. A scout
 * handed `fs_list` and `fs_glob` walks the tree (measured: 11 directory walks beside 7 index calls in
 * one exploration) even when the project index answers the same question for a fraction of the
 * tokens. When the index is populated, the readers start without the two tree-walking tools:
 * `get_project_context`, `search_knowledge`, `outline`, `find_symbol` and `search_in_files` remain, and
 * a tool left out is still one `search_knowledge` away, so nothing becomes unreachable.
 *
 * `HIVECODE_READER_DISK_WALK=1` gives them back.
 */
import { col, ensureIndexes } from "../storage/hive"
import type { CodeGraphDoc, SkillDoc } from "../storage/collections"
import { rankSkills, toSkillDescriptor, type SkillDescriptor } from "./skill-selector"
import { ALWAYS_TOOLS, COORDINATOR_BY_ROUTE, COORDINATOR_UNKNOWN_ROUTE, LOADOUT_CORE, SPECIALTY_TOOLS } from "./loadout-core"
import { MINIMAL_TOOLS, parseSkillTools } from "./minimal-loadout"
import { toolsTriggeredBy } from "./tool-metadata"

/** Profiles that explore and never edit. */
const READER_PROFILES = new Set(["scout", "planner"])
/** Whether an agent id (`scout`, `scout#2`, `spawn-…`) is a reader: it explores and never edits. */
export function isReaderAgent(agentId?: string | null): boolean {
  return !!agentId && READER_PROFILES.has(agentId.replace(/#\d+$/, ""))
}

/** Tools that list the tree; the index (`get_project_context`, `outline`) answers the same. */
export const DISK_WALK_TOOLS: readonly string[] = ["fs_list", "fs_glob"]
/** Below this many indexed files the index is not worth trusting over a directory listing. */
const MIN_INDEXED_FILES = 3
const READY_CACHE_MS = 60_000

const readyCache = new Map<string, { ready: boolean; at: number }>()

/** Whether the project has an index worth exploring through. Cached briefly: a run asks once per context compile. */
export async function isProjectIndexed(projectId: string, now = Date.now()): Promise<boolean> {
  const cached = readyCache.get(projectId)
  if (cached && now - cached.at < READY_CACHE_MS) return cached.ready
  let ready = false
  try {
    await ensureIndexes([["codeGraph", "project_id"]])
    ready = (await (await col<CodeGraphDoc>("codeGraph")).findBy("project_id", projectId)).length >= MIN_INDEXED_FILES
  } catch { /* no index yet: keep the listing tools */ }
  readyCache.set(projectId, { ready, at: now })
  return ready
}

export function resetIndexedCache(): void { readyCache.clear() }


// ─── The loadout the database composes ──────────────────────────────────────────────────────────────────

export interface LoadoutInput {
  /** The profile (`bee`, `scout`…); an instance counts as its base. */
  role: string
  /** What the role may use at all: its capability envelope. A loadout is always a subset of it. */
  envelope: ReadonlySet<string>
  specialtyId?: string
  specialtySkills?: string[]
  /** The harness route of the task (`conversation`/`scoped`/`feature`); undefined when there is none. */
  route?: string
  /** The task as the agent was given it. */
  taskText: string
  /** The project has an index worth reading through. */
  indexed: boolean
}

export interface ComputedLoadout {
  tools: Set<string>
  skills: SkillDescriptor[]
  /** Why each tool is there, for the trace and for tests. */
  reasons: Record<string, string>
  /** Envelope tools left out, by name: the model is told they exist and can bring them with `search_knowledge`. */
  manifest: string[]
  /** The harness route the loadout was computed for (unset when the task has none). */
  route?: string
}

/** Skills ranked from the database are kept only if most of the tools they teach can actually be called by this role. */
const MIN_USABLE_TOOLS = 0.5
/** Most skills the database adds on top of the role's own, and the tokens they may take together. */
const RANKED_SKILLS = 3
const RANKED_SKILL_TOKENS = 2_500

/**
 * What a role starts a run with. Four sources, none of which is a model turn:
 *  1. the role's core (loadout-core.ts);
 *  2. the route (the coordinator) and the specialty (workers);
 *  3. the tools whose triggers appear in the task (tool-metadata.ts, also indexed in the database);
 *  4. the skills the database ranks for the task, and the tools those skills teach.
 * Everything is intersected with the envelope, so this can narrow a role and never widen it.
 */
export async function computeLoadout(input: LoadoutInput): Promise<ComputedLoadout> {
  const core = LOADOUT_CORE[input.role]
  const tools = new Set<string>()
  const reasons: Record<string, string> = {}
  const add = (names: Iterable<string>, why: string) => {
    for (const name of names) if (input.envelope.has(name) && !tools.has(name)) { tools.add(name); reasons[name] = why }
  }

  add(ALWAYS_TOOLS, "siempre")
  add(MINIMAL_TOOLS, "mínimo")
  add(core?.tools ?? [], "núcleo del rol")
  if (input.role === "bee") add(COORDINATOR_BY_ROUTE[input.route ?? ""] ?? COORDINATOR_UNKNOWN_ROUTE, `ruta ${input.route ?? "desconocida"}`)
  if (input.specialtyId) add(SPECIALTY_TOOLS[input.specialtyId] ?? [], `especialidad ${input.specialtyId}`)
  // Without an index there is nothing to read through: a reader walks the tree.
  if (!input.indexed && isReaderAgent(input.role)) add(DISK_WALK_TOOLS, "sin índice")
  add(toolsTriggeredBy(input.taskText, [...input.envelope].filter(name => !tools.has(name))), "disparador en la tarea")

  const skills = await skillsFor(input)
  for (const skill of skills) add(parseSkillTools(skill.tools), `skill ${skill.name}`)

  const manifest = [...input.envelope].filter(name => !tools.has(name)).sort()
  return { tools, skills, reasons, manifest, route: input.route }
}

async function skillsFor(input: LoadoutInput): Promise<SkillDescriptor[]> {
  const table = await col<SkillDoc>("skills")
  // A specialty's skills are candidates, not a fixed load: the fallback specialty (`integration`) used to put `code_refactor`
  // (2.3K tokens) in front of every builder task. The ranking decides, from what the task says.
  const wanted = new Set(LOADOUT_CORE[input.role]?.skills ?? [])
  const own = (await table.scan({})).map(e => e.doc).filter(doc => doc.active && wanted.has(doc.name)).map(toSkillDescriptor)
  const taken = new Set(own.map(skill => skill.name))
  const usable = (skill: SkillDescriptor) => {
    const taught = parseSkillTools(skill.tools)
    return taught.length === 0 || taught.filter(name => input.envelope.has(name)).length / taught.length >= MIN_USABLE_TOOLS
  }
  const ranked = (await rankSkills(`${input.taskText} ${(input.specialtySkills ?? []).join(" ")}`, { role: input.role, limit: RANKED_SKILLS + taken.size, tokenBudget: RANKED_SKILL_TOKENS }))
    .filter(skill => !taken.has(skill.name) && usable(skill)).slice(0, RANKED_SKILLS)
  return [...own, ...ranked]
}
