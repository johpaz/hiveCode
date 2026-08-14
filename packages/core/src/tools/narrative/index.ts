import type { Tool } from "../types.ts";
import { col } from "../../storage/hive.ts";
import { logger } from "../../utils/logger.ts";
import type {
  CodeDecisionDoc,
  CodeFileSnapshotDoc,
  CodeNarrativeDoc,
  CodeTaskDoc,
} from "../../storage/collections.ts";

const log = logger.child("narrative");

function nowIso(): string {
  return new Date().toISOString();
}

async function scanDocs<T>(collection: string): Promise<T[]> {
  return (await (await col<T>(collection)).scan()).map((entry) => entry.doc);
}

function mapEntry(r: CodeNarrativeDoc) {
  return {
    id: r.id,
    taskId: r.task_id,
    sessionId: r.session_id,
    coordinator: r.coordinator,
    phase: r.phase,
    entry: r.entry,
    isDraft: r.is_draft,
    isOverride: r.is_override,
    createdAt: r.created_at,
  };
}

function mapDecision(r: CodeDecisionDoc) {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    context: r.context,
    options: r.options,
    decision: r.decision,
    consequences: r.consequences,
    status: r.status,
    createdAt: r.created_at,
  };
}

export const readNarrativeTool: Tool = {
  name: "read_narrative",
  description: "Read narrative entries from HiveDB, optionally filtered by task or session. Returns the chronological story of what happened during coding sessions. Spanish keywords: leer narrativo, historial tarea, entradas narrativo, contexto tarea",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Filter by task ID (optional)" },
      sessionId: { type: "string", description: "Filter by session ID (optional)" },
      last: { type: "number", description: "Number of most recent entries to return (default: 50)" },
      coordinator: { type: "string", description: "Filter by coordinator name (optional)" },
    },
  },
  async execute(params) {
    const taskId = params.taskId as string | undefined;
    const sessionId = params.sessionId as string | undefined;
    const last = (params.last as number) ?? 50;
    const coordinator = params.coordinator as string | undefined;

    try {
      const entries = (await scanDocs<CodeNarrativeDoc>("codeNarrative"))
        .filter((entry) => !taskId || entry.task_id === taskId)
        .filter((entry) => !sessionId || entry.session_id === sessionId)
        .filter((entry) => !coordinator || entry.coordinator === coordinator)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, last)
        .reverse()
        .map(mapEntry);

      return { ok: true, result: { count: entries.length, entries } };
    } catch (error) {
      return { ok: false, error: `Failed to read narrative: ${(error as Error).message}` };
    }
  },
};

export const appendNarrativeTool: Tool = {
  name: "append_narrative",
  description: "Append a new narrative entry to the story log. Only the main thread should write; workers propose entries. Use to record what happened, decisions made, and reasoning. Spanish keywords: agregar narrativo, escribir entrada, registrar accion, documentar decision",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID this entry belongs to" },
      sessionId: { type: "string", description: "Session ID (optional, uses current session if available)" },
      coordinator: { type: "string", description: "Coordinator name that produced this entry" },
      phase: { type: "string", description: "Phase name (optional)" },
      entry: { type: "string", description: "Narrative content in Markdown" },
      isDraft: { type: "boolean", description: "Mark as draft (not yet reviewed)" },
    },
    required: ["taskId", "coordinator", "entry"],
  },
  async execute(params) {
    const taskId = params.taskId as string;
    const sessionId = params.sessionId as string | null;
    const coordinator = params.coordinator as string;
    const phase = params.phase as string | null;
    const entry = params.entry as string;
    const isDraft = params.isDraft === true;

    if (!taskId || !coordinator || !entry) {
      return { ok: false, error: "taskId, coordinator, and entry are required" };
    }

    try {
      const id = Bun.randomUUIDv7();
      await (await col<CodeNarrativeDoc>("codeNarrative")).put(id, {
        id,
        task_id: taskId,
        session_id: sessionId,
        coordinator,
        phase,
        entry,
        is_draft: isDraft,
        is_override: false,
        created_at: nowIso(),
      }, { expectedVersion: 0 });

      log.info(`[append_narrative] Entry ${id} by ${coordinator} for task ${taskId}`);
      return { ok: true, result: { id, message: "Narrative entry saved" } };
    } catch (error) {
      return { ok: false, error: `Failed to append narrative: ${(error as Error).message}` };
    }
  },
};

export const searchNarrativeTool: Tool = {
  name: "search_narrative",
  description: "Text search over narrative entries stored in HiveDB. Spanish keywords: buscar narrativo, buscar en historial, encontrar entrada",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Maximum results (default: 20)" },
    },
    required: ["query"],
  },
  async execute(params) {
    const query = params.query as string;
    const limit = (params.limit as number) ?? 20;

    if (!query) return { ok: false, error: "Search query is required" };

    try {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const entries = (await scanDocs<CodeNarrativeDoc>("codeNarrative"))
        .map((entry) => ({
          entry,
          score: terms.reduce((score, term) => {
            const haystack = `${entry.entry} ${entry.coordinator} ${entry.phase ?? ""}`.toLowerCase();
            return score + (haystack.includes(term) ? 1 : 0);
          }, 0),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.created_at.localeCompare(a.entry.created_at))
        .slice(0, limit);

      return {
        ok: true,
        result: {
          count: entries.length,
          query,
          entries: entries.map((item) => ({ ...mapEntry(item.entry), score: item.score })),
        },
      };
    } catch (error) {
      return { ok: false, error: `Search failed: ${(error as Error).message}` };
    }
  },
};

export const readDecisionsTool: Tool = {
  name: "read_decisions",
  description: "List Architecture Decision Records (ADRs). Filter by status (active, superseded, deprecated) or task ID. Spanish keywords: leer decisiones, adrs, decisiones arquitectura, ver adr, decision records",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "superseded", "deprecated"], description: "Filter by ADR status (optional)" },
      taskId: { type: "string", description: "Filter by task ID (optional)" },
    },
  },
  async execute(params) {
    const status = params.status as string | undefined;
    const taskId = params.taskId as string | undefined;

    try {
      const decisions = (await scanDocs<CodeDecisionDoc>("codeDecisions"))
        .filter((decision) => !status || decision.status === status)
        .filter((decision) => !taskId || decision.task_id === taskId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(mapDecision);

      return { ok: true, result: { count: decisions.length, decisions } };
    } catch (error) {
      return { ok: false, error: `Failed to read decisions: ${(error as Error).message}` };
    }
  },
};

export const writeDecisionTool: Tool = {
  name: "write_decision",
  description: "Save an Architecture Decision Record (ADR). Use to document important design decisions with context, options considered, and consequences. Spanish keywords: escribir decision, guardar adr, documentar decision arquitectura, registro decision",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "ADR title" },
      context: { type: "string", description: "Context and motivation for the decision" },
      options: { type: "string", description: "Options considered (Markdown list)" },
      decision: { type: "string", description: "The decision made and why" },
      consequences: { type: "string", description: "Consequences of this decision" },
      taskId: { type: "string", description: "Associated task ID (optional)" },
      status: { type: "string", enum: ["active", "superseded", "deprecated"], description: "ADR status (default: active)" },
    },
    required: ["title", "context", "options", "decision", "consequences"],
  },
  async execute(params) {
    const id = crypto.randomUUID();
    const title = params.title as string;
    const context = params.context as string;
    const options = params.options as string;
    const decision = params.decision as string;
    const consequences = params.consequences as string;
    const taskId = params.taskId as string | null;
    const status = (params.status as CodeDecisionDoc["status"]) ?? "active";

    if (!title || !context || !options || !decision || !consequences) {
      return { ok: false, error: "title, context, options, decision, and consequences are required" };
    }

    try {
      await (await col<CodeDecisionDoc>("codeDecisions")).put(id, {
        id,
        task_id: taskId,
        title,
        context,
        options,
        decision,
        consequences,
        status,
        created_at: nowIso(),
      }, { expectedVersion: 0 });

      log.info(`[write_decision] ADR saved: ${id} - ${title.slice(0, 60)}`);
      return { ok: true, result: { id, message: "ADR saved" } };
    } catch (error) {
      return { ok: false, error: `Failed to write decision: ${(error as Error).message}` };
    }
  },
};

export const getTaskContextTool: Tool = {
  name: "get_task_context",
  description: "Get the full context for a task: narrative entries, decisions, and file snapshots. Spanish keywords: contexto tarea, estado tarea, informacion tarea, resumen tarea",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID to get context for" },
    },
    required: ["taskId"],
  },
  async execute(params) {
    const taskId = params.taskId as string;
    if (!taskId) return { ok: false, error: "taskId is required" };

    try {
      const taskInfo = (await (await col<CodeTaskDoc>("codeTasks")).get(taskId))?.doc;
      const narrative = (await (await col<CodeNarrativeDoc>("codeNarrative")).findBy("task_id", taskId))
        .map((entry) => entry.doc)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(mapEntry);
      const decisions = (await (await col<CodeDecisionDoc>("codeDecisions")).findBy("task_id", taskId))
        .map((entry) => entry.doc)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(mapDecision);
      const snapshots = (await (await col<CodeFileSnapshotDoc>("codeFileSnapshots")).findBy("task_id", taskId))
        .map((entry) => entry.doc)
        .sort((a, b) => a.id.localeCompare(b.id));

      return {
        ok: true,
        result: {
          task: taskInfo ?? { id: taskId, description: "Unknown task" },
          narrative: { count: narrative.length, entries: narrative },
          decisions: { count: decisions.length, entries: decisions },
          snapshots: {
            count: snapshots.length,
            files: snapshots.map((s) => ({ filePath: s.file_path, hash: s.hash, snapshotAt: s.snapshot_at })),
          },
        },
      };
    } catch (error) {
      return { ok: false, error: `Failed to get task context: ${(error as Error).message}` };
    }
  },
};

export function createTools(): Tool[] {
  return [
    readNarrativeTool,
    appendNarrativeTool,
    searchNarrativeTool,
    readDecisionsTool,
    writeDecisionTool,
    getTaskContextTool,
  ];
}
