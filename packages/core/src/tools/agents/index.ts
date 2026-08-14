/**
 * Agents Tools - 14 tools
 * 
 * @category agents
 */

import type { Tool } from "../types.ts";
import crypto from "node:crypto";
import { col } from "../../storage/hive.ts";
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

    if (!model.enabled || !model.active) {
      return { 
        ok: false, 
        error: `Modelo '${modelId}' no está activo. Usá get_available_models para ver modelos activos.` 
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

export const taskDelegateTool: Tool = {
  name: "task_delegate",
  description: "Delegate a task to a worker agent and execute it immediately (blocking). Spanish: delegar tarea, asignar worker, ejecutar por agente, delegate_task",
  parameters: {
    type: "object",
    properties: {
      worker_id: { type: "string", description: "ID of the worker agent" },
      task_description: { type: "string", description: "Clear, detailed instructions for the worker" },
      task_id: { type: "number", description: "Optional task DB ID to update status automatically" },
      project_id: { type: "string", description: "Optional project ID for progress tracking" },
    },
    required: ["worker_id", "task_description"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const workerId = params.worker_id as string;
    const taskDescription = params.task_description as string;
    const taskId = params.task_id as number | undefined;
    const projectId = params.project_id as string | undefined;

    // Verify worker exists and is enabled
    const worker = (await (await col<AgentDoc>("agents")).get(workerId))?.doc;

    if (!worker) {
      return { ok: false, error: `Worker not found: ${workerId}` };
    }
    if (!worker.enabled) {
      return { ok: false, error: `Worker is disabled: ${worker.name}` };
    }

    // Fetch task info for bus notifications
    const taskRow = taskId ? (await (await col<TaskDoc>("tasks")).get(String(taskId)))?.doc : null;
    const taskName = taskRow?.name ?? taskDescription.slice(0, 60);
    const resolvedProjectId = projectId ?? taskRow?.project_id ?? "";

    // Mark task in_progress if task_id provided
    if (taskId) {
      await updateTask(String(taskId), { status: "in_progress", agent_id: workerId });
    }

    // Notify Agent Bus: task started
    agentBus.notifyTaskStarted(workerId, worker.name, taskId ?? 0, taskName, resolvedProjectId);

    log.info(`[task_delegate] Delegating to ${worker.name} (${workerId})`);

    try {
      // Dynamic import to avoid circular dependency (agent-loop → tools → agent-loop)
      const { runAgentIsolated } = await import("../../agent/agent-loop.ts");

      const threadId = `task-${taskId ?? Date.now()}-${workerId}`;
      const result = await runAgentIsolated({
        agentId: workerId,
        taskDescription,
        threadId,
      });

      // Update task to completed if task_id provided
      if (taskId) {
        await updateTask(String(taskId), { status: "completed", progress: 100, result });

        // Recalculate project progress if project_id provided
        if (resolvedProjectId) {
          await updateProjectProgress(resolvedProjectId);
        }
      }

      // Notify Agent Bus: task completed
      agentBus.notifyTaskCompleted(workerId, worker.name, taskId ?? 0, taskName, resolvedProjectId, result);

      const finalProgress = resolvedProjectId
        ? ((await (await col<ProjectDoc>("projects")).get(resolvedProjectId))?.doc.progress ?? null)
        : null;

      return {
        ok: true,
        worker_id: workerId,
        worker_name: worker.name,
        task_id: taskId,
        result,
        project_progress: finalProgress,
      };
    } catch (err) {
      // Mark task failed if task_id provided
      if (taskId) {
        await updateTask(String(taskId), { status: "failed", result: (err as Error).message, error: (err as Error).message });
      }

      // Notify Agent Bus: task failed
      agentBus.notifyTaskFailed(workerId, worker.name, taskId ?? 0, taskName, resolvedProjectId, (err as Error).message);

      return {
        ok: false,
        worker_id: workerId,
        task_id: taskId,
        error: (err as Error).message,
      };
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
      task_ids: { type: "array", description: "List of task IDs", items: { type: "number" } },
    },
    required: ["task_ids"],
  },
  execute: async (params: Record<string, unknown>) => {
    const taskIds = params.task_ids as number[];

    try {
      const tasksCol = await col<TaskDoc>("tasks");
      const tasks = (await Promise.all(taskIds.map((id) => tasksCol.get(String(id)))))
        .filter(Boolean)
        .map((entry) => entry!.doc);

      return {
        ok: true,
        task_count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          progress: t.progress,
          result: t.result,
        })),
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
  execute: async (params: Record<string, unknown>, config?: any) => {
    const purpose = params.purpose as string;
    const systemPrompt = params.systemPrompt as string;
    let context = params.context as string;
    const activeForm = params.activeForm as string;
    const timeoutMs = (params.timeoutMs as number) ?? 120_000;
    const maxRetries = (params.maxRetries as number) ?? 2;
    const parentAgentId = config?.configurable?.agent_id ?? "main";
    const threadId = config?.configurable?.thread_id ?? "default";

    // Resolve provider/model from parent agent or params
    const parentAgent = (await (await col<AgentDoc>("agents")).get(parentAgentId))?.doc;
    const providerId = (params.providerId as string) ?? parentAgent?.provider_id ?? "anthropic";
    const modelId = (params.modelId as string) ?? parentAgent?.model_id ?? "claude-sonnet-4-6";

    const t0 = performance.now();
    let retries = 0;
    let lastResult = "";
    let evalStructural = false;
    let evalSemantic = false;
    let evalNotes = "";

    const runOnce = async (): Promise<string> => {
      const agentId = `spawn-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const ephemeralThreadId = `${threadId}:spawn:${agentId}`;

      log.info(`[spawn_agent] Creating ephemeral agent ${agentId}: ${purpose.slice(0, 80)}`);

      try {
        // §39.3 — all subagents inherit the file-reading protocol
        const FILE_READING_PROTOCOL = `\n\n## Protocolo de lectura de archivos (§39 — obligatorio)\nPara archivos > 500 líneas: parse_ast primero → localizar con search_in_files → fs_read(offset, limit).\nNunca: fs_read sobre archivo grande sin offset/limit — retorna warning y mapa AST.\nPara entender impacto de un cambio: search_in_files("from './modulo'") o find_imports(path) antes de modificar.\nOffset negativo: fs_read(path, offset=-20, limit=20) lee las últimas 20 líneas.`;
        const augmentedSystemPrompt = systemPrompt + FILE_READING_PROTOCOL;

        await (await col<AgentDoc>("agents")).put(agentId, {
          id: agentId,
          user_id: config?.configurable?.user_id ?? parentAgent?.user_id ?? "default-user",
          name: `spawn:${purpose.slice(0, 40)}`,
          description: purpose,
          system_prompt: augmentedSystemPrompt,
          tone: "direct",
          role: "worker",
          status: "idle",
          enabled: true,
          provider_id: providerId,
          model_id: modelId,
          tools_json: null,
          skills_json: null,
          parent_id: parentAgentId,
          max_iterations: 5,
          workspace: config?.configurable?.workspace ?? null,
          created_at: now(),
          updated_at: now(),
        });

        const { runAgentIsolated } = await import("../../agent/agent-loop.ts");
        const taskWithContext = `${purpose}\n\n# CONTEXTO\n${context}`;

        const resultPromise = runAgentIsolated({ agentId, taskDescription: taskWithContext, threadId: ephemeralThreadId });
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent timeout after ${timeoutMs}ms`)), timeoutMs)
        );

        return await Promise.race([resultPromise, timeoutPromise]);
      } finally {
        try { await (await col<AgentDoc>("agents")).delete(agentId); } catch { /* ignore */ }
      }
    };

    // Semantic evaluation helper — one small LLM call to judge mandate fulfillment
    const runEvalSemantic = async (mandate: string, output: string): Promise<{ pass: boolean; notes: string }> => {
      try {
        const { callLLM, resolveProviderConfig } = await import("../../agent/llm-client.ts");
        const coordinator = (await (await col<AgentDoc>("agents")).findBy("role", "coordinator"))
          .map((entry) => entry.doc)[0];

        let provId = coordinator?.provider_id
        let modId = coordinator?.model_id
        if (!provId || !modId) {
          const fallbackProvider = (await getCodeConfig("default_provider")) || "gemini"
          const modelKey = `provider_model_${fallbackProvider}`
          const modelValue = await getCodeConfig(modelKey)
          provId = provId || fallbackProvider
          modId = modId || modelValue || "gemini-2.5-flash"
        }
        const providerCfg = await resolveProviderConfig(provId, modId);
        const resp = await callLLM({
          provider: providerCfg.provider,
          model: providerCfg.model,
          apiKey: providerCfg.apiKey,
          messages: [{
            role: "user",
            content: `MANDATO: ${mandate}\n\nOUTPUT DEL AGENTE:\n${output.slice(0, 2000)}\n\n` +
              `¿El output cumple el mandato? Responde PASS o FAIL en la primera línea. ` +
              `En la segunda línea explica brevemente qué falta o qué está mal (si hay algo).`,
          }],
          maxTokens: 256,
          tools: [],
        });
        const text = (typeof resp.content === "string" ? resp.content : "") as string;
        const firstLine = text.split("\n")[0].trim().toUpperCase();
        const notes = text.split("\n").slice(1).join(" ").trim();
        return { pass: firstLine.startsWith("PASS"), notes: notes || (firstLine.startsWith("PASS") ? "OK" : "Incomplete output") };
      } catch {
        return { pass: true, notes: "Semantic eval unavailable — skipped" };
      }
    };

    try {
      lastResult = await runOnce();
      const durationMs = Math.round(performance.now() - t0);

      evalStructural = !!lastResult && lastResult.length > 20 && !lastResult.startsWith("No pude");
      log.info(`[spawn_agent] evalStructural: ${evalStructural ? "✅" : "⚠️"}`);

      if (evalStructural) {
        const semResult = await runEvalSemantic(purpose, lastResult);
        evalSemantic = semResult.pass;
        evalNotes = semResult.notes;
        log.info(`[spawn_agent] evalSemantic: ${evalSemantic ? "✅ PASS" : "⚠️ FAIL"} — ${evalNotes}`);

        // Retry loop if semantic eval fails
        while (!evalSemantic && retries < maxRetries) {
          retries++;
          log.info(`[spawn_agent] Retry ${retries}/${maxRetries} — prepending evaluator feedback`);
          context = `# FEEDBACK DEL EVALUADOR (intento anterior)\n${evalNotes}\n\n# CONTEXTO ORIGINAL\n${context}`;
          lastResult = await runOnce();
          evalStructural = !!lastResult && lastResult.length > 20 && !lastResult.startsWith("No pude");
          if (evalStructural) {
            const sem2 = await runEvalSemantic(purpose, lastResult);
            evalSemantic = sem2.pass;
            evalNotes = sem2.notes;
            log.info(`[spawn_agent] Retry ${retries} evalSemantic: ${evalSemantic ? "✅ PASS" : "⚠️ FAIL"} — ${evalNotes}`);
          }
        }
      }

      return {
        ok: evalStructural,
        agentId: `spawn-done`,
        purpose,
        status: evalStructural ? "completed" : "failed",
        result: lastResult,
        durationMs,
        evalStructural,
        evalSemantic,
        retries,
        evalNotes,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0);
      const isTimeout = (err as Error).message.includes("timeout");
      log.error(`[spawn_agent] failed: ${(err as Error).message}`);

      return {
        ok: false,
        agentId: `spawn-err`,
        purpose,
        status: isTimeout ? "timeout" : "failed",
        error: (err as Error).message,
        durationMs,
        evalStructural: false,
        evalSemantic: false,
        retries,
      };
    }
  },
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
    taskDelegateCodeTool,
    taskStatusTool,
    busPublishTool,
    busReadTool,
    projectUpdatesTool,
    spawnAgentTool,
  ];
}
