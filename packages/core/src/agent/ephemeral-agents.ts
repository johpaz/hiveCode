import crypto from "node:crypto"
import { trackCollaboration } from "./collaboration-telemetry"
import { col } from "../storage/hive"
import type { AgentDoc, TaskDoc } from "../storage/collections"
import { buildWorkerBrief, parseAcceptance, checkAcceptance, summarizeAcceptance } from "./delegation"
import { resolveProjectScope, scopeFromConfig, resolveContextReferences, type ContextReference } from "./project-context"
import { selectSpecialty, REQUIRED_PROFILE_SKILLS } from "./specialties"
import { eventBus } from "../events/event-bus"
import { agentBus } from "../events/agent-bus"

const NEVER_INHERIT = new Set(["spawn_agent", "task_delegate", "task_revise", "agent_create", "agent_archive"])
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string") { try { return stringList(JSON.parse(value)) } catch { return [] } }
  return []
}
export function childCapabilities(parent: AgentDoc, params: Record<string, unknown>): { tools: string[]; skills: string[] } {
  const declared = stringList(parent.tools_json)
  const boundary = parent.tool_allowlist_json == null ? declared : stringList(parent.tool_allowlist_json)
  const allowedTools = new Set(declared.filter(tool => boundary.includes(tool) && !NEVER_INHERIT.has(tool)))
  const specialty = selectSpecialty(parent.agent_type, String(params.purpose ?? ""), typeof params.specialty === "string" ? params.specialty : undefined)
  const allowedSkills = new Set([...stringList(parent.skills_json), ...(REQUIRED_PROFILE_SKILLS[parent.agent_type ?? ""] ?? []), ...(specialty?.skills ?? [])])
  const tools = params.tools === undefined ? [...allowedTools] : stringList(params.tools)
  const defaultSkills = parent.agent_type
    ? [...(REQUIRED_PROFILE_SKILLS[parent.agent_type] ?? []), ...(specialty?.skills ?? [])]
    : [...allowedSkills]
  const skills = params.skills === undefined ? [...new Set(defaultSkills)] : stringList(params.skills)
  for (const tool of tools) if (!allowedTools.has(tool)) throw new Error(`Subagent tool outside parent permissions: ${tool}`)
  for (const skill of skills) if (!allowedSkills.has(skill)) throw new Error(`Subagent skill outside parent permissions: ${skill}`)
  return { tools, skills }
}

/** A child is a durable task with a temporary executor, never a new permission grant. */
export async function runEphemeralAgent(params: Record<string, unknown>, config?: any,
  runner?: (opts: Parameters<typeof import("./agent-loop").runAgentIsolated>[0]) => Promise<string>): Promise<object> {
  const started = Date.now()
  const c = config?.configurable ?? {}
  const parentId = c.agent_id ?? "main"
  const agents = await col<AgentDoc>("agents")
  const parent = (await agents.get(parentId))?.doc
  if (!parent) return { ok: false, status: "failed", error: `Parent agent not found: ${parentId}` }
  const maxDepth = 1
  if ((parent.spawn_depth ?? 0) >= maxDepth) return { ok: false, status: "failed", error: "Subagent generation limit reached" }
  let caps: ReturnType<typeof childCapabilities>
  try { caps = childCapabilities(parent, params) } catch (error) { return { ok: false, status: "failed", error: (error as Error).message } }
  const purpose = String(params.purpose ?? "")
  if (!purpose.trim()) return { ok: false, status: "failed", error: "A bounded purpose is required" }
  if (String(params.context ?? "").length > 8000) return {ok: false, status: "failed", error: "Context too large: pass targeted context_refs instead of copying the conversation"}
  const paths = stringList(params.paths)
  const refs = Array.isArray(params.context_refs) ? params.context_refs as ContextReference[] : []
  let scope
  try {
    scope = await resolveProjectScope(scopeFromConfig(params, { configurable: {...c, workspace: c.workspace ?? parent.workspace} }))
    if (refs.length) {
      if (!scope) throw new Error("Context references require an explicit project session")
      await resolveContextReferences(scope, refs)
    }
  } catch (error) { return { ok: false, status: "failed", error: (error as Error).message } }
  const id = `spawn-${crypto.randomUUID().slice(0, 12)}`
  const taskId = `subtask:${id}`
  const tasks = await col<TaskDoc>("tasks")
  const acceptance = parseAcceptance(params.acceptance, purpose)
  const metadata = { execution_thread_id: `${c.thread_id ?? "default"}:${taskId}`, parent_agent_id: parentId, parent_run_id: c.run_id, code_session_id: scope?.sessionId,
    code_task_id: scope?.taskId, specialty: params.specialty, paths, context_refs: refs, acceptance }
  await tasks.put(taskId, { id: taskId, project_id: scope?.sessionId ?? "", agent_id: id, parent_task_id: c.code_task_id ?? c.thread_id ?? "",
    name: purpose.slice(0, 80), description: purpose, status: "in_progress", progress: 0, priority: 0, depends_on: null,
    result: null, error: null, metadata: JSON.stringify(metadata), created_at: started, updated_at: started, completed_at: null })
  const timeout = Math.max(100, Math.min(600_000, Number(params.timeoutMs) || 120_000))
  const timer = new AbortController()
  const timerId = setTimeout(() => timer.abort(new Error(`Agent timeout after ${timeout}ms`)), timeout)
  const signal = config?.signal ? AbortSignal.any([config.signal, timer.signal]) : timer.signal
  const update = async (patch: Partial<TaskDoc>) => {
    const row = await tasks.get(taskId)
    if (row) await tasks.put(taskId, {...row.doc, ...patch, updated_at: Date.now()}, {expectedVersion: row.version})
  }
  let finishCollaboration: ((ok: boolean, summary?: string) => void) | undefined
  const name = `Hormiga · ${String(params.specialty ?? purpose).slice(0, 40)}`
  try {
    const specialty = selectSpecialty(parent.agent_type, purpose, typeof params.specialty === "string" ? params.specialty : undefined)
    await agents.put(id, {...parent, id, name, role: "worker", agent_type: undefined, ephemeral: true,
      spawn_depth: (parent.spawn_depth ?? 0) + 1, parent_id: parentId, status: "busy", enabled: true,
      system_prompt: `${String(params.systemPrompt ?? "")}\n${specialty?.instructions ?? ""}\nRevisa solo tu encargo. No crees otros agentes. Entrega evidencias y referencias; informa si falta contexto.`,
      user_instructions: parent.user_instructions ?? "", tools_json: JSON.stringify(caps.tools), tool_allowlist_json: JSON.stringify(caps.tools),
      skills_json: JSON.stringify(caps.skills), workspace: scope?.workspace ?? c.workspace ?? parent.workspace,
      provider_id: typeof params.providerId === "string" ? params.providerId : parent.provider_id,
      model_id: typeof params.modelId === "string" ? params.modelId : parent.model_id,
      max_iterations: Math.min(parent.max_iterations || 12, 24), created_at: started, updated_at: started })
    finishCollaboration = trackCollaboration({ from: parentId, to: id, taskId: scope?.taskId, sessionId: scope?.sessionId, summary: purpose })
    eventBus.emit("agent:lifecycle", {agentId: id, parentId, name, specialty: String(params.specialty ?? "especialista"), status: "running", activity: purpose, sessionId: scope?.sessionId, at: Date.now()})
    agentBus.notifyTaskStarted(id, name, 0, purpose.slice(0, 80), scope?.sessionId ?? "")
    const execute = runner ?? (await import("./agent-loop")).runAgentIsolated
    const result = await execute({ agentId: id,
      taskDescription: buildWorkerBrief(`${purpose}\n${String(params.context ?? "")}`, acceptance),
      threadId: `${c.thread_id ?? "default"}:${taskId}`, parentRunId: c.run_id, runKind: "worker",
      codeSessionId: scope?.sessionId, codeTaskId: scope?.taskId, workspace: scope?.workspace ?? parent.workspace,
      contextPaths: paths, contextRefs: refs, approvedExecution: c.approved_execution === true, signal })
    signal.throwIfAborted()
    const checks = await checkAcceptance(acceptance, result)
    const met = summarizeAcceptance(checks)
    const ok = Boolean(result.trim()) && met !== false
    await update({ status: ok ? "completed" : "blocked", progress: ok ? 100 : 80, result, completed_at: Date.now() })
    finishCollaboration?.(ok, result)
    eventBus.emit("agent:lifecycle", {agentId: id, parentId, name, specialty: String(params.specialty ?? "especialista"), status: ok ? "done" : "failed", activity: ok ? "Entrega guardada en HiveDB" : "Requiere revisión del responsable", sessionId: scope?.sessionId, at: Date.now()})
    agentBus.notifyTaskCompleted(id, name, 0, purpose.slice(0, 80), scope?.sessionId ?? "", result)
    return { ok, agentId: id, task_id: taskId, status: ok ? "completed" : "blocked", purpose,
      result: result.length > 2400 ? `${result.slice(0, 2400)}\n[Entrega completa: task_status(${taskId})]` : result,
      result_reference: { collection: "tasks", id: taskId }, acceptance: checks, acceptance_met: met,
      evalStructural: Boolean(result.trim()), evalSemantic: null, evalNotes: "El responsable debe revisar la evidencia", retries: 0, durationMs: Date.now() - started }
  } catch (error) {
    finishCollaboration?.(false, (error as Error).message)
    const status = timer.signal.aborted ? "timeout" : signal.aborted ? "cancelled" : "failed"
    await update({status: "failed", metadata: JSON.stringify({...metadata, outcome: status}), error: (error as Error).message, completed_at: Date.now()})
    eventBus.emit("agent:lifecycle", {agentId: id, parentId, name, specialty: String(params.specialty ?? "especialista"), status: "failed", activity: status, sessionId: scope?.sessionId, at: Date.now()})
    agentBus.notifyTaskFailed(id, name, 0, purpose.slice(0, 80), scope?.sessionId ?? "", (error as Error).message)
    return { ok: false, agentId: id, task_id: taskId, status, error: (error as Error).message, result_reference: {collection: "tasks", id: taskId}, durationMs: Date.now() - started }
  } finally {
    clearTimeout(timerId)
    await agents.delete(id)
  }
}
