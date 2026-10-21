import { trackCollaboration } from "../../agent/collaboration-telemetry";
import { getSwarmUsage } from "../../agent/swarm-usage";
import { runEphemeralAgent } from "../../agent/ephemeral-agents";
import { resolveProjectScope, scopeFromConfig, resolveContextReferences, type ContextReference } from "../../agent/project-context";
/**
 * Agents Tools - 14 tools
 * 
 * @category agents
 */

import type { Tool } from "../types.ts";
import crypto from "node:crypto";
import { col, ensureIndexes } from "../../storage/hive.ts";
import type {
  AgentBusMessageDoc,
  AgentDoc,
  AgentMemoryDoc,
  CodeConfigDoc,
  ModelDoc,
  ProjectDoc,
  ProviderDoc,
  ScratchpadDoc,
  TaskDoc,
} from "../../storage/collections.ts";
import { logger } from "../../utils/logger.ts";
import { agentBus } from "../../events/agent-bus.ts";
import { getAvailableModelsTool } from "./get-available-models.ts";

const log = logger.child("agents");

const MEMORY_THREAD_ID = "agent-memory";

function now(): number {
  return Date.now();
}

function memoryId(title: string): string {
  return `memory:${crypto.createHash("sha1").update(title).digest("hex")}`;
}

function iso(value: number | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

async function getCodeConfig(key: string): Promise<string | null> {
  return (await (await col<CodeConfigDoc>("codeConfig")).get(key))?.doc.value ?? null;
}

async function updateTask(taskId: string, patch: Partial<TaskDoc>): Promise<TaskDoc | null> {
  const tasks = await col<TaskDoc>("tasks");
  const entry = await tasks.get(taskId);
  if (!entry) return null;
  const updated = { ...entry.doc, ...patch, updated_at: now() };
  await tasks.put(taskId, updated, { expectedVersion: entry.version });
  return updated;
}

/** Revisions a coordinator may ask of one task before it has to decide: accept it or delegate it anew. */
export const MAX_REVISIONS = 2;

function taskMeta(task: TaskDoc): { acceptance_met?: boolean | null; revisions?: number } & Record<string, unknown> {
  try { return JSON.parse(task.metadata ?? "{}"); } catch { return {}; }
}

/** Records how a delegation ended inside the task's metadata, keeping what is already there. */
async function recordOutcome(taskId: string, patch: Record<string, unknown>): Promise<void> {
  const tasks = await col<TaskDoc>("tasks");
  const entry = await tasks.get(taskId);
  if (!entry) return;
  await tasks.put(taskId, { ...entry.doc, metadata: JSON.stringify({ ...taskMeta(entry.doc), ...patch }), updated_at: now() }, { expectedVersion: entry.version });
}

async function updateProjectProgress(projectId: string): Promise<number | null> {
  const tasks = await col<TaskDoc>("tasks");
  const projects = await col<ProjectDoc>("projects");
  const rows = (await tasks.findBy("project_id", projectId)).map((entry) => entry.doc);
  if (rows.length === 0) return null;
  const avg = Math.round(rows.reduce((sum, task) => sum + (task.progress ?? 0), 0) / rows.length);
  const project = await projects.get(projectId);
  if (project) {
    await projects.put(projectId, { ...project.doc, progress: avg, updated_at: now() }, { expectedVersion: project.version });
  }
  return avg;
}

// ─── memory_write ────────────────────────────────────────────────────────────

export const memoryWriteTool: Tool = {
  name: "memory_write",
  description: "Store information in persistent long-term memory. Spanish: guardar memoria, recordar, guardar dato, memoria persistente",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Descriptive title for this memory" },
      content: { type: "string", description: "Content to store" },
    },
    required: ["title", "content"],
  },
  execute: async (params: Record<string, unknown>) => {
    const title = params.title as string;
    const content = params.content as string;

    try {
      const scratchpad = await col<ScratchpadDoc>("scratchpad");
      const id = memoryId(title);
      const existing = await scratchpad.get(id);
      await scratchpad.put(
        id,
        {
          id,
          thread_id: MEMORY_THREAD_ID,
          key: title,
          value: content,
          source: "memory_write",
          created_at: existing?.doc.created_at ?? now(),
          updated_at: now(),
        },
        { expectedVersion: existing?.version ?? 0 },
      );

      return { ok: true, title, message: "Memory saved." };
    } catch (error) {
      return { ok: false, error: `Failed to save memory: ${(error as Error).message}` };
    }
  },
};

// ─── write_memory (Librarian: typed project memory) ──────────────────────────

const MEMORY_TYPES = ["pattern", "antipattern", "contract", "convention", "forensic_lesson"] as const;

/** Deprecation rule from docs/workers.md: a record refuted more than it is
 *  confirmed (with a margin of 2) is retired but never deleted. */
function isDeprecated(confirmedCount: number, refutedCount: number): boolean {
  return refutedCount > confirmedCount + 2;
}

function projectMemoryId(type: string, content: string): string {
  return `mem:${type}:${crypto.createHash("sha1").update(content).digest("hex")}`;
}

/**
 * The Librarian's dedicated distillation tool. Unlike the shared `memory_write`
 * (which stores free-form `{title, content}` notes in `scratchpad`), this writes
 * typed, project-scoped knowledge into `agentMemory` — the collection the
 * CoordinatorManager injects as "PROJECT MEMORY" into every future worker's
 * context. Re-distilling the same fact bumps `confirmed_count` instead of
 * duplicating it.
 */
export const writeMemoryTool: Tool = {
  name: "write_memory",
  description:
    "Persist one distilled, actionable fact into the project's long-term swarm memory (agentMemory). Librarian only. Spanish: destilar conocimiento, persistir aprendizaje del proyecto, memoria del enjambre",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: [...MEMORY_TYPES],
        description: "pattern | antipattern | contract | convention | forensic_lesson",
      },
      content: { type: "string", description: "One actionable fact, clear prose, no session jargon" },
      severity: { type: "string", description: "Impact of ignoring this in future sessions (e.g. low|medium|high)" },
      confidence: { type: "number", description: "0..1 confidence this fact holds; defaults to 0.5" },
      tags: { type: "string", description: "Optional comma-separated tags" },
    },
    required: ["type", "content"],
  },
  execute: async (params: Record<string, unknown>) => {
    const type = params.type as string;
    const content = params.content as string;
    const severity = (params.severity as string | undefined) ?? null;
    const confidence = typeof params.confidence === "number" ? params.confidence : 0.5;
    const tags = (params.tags as string | undefined) ?? null;

    if (!MEMORY_TYPES.includes(type as (typeof MEMORY_TYPES)[number])) {
      return { ok: false, error: `Invalid memory type '${type}'. Use one of: ${MEMORY_TYPES.join(", ")}` };
    }

    try {
      const memory = await col<AgentMemoryDoc>("agentMemory");
      const projectId = process.cwd();
      const id = projectMemoryId(type, content);
      const existing = await memory.get(id);

      const confirmedCount = (existing?.doc.confirmed_count ?? 0) + 1;
      const refutedCount = existing?.doc.refuted_count ?? 0;

      await memory.put(
        id,
        {
          id,
          project_id: projectId,
          session_id: existing?.doc.session_id ?? null,
          type,
          content,
          metadata: existing?.doc.metadata ?? null,
          tags,
          severity,
          confidence,
          confirmed_count: confirmedCount,
          refuted_count: refutedCount,
          deprecated: isDeprecated(confirmedCount, refutedCount),
          created_at: existing?.doc.created_at ?? now(),
          updated_at: now(),
        },
        { expectedVersion: existing?.version ?? 0 },
      );

      return { ok: true, type, confirmed_count: confirmedCount, message: "Project memory distilled." };
    } catch (error) {
      return { ok: false, error: `Failed to write project memory: ${(error as Error).message}` };
    }
  },
};

// ─── memory_read ─────────────────────────────────────────────────────────────

export const memoryReadTool: Tool = {
  name: "memory_read",
  description: "Retrieve a memory entry by identifier. Spanish: leer memoria, recuperar dato, obtener memoria",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title of the memory to retrieve" },
    },
    required: ["title"],
  },
  execute: async (params: Record<string, unknown>) => {
    const title = params.title as string;

    try {
      const note = await (await col<ScratchpadDoc>("scratchpad")).get(memoryId(title));

      if (!note) {
        return { ok: false, error: `Memory not found: ${title}` };
      }

      return {
        ok: true,
        title: note.doc.key,
        content: note.doc.value,
        createdAt: iso(note.doc.created_at),
        updatedAt: iso(note.doc.updated_at),
      };
    } catch (error) {
      return { ok: false, error: `Failed to read memory: ${(error as Error).message}` };
    }
  },
};

// ─── memory_list ─────────────────────────────────────────────────────────────

export const memoryListTool: Tool = {
  name: "memory_list",
  description: "List all saved memory entries. Spanish: listar memorias, ver memorias, todas las memorias",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    try {
      const notes = (await (await col<ScratchpadDoc>("scratchpad")).findBy("thread_id", MEMORY_THREAD_ID))
        .map((entry) => entry.doc)
        .sort((a, b) => b.updated_at - a.updated_at);

      return {
        ok: true,
        count: notes.length,
        entries: notes.map((n) => ({ title: n.key, createdAt: iso(n.created_at) })),
      };
    } catch (error) {
      return { ok: false, error: `Failed to list memories: ${(error as Error).message}` };
    }
  },
};

// ─── memory_search ───────────────────────────────────────────────────────────

export const memorySearchTool: Tool = {
  name: "memory_search",
  description: "Search memories by keyword. Spanish: buscar memoria, encontrar recuerdo, buscar dato guardado",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  execute: async (params: Record<string, unknown>) => {
    const query = params.query as string;

    try {
      const needle = query.toLowerCase();
      const notes = (await (await col<ScratchpadDoc>("scratchpad")).findBy("thread_id", MEMORY_THREAD_ID))
        .map((entry) => entry.doc)
        .filter((note) => note.key.toLowerCase().includes(needle) || note.value.toLowerCase().includes(needle));

      return {
        ok: true,
        query,
        count: notes.length,
        results: notes.map((n) => ({
          title: n.key,
          snippet: n.value.slice(0, 200) + (n.value.length > 200 ? "..." : ""),
        })),
      };
    } catch (error) {
      return { ok: false, error: `Failed to search memories: ${(error as Error).message}` };
    }
  },
};

// ─── memory_delete ───────────────────────────────────────────────────────────

export const memoryDeleteTool: Tool = {
  name: "memory_delete",
  description: "Delete a specific memory entry. Spanish: borrar memoria, eliminar recuerdo, quitar dato",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title of the memory to delete" },
    },
    required: ["title"],
  },
  execute: async (params: Record<string, unknown>) => {
    const title = params.title as string;

    try {
      const scratchpad = await col<ScratchpadDoc>("scratchpad");
      const id = memoryId(title);
      const existing = await scratchpad.get(id);

      if (!existing) {
        return { ok: false, error: `Memory not found: ${title}` };
      }
      await scratchpad.delete(id);

      return { ok: true, title, message: "Memory deleted." };
    } catch (error) {
      return { ok: false, error: `Failed to delete memory: ${(error as Error).message}` };
    }
  },
};

// ─── agent_create ────────────────────────────────────────────────────────────

export const agentCreateTool: Tool = {
  name: "agent_create",
  description: "Crear un nuevo agente worker especializado. Requiere consultar get_available_models primero para seleccionar provider/model óptimos. Sinónimos: crear agente, nuevo worker, nuevo trabajador",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nombre del agente" },
      description: { type: "string", description: "Descripción del rol del agente" },
      system_prompt: { type: "string", description: "System prompt para el agente" },
      tools_json: { type: "array", description: "Lista de IDs de herramientas", items: { type: "string" } },
      providerId: { type: "string", description: "ID del provider (hiveagents, openai, anthropic, etc.) - Obtener de get_available_models" },
      modelId: { type: "string", description: "ID del modelo (gpt-4o, claude-sonnet, etc.) - Obtener de get_available_models" },
      tone: { type: "string", description: "Tono del agente (friendly, professional, direct, etc.)" },
      max_iterations: { type: "number", description: "Límite de iteraciones del agente (default: 10)" },
    },
    required: ["name", "providerId", "modelId"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const userId = config?.configurable?.user_id;
    const parentId = config?.configurable?.agent_id ?? null;
    const name = params.name as string;
    const description = (params.description as string) ?? "";
    const systemPrompt = (params.system_prompt as string) ?? "";
    const toolsJson = params.tools_json ? JSON.stringify(params.tools_json) : null;
    const providerId = params.providerId as string;
    const modelId = params.modelId as string;
    const tone = (params.tone as string) ?? "friendly";
    const maxIterations = (params.max_iterations as number) ?? 10;
    const parentWorkspace = config?.configurable?.workspace ?? null;

    // Validar que providerId y modelId sean obligatorios
    if (!providerId || !modelId) {
      return { 
        ok: false, 
        error: "providerId y modelId son obligatorios. Usá get_available_models para consultar los modelos disponibles antes de crear el agente." 
      };
    }

    // Validar que el provider existe y está activo
    const provider = (await (await col<ProviderDoc>("providers")).get(providerId))?.doc;

    if (!provider) {
      return { 
        ok: false, 
        error: `Provider '${providerId}' no existe. Usá get_available_models para ver providers disponibles.` 
      };
    }

    if (!provider.enabled || !provider.active) {
      return { 
        ok: false, 
        error: `Provider '${providerId}' no está activo. Usá get_available_models para ver providers activos.` 
      };
    }

    // Validar que el modelo existe y está activo
    const model = (await (await col<ModelDoc>("models")).get(modelId))?.doc;

    if (!model) {
      return { 
        ok: false, 
        error: `Modelo '${modelId}' no existe. Usá get_available_models para ver modelos disponibles.` 
      };
    }

    if (!model.enabled || model.deprecated_at != null || model.catalog_missing_since_slot != null) {
      return { 
        ok: false, 
        error: `Modelo '${modelId}' no está disponible. Usá get_available_models para ver modelos disponibles.`
      };
    }

    try {
      const agentId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await (await col<AgentDoc>("agents")).put(agentId, {
        id: agentId,
        user_id: userId ?? "default-user",
        name,
        description,
        system_prompt: systemPrompt,
        tone,
        role: "worker",
        status: "idle",
        enabled: true,
        provider_id: providerId,
        model_id: modelId,
        tools_json: toolsJson,
        skills_json: null,
        parent_id: parentId ?? "root",
        max_iterations: maxIterations,
        workspace: parentWorkspace,
        created_at: now(),
        updated_at: now(),
      });

      return { 
        ok: true, 
        agentId, 
        name, 
        providerId, 
        modelId,
        workspace: parentWorkspace,
        message: "Agente creado exitosamente." 
      };
    } catch (error) {
      return { ok: false, error: `Failed to create agent: ${(error as Error).message}` };
    }
  },
};

// ─── agent_find ──────────────────────────────────────────────────────────────

export const agentFindTool: Tool = {
  name: "agent_find",
  description: "Find existing running or idle worker agents. Spanish: buscar agente, encontrar worker, localizar agente",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Search term for agent name or description" },
      status: { type: "string", enum: ["idle", "active", "any"], description: "Filter by status" },
    },
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const userId = config?.configurable?.user_id;
    const search = params.search as string | undefined;
    const status = params.status as string | undefined;

    try {
      const needle = search?.toLowerCase();
      const agents = (await (await col<AgentDoc>("agents")).findBy("user_id", userId ?? "default-user"))
        .map((entry) => entry.doc)
        .filter((agent) => agent.role === "worker")
        .filter((agent) => !needle || agent.name.toLowerCase().includes(needle) || (agent.description ?? "").toLowerCase().includes(needle))
        .filter((agent) => !status || status === "any" || agent.status === status);

      return {
        ok: true,
        count: agents.length,
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          role: a.role,
          status: a.status,
        })),
      };
    } catch (error) {
      return { ok: false, error: `Failed to find agents: ${(error as Error).message}` };
    }
  },
};

// ─── agent_archive ───────────────────────────────────────────────────────────

export const agentArchiveTool: Tool = {
  name: "agent_archive",
  description: "Archive or terminate a worker agent. Spanish: archivar agente, terminar worker, desactivar agente",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "ID of the agent to archive" },
    },
    required: ["agentId"],
  },
  execute: async (params: Record<string, unknown>) => {
    const agentId = params.agentId as string;

    try {
      const agents = await col<AgentDoc>("agents");
      const existing = await agents.get(agentId);

      if (!existing) {
        return { ok: false, error: `Agent not found: ${agentId}` };
      }
      await agents.put(
        agentId,
        { ...existing.doc, enabled: false, status: "archived", updated_at: now() },
        { expectedVersion: existing.version },
      );

      return { ok: true, agentId, message: "Agent archived." };
    } catch (error) {
      return { ok: false, error: `Failed to archive agent: ${(error as Error).message}` };
    }
  },
};

// ─── task_delegate ───────────────────────────────────────────────────────────

/**
 * Resolves what the coordinator calls a delegated task: the `task_id` that
 * task_delegate returned, or the `ref` it attached (a Spec Kit id such as T003).
 * Models mix the two up, so both are accepted; the newest match wins.
 */
async function findDelegatedTask(idOrRef: string): Promise<TaskDoc | null> {
  const tasks = await col<TaskDoc>("tasks");
  const direct = await tasks.get(idOrRef);
  if (direct) return direct.doc;
  const wanted = idOrRef.trim().toLowerCase();
  const matches: TaskDoc[] = [];
  for (const status of ["completed", "blocked", "failed", "in_progress", "pending"]) {
    for (const entry of await tasks.findBy("status", status)) {
      try {
        if (String(JSON.parse(entry.doc.metadata ?? "{}").ref ?? "").toLowerCase() === wanted) matches.push(entry.doc);
      } catch { /* legacy row without JSON metadata */ }
    }
  }
  return matches.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/** The ref (e.g. T003) a delegated task was given, if any. */
function meta_ref(task: TaskDoc): string | undefined {
  try { const ref = JSON.parse(task.metadata ?? "{}").ref; return typeof ref === "string" && ref ? ref : undefined; } catch { return undefined; }
}

/** A task that already finished in an earlier step (or run) settles a dependency without waiting. */
async function outcomeFromDb(idOrRef: string): Promise<import("../../agent/delegation-board.ts").BoardEntry | undefined> {
  const task = await findDelegatedTask(idOrRef).catch(() => null);
  if (!task || !["completed", "blocked", "failed"].includes(task.status)) return undefined;
  return { taskId: task.id, status: task.status as "completed" | "blocked" | "failed", result: String(task.result ?? "") };
}

async function failEarlyTask(taskId: string, workerId: string, workerName: string, taskName: string, projectId: string, error: string, ref?: string) {
  const { settleDelegation } = await import("../../agent/delegation-board.ts");
  await updateTask(taskId, { status: "failed", result: error, error });
  settleDelegation({ ref, taskId, status: "failed", result: error }, ref, taskId);
  agentBus.notifyTaskFailed(workerId, workerName, Number(taskId) || 0, taskName, projectId, error);
  return { ok: false, task_id: taskId, worker_id: workerId, error };
}

export const taskDelegateTool: Tool = {
  name: "task_delegate",
  description: "Delegate a bounded task to a worker agent and get its handoff plus evidence against acceptance criteria. Emit several task_delegate calls in ONE step to run distinct workers simultaneously (they run in parallel when their workspaces do not collide); you are the fan-in: judge the evidence, or send a task back with task_revise. Spanish: delegar tarea, asignar worker, ejecutar por agente, delegate_task",
  parameters: {
    type: "object",
    properties: {
      specialty: { type: "string", description: "Factory specialty owned by the selected worker" },
      session_id: { type: "string", description: "Explicit code session" },
      workspace: { type: "string", description: "Project workspace" },
      paths: { type: "array", items: { type: "string" }, description: "Files assigned to this task" },
      context_refs: { type: "array", items: { type: "object" }, description: "Versioned code ranges from get_project_context" },
      context: { type: "string", description: "Evidence you already hold that the worker needs (file paths with line ranges, symbols, findings from the index), up to 8000 characters. Saves the worker rediscovering it: it reads those lines instead of walking the repo." },
      worker_id: { type: "string", description: "ID of the worker agent (scout, builder, verifier, spider, planner, ...). To run the same profile twice at once use an instance: builder#2, builder#3 — each gets its own copy of the workspace and its work is merged back when it finishes." },
      after: { type: "array", items: { type: "string" }, description: "Refs or task_ids this task depends on (e.g. [\"T001\"]). The worker does not start until they finish, costs no tokens while waiting, and receives their handoffs. If one of them fails you get blocked_by back instead." },
      task_description: { type: "string", description: "Clear, detailed instructions for the worker" },
      acceptance: {
        type: "array",
        description: "Verifiable acceptance criteria. Defaults to 'the task is done as described'. A criterion with checkTool is decided deterministically (no LLM); the rest are judged by you from the evidence.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: { type: "string" },
            checkTool: { type: "string" },
          },
          required: ["id", "description"],
        },
      },
      ref: { type: "string", description: "Optional label of this task in your plan (e.g. the Spec Kit id T003). task_revise accepts it in place of the task_id." },
      task_id: { type: "string", description: "Optional existing task ID to update automatically" },
      project_id: { type: "string", description: "Optional project ID for progress tracking" },
    },
    required: ["worker_id", "task_description"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const workerId = params.worker_id as string;
    const taskDescription = params.task_description as string;
    const projectId = params.project_id as string | undefined;
    const ref = typeof params.ref === "string" && params.ref.trim() ? params.ref.trim() : undefined;
    // Announced before the first await: a sibling call of the same batch may already be waiting for this ref.
    const board = await import("../../agent/delegation-board.ts");
    board.announceDelegation(ref);
    const { buildWorkerBrief, checkAcceptance, delegationThreadId, parseAcceptance, summarizeAcceptance } =
      await import("../../agent/delegation.ts");
    const failEarly = (error: string, extra: Record<string, unknown> = {}) => {
      board.settleDelegation({ ref, status: "failed", result: error }, ref);
      return { ok: false, error, ...extra };
    };

    // Verify worker exists and is enabled; builder#2 is cloned from builder on first use.
    const { ensureInstance, parseInstanceId, canWriteWorkspace } = await import("../../agent/swarm-instances.ts");
    const worker = await ensureInstance(workerId);
    if (!worker) return failEarly(`Worker not found: ${workerId}`);
    if (!worker.enabled) return failEarly(`Worker is disabled: ${worker.name}`);

    const scope = await resolveProjectScope(scopeFromConfig(params, config));
    const refs = Array.isArray(params.context_refs) ? params.context_refs as ContextReference[] : [];
    const paths = Array.isArray(params.paths) ? params.paths.filter((p): p is string => typeof p === "string") : [];
    if (refs.length && !scope) return failEarly("References require an explicit project session");
    if (scope) await resolveContextReferences(scope, refs);

    const MAX_CONTEXT_CHARS = 8000;
    const context = typeof params.context === "string" ? params.context.trim() : "";
    if (context.length > MAX_CONTEXT_CHARS) return failEarly(`context is ${context.length} characters (max ${MAX_CONTEXT_CHARS}): pass paths with line ranges, not the text of the files.`);
    const contextBrief = context ? `\n\nContexto que ya tiene el coordinador (úsalo antes de explorar):\n${context}` : "";

    // Dependencies: park here (no run started, no slot held) until the tasks this one needs have finished.
    const after = Array.isArray(params.after) ? params.after.filter((a): a is string => typeof a === "string" && !!a.trim()) : [];
    let dependencyBrief = "";
    if (after.length) {
      const { emitWaiting } = await import("../../agent/tool-telemetry.ts");
      emitWaiting({ agentId: workerId, waitingFor: after, reason: "dependencia", taskId: scope?.taskId });
      const handoffs: string[] = [];
      for (const dep of after) {
        const found = board.delegationOutcome(dep) ?? await outcomeFromDb(dep);
        const settled: Awaited<ReturnType<typeof board.awaitDelegation>> = found
          ? { ok: true, entry: found }
          : await board.awaitDelegation(dep, { signal: config?.signal });
        if (settled.ok === false) {
          const why = settled.reason === "unknown" ? `${dep} was never delegated (delegate it first or in the same step)` : `${dep} did not finish in time`;
          return failEarly(`Dependency not met — ${why}`, { blocked_by: [dep], worker_id: workerId, ref });
        }
        if (settled.entry.status !== "completed") {
          return failEarly(`Dependency not met — ${dep} ${settled.entry.status}: ${settled.entry.result.slice(0, 300)}`, { blocked_by: [dep], worker_id: workerId, ref });
        }
        handoffs.push(`### ${dep}\n${settled.entry.result.slice(0, 3000)}`);
      }
      dependencyBrief = `\n\nEntregas de las tareas de las que depende esta (ya terminadas; construye sobre ellas):\n${handoffs.join("\n\n")}`;
    }
    const specialty = typeof params.specialty === "string" ? params.specialty : undefined;
    const contextMetadata = { code_session_id: scope?.sessionId, code_task_id: scope?.taskId, workspace: scope?.workspace, specialty, paths, context_refs: refs };
    const tasksCol = await col<TaskDoc>("tasks");
    const acceptance = parseAcceptance(params.acceptance, taskDescription);
    const taskName = taskDescription.slice(0, 60);

    // Every delegation is a TaskDoc, so task_status / task_revise can find it.
    let taskId = params.task_id !== undefined ? String(params.task_id) : "";
    const existing = taskId ? await tasksCol.get(taskId) : null;
    if (!existing) {
      const { nextId } = await import("../../storage/hive.ts");
      taskId = await nextId("tasks");
      await tasksCol.put(taskId, {
        id: taskId,
        project_id: projectId ?? "",
        agent_id: workerId,
        parent_task_id: "",
        name: taskName,
        description: taskDescription,
        status: "in_progress",
        progress: 0,
        priority: 0,
        depends_on: null,
        result: null,
        error: null,
        metadata: JSON.stringify({ worker_id: workerId, acceptance, ref, ...contextMetadata }),
        created_at: now(),
        updated_at: now(),
        completed_at: null,
      } satisfies TaskDoc, { expectedVersion: 0 });
    } else {
      await updateTask(taskId, { status: "in_progress", agent_id: workerId, metadata: JSON.stringify({ worker_id: workerId, acceptance, ref, ...contextMetadata }) });
    }
    const resolvedProjectId = projectId ?? existing?.doc.project_id ?? "";

    board.announceDelegation(ref, taskId);
    agentBus.notifyTaskStarted(workerId, worker.name, Number(taskId) || 0, taskName, resolvedProjectId);
    log.info(`[task_delegate] Delegating task ${taskId} to ${worker.name} (${workerId})`);

    // A parallel instance that writes does so in a private copy of the workspace, merged back when it finishes; a reader shares the task workspace.
    const swarm = parseInstanceId(workerId).n >= 2 && canWriteWorkspace(worker) ? (await import("../../agent/swarm-runtime.ts")).getSwarmRuntime() : null;
    const groupKey = scope?.taskId ?? scope?.sessionId ?? config?.configurable?.thread_id ?? "swarm";
    let runWorkspace = scope?.workspace;
    const baseWorkspace = scope?.workspace ?? (typeof config?.configurable?.workspace === "string" ? config.configurable.workspace : undefined);
    // Workers of one task run a few at a time; the rest wait here, before any worktree is made for them.
    const { acquireWorkerSlot } = await import("../../agent/worker-slots.ts");
    let releaseSlot: () => void;
    try {
      releaseSlot = await acquireWorkerSlot(groupKey, { readOnly: !canWriteWorkspace(worker), signal: config?.signal });
    } catch (err) {
      return failEarlyTask(taskId, workerId, worker.name, taskName, resolvedProjectId, `Cancelado mientras esperaba su turno: ${(err as Error).message}`, ref);
    }
    if (swarm && baseWorkspace) {
      try {
        runWorkspace = await swarm.prepare({ taskId: groupKey, instanceId: workerId, baseWorkspace });
      } catch (err) {
        releaseSlot();
        return failEarlyTask(taskId, workerId, worker.name, taskName, resolvedProjectId, `No pude preparar el workspace de ${workerId}: ${(err as Error).message}`, ref);
      }
    }

    const finishCollaboration = trackCollaboration({ from: config?.configurable?.agent_id ?? "bee", to: workerId,
      taskId: scope?.taskId, sessionId: scope?.sessionId, summary: taskDescription });
    let partial = false;
    try {
      // Dynamic import to avoid circular dependency (agent-loop → tools → agent-loop)
      const { runAgentIsolated } = await import("../../agent/agent-loop.ts");
      const result = await runAgentIsolated({
        agentId: workerId,
        taskDescription: buildWorkerBrief(taskDescription, acceptance) + contextBrief + dependencyBrief,
        codeSessionId: scope?.sessionId, codeTaskId: scope?.taskId, workspace: runWorkspace,
        specialty, contextRefs: refs, contextPaths: paths,
        threadId: delegationThreadId(taskId, workerId),
        parentRunId: config?.configurable?.run_id,
        runKind: "worker",
        approvedExecution: config?.configurable?.approved_execution === true,
        approvalChannel: config?.configurable?.approval_channel,
        signal: config?.signal,
        onRun: run => { partial = run.status !== "completed"; },
      });

      const checks = await checkAcceptance(acceptance, result);
      const met = summarizeAcceptance(checks);
      // Merge the instance's work into the task workspace now, while whoever wrote it still has context.
      const merge = swarm ? await swarm.integrate({ taskId: groupKey, instanceId: workerId }) : null;
      const merged = merge === null || merge.status === "integrated" || merge.status === "noop";
      const status = !merged || met === false ? "blocked" : "completed";
      await updateTask(taskId, {
        status,
        progress: status === "completed" ? 100 : 80,
        result,
        completed_at: now(),
      });
      await recordOutcome(taskId, { acceptance_met: met, revisions: taskMeta((await (await col<TaskDoc>("tasks")).get(taskId))!.doc).revisions ?? 0 });
      // A worker that stopped short (budget, stall) handed back a partial: whoever depends on it must not build on it.
      board.settleDelegation({ ref, taskId, status: partial && status === "completed" ? "blocked" : status, result }, ref, taskId);
      if (resolvedProjectId) await updateProjectProgress(resolvedProjectId);
      finishCollaboration(status === "completed" && !partial, result);
      agentBus.notifyTaskCompleted(workerId, worker.name, Number(taskId) || 0, taskName, resolvedProjectId, result);

      return {
        ok: true,
        task_id: taskId,
        ref,
        worker_id: workerId,
        worker_name: worker.name,
        result,
        acceptance: checks,
        // true: all confirmed deterministically · false: a check failed (task_revise it) · null: you judge from the evidence
        acceptance_met: met,
        ...(merge ? {
          merge: merge.status,
          merged_files: merge.files,
          ...(merged ? {} : { merge_error: merge.error?.slice(0, 600), hint: `${workerId}'s changes could NOT be merged into the shared workspace (${merge.status}). Send it back with task_revise to resolve the overlap on those files.` }),
        } : {}),
      };
    } catch (err) {
      finishCollaboration(false, (err as Error).message);
      await updateTask(taskId, { status: "failed", result: (err as Error).message, error: (err as Error).message });
      board.settleDelegation({ ref, taskId, status: "failed", result: (err as Error).message }, ref, taskId);
      agentBus.notifyTaskFailed(workerId, worker.name, Number(taskId) || 0, taskName, resolvedProjectId, (err as Error).message);
      return { ok: false, task_id: taskId, worker_id: workerId, error: (err as Error).message };
    } finally {
      releaseSlot();
    }
  },
};

// ─── wait_for ────────────────────────────────────────────────────────────────

export const waitForTool: Tool = {
  name: "wait_for",
  description: "Pause until another delegated task (its ref, e.g. T001, or its task_id) has finished, and get its handoff. Use it INSTEAD of polling with shell sleep loops: waiting here costs no tokens and shows as 'esperando' in the swarm. If the task failed you get that back, not a hang. Spanish: esperar tarea, esperar dependencia, esperar a que termine otro worker",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Ref or task_id of the task to wait for" },
      timeout_s: { type: "number", description: "Give up after this many seconds (default 1200)" },
    },
    required: ["ref"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const ref = String(params.ref ?? "").trim();
    if (!ref) return { ok: false, error: "Provide ref." };
    const board = await import("../../agent/delegation-board.ts");
    const { emitWaiting } = await import("../../agent/tool-telemetry.ts");
    const timeoutMs = Math.max(1, Number(params.timeout_s) || 1200) * 1000;
    const done = board.delegationOutcome(ref) ?? await outcomeFromDb(ref);
    if (done) return { ok: done.status === "completed", ref, status: done.status, handoff: done.result.slice(0, 6000) };
    emitWaiting({ agentId: String(config?.configurable?.agent_id ?? "worker"), waitingFor: [ref], reason: "dependencia", taskId: config?.configurable?.code_task_id ?? config?.configurable?.thread_id });
    const settled = await board.awaitDelegation(ref, { signal: config?.signal, timeoutMs });
    if (settled.ok === false) {
      return { ok: false, ref, status: settled.reason, error: settled.reason === "unknown" ? `${ref} has not been delegated (yet). Tell the coordinator, do not poll.` : `${ref} did not finish within ${Math.round(timeoutMs / 1000)}s.` };
    }
    return { ok: settled.entry.status === "completed", ref, status: settled.entry.status, handoff: settled.entry.result.slice(0, 6000) };
  },
};

// ─── task_revise ─────────────────────────────────────────────────────────────

export const taskReviseTool: Tool = {
  name: "task_revise",
  description: "Send a delegated task back to its worker with concrete feedback instead of reporting it as done. The worker resumes on the same thread with its previous handoff. Spanish: devolver tarea, pedir correcciones, revisar entrega",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The task_id from task_delegate's result (or the ref you gave it, e.g. T003)." },
      feedback: { type: "string", description: "Concrete, actionable feedback: what is wrong and what the worker still needs to do." },
      acceptance: {
        type: "array",
        description: "Updated acceptance criteria, if they need to change. Defaults to the original task's criteria.",
        items: {
          type: "object",
          properties: { id: { type: "string" }, description: { type: "string" }, checkTool: { type: "string" } },
          required: ["id", "description"],
        },
      },
    },
    required: ["task_id", "feedback"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const taskId = params.task_id as string | undefined;
    const feedback = params.feedback as string | undefined;
    if (!taskId) return { ok: false, error: "Provide task_id." };
    if (!feedback?.trim()) return { ok: false, error: "Provide feedback describing what is missing." };

    const task = await findDelegatedTask(String(taskId));
    if (!task) return { ok: false, error: `Task not found: ${taskId}. Use the task_id that task_delegate returned (e.g. "000000000000003") or the ref you gave it.` };
    const resolvedId = task.id;
    let meta: { worker_id?: string; acceptance?: unknown; code_session_id?: string; code_task_id?: string; workspace?: string; specialty?: string; paths?: string[] } = {};
    try { meta = JSON.parse(task.metadata ?? "{}"); } catch { /* legacy row without metadata */ }
    const workerId = meta.worker_id ?? task.agent_id;
    const worker = workerId ? (await (await col<AgentDoc>("agents")).get(workerId))?.doc : null;
    if (!worker?.enabled) return { ok: false, error: `Worker unavailable for task ${resolvedId}: ${workerId}` };

    const { buildWorkerBrief, checkAcceptance, delegationThreadId, parseAcceptance, summarizeAcceptance } =
      await import("../../agent/delegation.ts");
    const acceptance = parseAcceptance(params.acceptance ?? meta.acceptance, task.description ?? task.name);
    // Revising what a check already proved wastes a whole worker run, and revising forever never converges.
    const history = taskMeta(task);
    if (task.status === "completed" && history.acceptance_met === true && params.acceptance === undefined) {
      return {
        ok: false, task_id: resolvedId,
        error: "Esta tarea ya cumple sus criterios, comprobados de forma determinista: no hace falta revisarla.",
        hint: "Sigue con la siguiente tarea. Si necesitas algo que sus criterios no cubren, pásalo en `acceptance` (criterios nuevos).",
      };
    }
    const revisions = history.revisions ?? 0;
    if (revisions >= MAX_REVISIONS) {
      return {
        ok: false, task_id: resolvedId, revisions,
        error: `Esta tarea ya se revisó ${revisions} veces sin cerrarse.`,
        hint: "Decide: acepta la entrega con la salvedad, o delégala de nuevo con un brief distinto (task_delegate sin task_id).",
      };
    }
    await updateTask(resolvedId, { status: "in_progress", progress: 50 });
    const board = await import("../../agent/delegation-board.ts");
    board.announceDelegation(meta_ref(task), resolvedId);

    // A revised instance gets a fresh private copy of the (by now further along) shared workspace.
    const { parseInstanceId, canWriteWorkspace } = await import("../../agent/swarm-instances.ts");
    const swarm = parseInstanceId(worker.id).n >= 2 && canWriteWorkspace(worker) ? (await import("../../agent/swarm-runtime.ts")).getSwarmRuntime() : null;
    const baseWorkspace = config?.configurable?.workspace ?? meta.workspace;
    const groupKey = (config?.configurable?.code_task_id ?? meta.code_task_id ?? config?.configurable?.code_session_id ?? meta.code_session_id ?? "swarm") as string;
    let runWorkspace = baseWorkspace;
    if (swarm && baseWorkspace) {
      try { runWorkspace = await swarm.prepare({ taskId: groupKey, instanceId: worker.id, baseWorkspace }); }
      catch (err) {
        await updateTask(resolvedId, { status: "failed", error: (err as Error).message });
        return { ok: false, task_id: resolvedId, error: `No pude preparar el workspace de ${worker.id}: ${(err as Error).message}` };
      }
    }

    const finishCollaboration = trackCollaboration({ from: config?.configurable?.agent_id ?? "bee", to: worker.id,
      taskId: meta.code_task_id, sessionId: meta.code_session_id, summary: feedback });
    try {
      const { runAgentIsolated } = await import("../../agent/agent-loop.ts");
      const result = await runAgentIsolated({
        agentId: worker.id,
        taskDescription: buildWorkerBrief(
          [
            "Revisión de una tarea que ya entregaste.",
            `Tarea original:\n${task.description ?? task.name}`,
            `Tu entrega anterior:\n${(task.result ?? "").slice(0, 4000)}`,
            `Retroalimentación del coordinador:\n${feedback}`,
          ].join("\n\n"),
          acceptance,
        ),
        codeSessionId: config?.configurable?.code_session_id ?? meta.code_session_id,
        codeTaskId: config?.configurable?.code_task_id ?? meta.code_task_id,
        workspace: runWorkspace,
        specialty: meta.specialty, contextPaths: meta.paths,
        threadId: delegationThreadId(resolvedId, worker.id),
        parentRunId: config?.configurable?.run_id,
        runKind: "worker",
        approvedExecution: config?.configurable?.approved_execution === true,
        approvalChannel: config?.configurable?.approval_channel,
        signal: config?.signal,
      });
      const checks = await checkAcceptance(acceptance, result);
      const met = summarizeAcceptance(checks);
      const merge = swarm ? await swarm.integrate({ taskId: groupKey, instanceId: worker.id }) : null;
      const merged = merge === null || merge.status === "integrated" || merge.status === "noop";
      const status = !merged || met === false ? "blocked" : "completed";
      await updateTask(resolvedId, {
        status,
        progress: status === "completed" ? 100 : 80,
        result,
        completed_at: now(),
      });
      board.settleDelegation({ ref: meta_ref(task), taskId: resolvedId, status, result }, meta_ref(task), resolvedId);
      await recordOutcome(resolvedId, { acceptance_met: met, revisions: revisions + 1 });
      finishCollaboration(status === "completed", result);
      return {
        ok: true, task_id: resolvedId, worker_id: worker.id, result, acceptance: checks, acceptance_met: met,
        ...(merge ? { merge: merge.status, merged_files: merge.files, ...(merged ? {} : { merge_error: merge.error?.slice(0, 600) }) } : {}),
      };
    } catch (err) {
      finishCollaboration(false, (err as Error).message);
      await updateTask(resolvedId, { status: "failed", error: (err as Error).message });
      board.settleDelegation({ taskId: resolvedId, status: "failed", result: (err as Error).message }, meta_ref(task), resolvedId);
      return { ok: false, task_id: resolvedId, error: (err as Error).message };
    }
  },
};

// ─── task_delegate_code ──────────────────────────────────────────────────────

export const taskDelegateCodeTool: Tool = {
  name: "task_delegate_code",
  description: "Delegate a coding task to a CLI subagent (Qwen, Claude, etc.) via Code Bridge. Spanish: delegar código, subagente CLI, programación, Qwen",
  parameters: {
    type: "object",
    properties: {
      cli: { type: "string", enum: ["qwen", "claude", "opencode", "gemini"], description: "CLI tool to use" },
      task_instructions: { type: "string", description: "Coding task instructions" },
    },
    required: ["cli", "task_instructions"],
  },
  execute: async (params: Record<string, unknown>) => {
    const cli = params.cli as string;
    const taskInstructions = params.task_instructions as string;

    return {
      ok: true,
      cli,
      message: `Code task delegated to ${cli}: ${taskInstructions.substring(0, 100)}...`,
    };
  },
};

// ─── task_status ─────────────────────────────────────────────────────────────

export const taskStatusTool: Tool = {
  name: "task_status",
  description: "Get execution status of one or more delegated tasks. Spanish: estado tarea delegada, verificar progreso, consultar tarea",
  parameters: {
    type: "object",
    properties: {
      task_ids: { type: "array", description: "List of task IDs", items: {type: "string"} },
      full_result: {type: "boolean", description: "Read full durable evidence; default is a compact summary"},
    },
    required: ["task_ids"],
  },
  execute: async (params: Record<string, unknown>) => {
    const taskIds = params.task_ids as Array<string | number>;

    try {
      const tasksCol = await col<TaskDoc>("tasks");
      const tasks = (await Promise.all(taskIds.map((id) => tasksCol.get(String(id)))))
        .filter(Boolean)
        .map((entry) => entry!.doc);

      return {
        ok: true,
        task_count: tasks.length,
        tasks: await Promise.all(tasks.map(async (t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          progress: t.progress,
          result: params.full_result === true ? t.result : t.result?.slice(0, 2400),
          result_reference: {collection: "tasks", id: t.id},
          swarm_usage: await (async () => {
            const runs = await col<import("../../storage/collections").AgentRunDoc>("agentRuns");
            await ensureIndexes([["agentRuns", "task_id"], ["agentRuns", "thread_id"]]);
            const threadId = JSON.parse(t.metadata || "{}").execution_thread_id ?? `task-${t.id}-${t.agent_id}`;
            const matches = await Promise.all([runs.findBy("task_id", t.id), runs.findBy("thread_id", threadId)]);
            const taskRuns = [...new Map(matches.flat().map(row => [row.doc.id, row.doc])).values()];
            const roots = taskRuns.filter(run => !taskRuns.some(other => other.id === run.parent_run_id));
            return Promise.all(roots.map(run => getSwarmUsage(run.id)));
          })(),
        }))),
      };
    } catch (error) {
      return { ok: false, error: `Failed to get task status: ${(error as Error).message}` };
    }
  },
};

// ─── bus_publish ─────────────────────────────────────────────────────────────

export const busPublishTool: Tool = {
  name: "bus_publish",
  description: "Publish a message to the Agent Bus for worker-to-worker communication. Spanish: publicar mensaje, comunicar workers, enviar bus",
  parameters: {
    type: "object",
    properties: {
      event_type: { type: "string", description: "Type of event" },
      content: { type: "string", description: "Message content" },
      to_worker_id: { type: "string", description: "Target worker ID (optional)" },
    },
    required: ["event_type", "content"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const eventType = params.event_type as string;
    const content = params.content as string;
    const toWorkerId = (params.to_worker_id as string) ?? undefined;
    const fromWorkerId = config?.configurable?.agent_id ?? "unknown";

    try {
      const id = `bus_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      await (await col<AgentBusMessageDoc>("agentBusMessages")).put(id, {
        id,
        event_type: "message:custom",
        from_worker_id: fromWorkerId,
        to_worker_id: toWorkerId ?? "",
        topic: eventType,
        content,
        metadata: null,
        created_at: now(),
        read: false,
      });

      return { ok: true, message: "Message published." };
    } catch (error) {
      return { ok: false, error: `Failed to publish: ${(error as Error).message}` };
    }
  },
};

// ─── bus_read ────────────────────────────────────────────────────────────────

export const busReadTool: Tool = {
  name: "bus_read",
  description: "Read unread messages from the Agent Bus. Spanish: leer mensajes bus, recibir mensajes, verificar bus",
  parameters: {
    type: "object",
    properties: {
      worker_id: { type: "string", description: "Filter by target worker ID" },
      limit: { type: "number", description: "Maximum messages to return (default: 10)" },
    },
  },
  execute: async (params: Record<string, unknown>) => {
    const workerId = params.worker_id as string | undefined;
    const limit = (params.limit as number) ?? 10;

    try {
      const bus = await col<AgentBusMessageDoc>("agentBusMessages");
      const messageEntries = (await bus.scan())
        .filter((entry) => !entry.doc.read)
        .filter((entry) => !workerId || entry.doc.to_worker_id === workerId || entry.doc.to_worker_id === "")
        .sort((a, b) => a.doc.created_at - b.doc.created_at)
        .slice(0, limit);
      const messages = messageEntries.map((entry) => entry.doc);

      // Mark as read
      for (const entry of messageEntries) {
        await bus.put(entry.id, { ...entry.doc, read: true }, { expectedVersion: entry.version });
      }

      return {
        ok: true,
        count: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          event_type: m.event_type,
          content: m.content,
          from_worker_id: m.from_worker_id,
          created_at: iso(m.created_at),
        })),
      };
    } catch (error) {
      return { ok: false, error: `Failed to read messages: ${(error as Error).message}` };
    }
  },
};

// ─── project_updates ─────────────────────────────────────────────────────────

export const projectUpdatesTool: Tool = {
  name: "project_updates",
  description: "Get recent status updates from workers in the same project. Spanish: actualizaciones proyecto, estado workers, progreso equipo",
  parameters: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "Project ID to get updates from" },
      limit: { type: "number", description: "Maximum updates to return (default: 10)" },
    },
    required: ["project_id"],
  },
  execute: async (params: Record<string, unknown>) => {
    const projectId = params.project_id as string;
    const limit = (params.limit as number) ?? 10;

    try {
      const agents = await col<AgentDoc>("agents");
      const tasks = (await (await col<TaskDoc>("tasks")).findBy("project_id", projectId))
        .map((entry) => entry.doc)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      const updates = await Promise.all(tasks.map(async (t) => ({
        task_id: t.id,
        task_name: t.name,
        agent_name: (await agents.get(t.agent_id))?.doc.name ?? t.agent_id,
        status: t.status,
        progress: t.progress,
        result: t.result,
        updated_at: iso(t.updated_at),
      })));

      return {
        ok: true,
        project_id: projectId,
        count: tasks.length,
        updates,
      };
    } catch (error) {
      return { ok: false, error: `Failed to get updates: ${(error as Error).message}` };
    }
  },
};

// ─── spawn_agent ─────────────────────────────────────────────────────────────

export const spawnAgentTool: Tool = {
  name: "spawn_agent",
  description: "Crea un subagente dinámico efímero, lo ejecuta con su propio contexto, evalúa el resultado, y lo destruye. Úsalo para delegar subtareas específicas con propósito declarado. Spanish: crear subagente, agente dinámico, spawn, delegar subtarea",
  parameters: {
    type: "object",
    properties: {
      specialty: { type: "string", description: "A specialty owned by the parent agent" },
      session_id: { type: "string", description: "Explicit project session" },
      paths: { type: "array", items: { type: "string" }, description: "Assigned files" },
      tools: { type: "array", items: { type: "string" }, description: "Minimal subset of parent tools" },
      skills: { type: "array", items: { type: "string" }, description: "Minimal subset of parent skills" },
      context_refs: { type: "array", items: { type: "object" }, description: "Versioned code ranges from get_project_context" },
      acceptance: { type: "array", items: { type: "object" }, description: "Verifiable acceptance criteria" },
      purpose: { type: "string", description: "Qué debe hacer este agente (descripción específica)" },
      systemPrompt: { type: "string", description: "Identidad y reglas del agente" },
      context: { type: "string", description: "Contexto comprimido para este agente (archivos relevantes, estado actual)" },
      activeForm: { type: "string", description: "Mensaje en presente continuo de qué está haciendo: 'Implementando endpoint /auth/refresh...'" },
      parallel: { type: "boolean", description: "Si debe correr en paralelo (true) o esperar resultado antes de continuar (false)" },
      timeoutMs: { type: "number", description: "Timeout en ms (default: 120000)" },
      providerId: { type: "string", description: "Provider ID (default: hereda del coordinador)" },
      modelId: { type: "string", description: "Model ID (default: hereda del coordinador)" },
    },
    required: ["purpose", "systemPrompt", "context", "activeForm"],
  },
  execute: runEphemeralAgent,
};

export function createTools(): Tool[] {
  return [
    memoryWriteTool,
    writeMemoryTool,
    memoryReadTool,
    memoryListTool,
    memorySearchTool,
    memoryDeleteTool,
    getAvailableModelsTool,
    agentCreateTool,
    agentFindTool,
    agentArchiveTool,
    taskDelegateTool,
    taskReviseTool,
    waitForTool,
    taskDelegateCodeTool,
    taskStatusTool,
    busPublishTool,
    busReadTool,
    projectUpdatesTool,
    spawnAgentTool,
  ];
}
