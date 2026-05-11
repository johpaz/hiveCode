import type { Tool } from "../types.ts";
import { getDb } from "../../storage/sqlite.ts";
import { logger } from "../../utils/logger.ts";

const log = logger.child("narrative");

function mapEntry(r: any) {
  return {
    id: r.id,
    taskId: r.task_id,
    sessionId: r.session_id,
    coordinator: r.coordinator,
    phase: r.phase,
    entry: r.entry,
    isDraft: r.is_draft === 1,
    isOverride: r.is_override === 1,
    createdAt: r.created_at,
  };
}

function mapDecision(r: any) {
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

// ─── read_narrative ───────────────────────────────────────────────────────────

export const readNarrativeTool: Tool = {
  name: "read_narrative",
  description: "Read narrative entries from SQLite, optionally filtered by task or session. Returns the chronological story of what happened during coding sessions. Spanish keywords: leer narrativo, historial tarea, entradas narrativo, contexto tarea",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Filter by task ID (optional)",
      },
      sessionId: {
        type: "string",
        description: "Filter by session ID (optional)",
      },
      last: {
        type: "number",
        description: "Number of most recent entries to return (default: 50)",
      },
      coordinator: {
        type: "string",
        description: "Filter by coordinator name (optional)",
      },
    },
  },
  async execute(params) {
    const taskId = params.taskId as string | undefined;
    const sessionId = params.sessionId as string | undefined;
    const last = (params.last as number) ?? 50;
    const coordinator = params.coordinator as string | undefined;

    try {
      const db = getDb();
      let rows: any[];
      const conditions: string[] = [];
      const bindings: (string | number)[] = [];

      if (taskId) { conditions.push("task_id = ?"); bindings.push(taskId); }
      if (sessionId) { conditions.push("session_id = ?"); bindings.push(sessionId); }
      if (coordinator) { conditions.push("coordinator = ?"); bindings.push(coordinator); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      bindings.push(last);
      rows = db.query(`SELECT * FROM code_narrative ${where} ORDER BY id DESC LIMIT ?`).all(...bindings as [string | number, ...(string | number)[]]) as any[];
      const entries = rows.reverse().map(mapEntry);

      return { ok: true, result: { count: entries.length, entries } };
    } catch (error) {
      return { ok: false, error: `Failed to read narrative: ${(error as Error).message}` };
    }
  },
};

// ─── append_narrative ─────────────────────────────────────────────────────────

export const appendNarrativeTool: Tool = {
  name: "append_narrative",
  description: "Append a new narrative entry to the story log. Only the main thread should write; workers propose entries. Use to record what happened, decisions made, and reasoning. Spanish keywords: agregar narrativo, escribir entrada, registrar accion, documentar decision",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Task ID this entry belongs to",
      },
      sessionId: {
        type: "string",
        description: "Session ID (optional, uses current session if available)",
      },
      coordinator: {
        type: "string",
        description: "Coordinator name that produced this entry",
      },
      phase: {
        type: "string",
        description: "Phase name (optional)",
      },
      entry: {
        type: "string",
        description: "Narrative content in Markdown",
      },
      isDraft: {
        type: "boolean",
        description: "Mark as draft (not yet reviewed)",
      },
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
      const db = getDb();
      const result = db.query(`
        INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry, is_draft)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id
      `).get(taskId, sessionId, coordinator, phase, entry, isDraft ? 1 : 0) as { id: number };

      log.info(`[append_narrative] Entry #${result.id} by ${coordinator} for task ${taskId}`);
      return { ok: true, result: { id: result.id, message: "Narrative entry saved" } };
    } catch (error) {
      return { ok: false, error: `Failed to append narrative: ${(error as Error).message}` };
    }
  },
};

// ─── search_narrative ─────────────────────────────────────────────────────────

export const searchNarrativeTool: Tool = {
  name: "search_narrative",
  description: "Full-text search over all narrative entries using FTS5. Returns relevant entries with relevance scores. Spanish keywords: buscar narrativo, buscar en historial, fts5 narrativo, encontrar entrada",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (supports FTS5 syntax: AND, OR, quotes for exact phrase)",
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 20)",
      },
    },
    required: ["query"],
  },
  async execute(params) {
    const query = params.query as string;
    const limit = (params.limit as number) ?? 20;

    if (!query) return { ok: false, error: "Search query is required" };

    try {
      const db = getDb();
      const escaped = query.replace(/'/g, "''");
      const rows = db.query(`
        SELECT n.*, rank FROM code_narrative n
        JOIN code_narrative_fts fts ON n.id = fts.rowid
        WHERE code_narrative_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(escaped, limit) as any[];

      const entries = rows.map(mapEntry);

      return {
        ok: true,
        result: {
          count: entries.length,
          query,
          entries: entries.map((e: any, i: number) => ({ ...e, score: rows[i]?.rank ?? 0 })),
        },
      };
    } catch (error) {
      return { ok: false, error: `Search failed: ${(error as Error).message}` };
    }
  },
};

// ─── read_decisions ───────────────────────────────────────────────────────────

export const readDecisionsTool: Tool = {
  name: "read_decisions",
  description: "List Architecture Decision Records (ADRs). Filter by status (active, superseded, deprecated) or task ID. Spanish keywords: leer decisiones, adrs, decisiones arquitectura, ver adr, decision records",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "superseded", "deprecated"],
        description: "Filter by ADR status (optional)",
      },
      taskId: {
        type: "string",
        description: "Filter by task ID (optional)",
      },
    },
  },
  async execute(params) {
    const status = params.status as string | undefined;
    const taskId = params.taskId as string | undefined;

    try {
      const db = getDb();
      const conditions: string[] = [];
      const bindings: (string | number)[] = [];

      if (status) { conditions.push("status = ?"); bindings.push(status); }
      if (taskId) { conditions.push("task_id = ?"); bindings.push(taskId); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.query(`SELECT * FROM code_decisions ${where} ORDER BY created_at DESC`).all(...bindings as [string | number, ...(string | number)[]]) as any[];

      return { ok: true, result: { count: rows.length, decisions: rows.map(mapDecision) } };
    } catch (error) {
      return { ok: false, error: `Failed to read decisions: ${(error as Error).message}` };
    }
  },
};

// ─── write_decision ───────────────────────────────────────────────────────────

export const writeDecisionTool: Tool = {
  name: "write_decision",
  description: "Save an Architecture Decision Record (ADR). Use to document important design decisions with context, options considered, and consequences. Spanish keywords: escribir decision, guardar adr, documentar decision arquitectura, registro decision",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "ADR title (e.g., 'Use Bun.sqlite instead of PostgreSQL')",
      },
      context: {
        type: "string",
        description: "Context and motivation for the decision",
      },
      options: {
        type: "string",
        description: "Options considered (Markdown list)",
      },
      decision: {
        type: "string",
        description: "The decision made and why",
      },
      consequences: {
        type: "string",
        description: "Consequences of this decision (positive and negative)",
      },
      taskId: {
        type: "string",
        description: "Associated task ID (optional)",
      },
      status: {
        type: "string",
        enum: ["active", "superseded", "deprecated"],
        description: "ADR status (default: active)",
      },
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
    const status = (params.status as string) ?? "active";

    if (!title || !context || !options || !decision || !consequences) {
      return { ok: false, error: "title, context, options, decision, and consequences are required" };
    }

    try {
      const db = getDb();
      db.query(`
        INSERT INTO code_decisions (id, task_id, title, context, options, decision, consequences, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, taskId, title, context, options, decision, consequences, status);

      log.info(`[write_decision] ADR saved: ${id} — ${title.slice(0, 60)}`);
      return { ok: true, result: { id, message: "ADR saved" } };
    } catch (error) {
      return { ok: false, error: `Failed to write decision: ${(error as Error).message}` };
    }
  },
};

// ─── get_task_context ─────────────────────────────────────────────────────────

export const getTaskContextTool: Tool = {
  name: "get_task_context",
  description: "Get the full context for a task: narrative entries, decisions, and file snapshots. One-stop shop for loading everything needed to understand a task's state. Spanish keywords: contexto tarea, estado tarea, informacion tarea, resumen tarea",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Task ID to get context for",
      },
    },
    required: ["taskId"],
  },
  async execute(params) {
    const taskId = params.taskId as string;
    if (!taskId) return { ok: false, error: "taskId is required" };

    try {
      const db = getDb();

      const taskInfo = db.query(
        "SELECT id, session_id, description, status, mode, branch_name, pr_url, created_at, completed_at FROM code_tasks WHERE id = ?"
      ).get(taskId) as any;

      const narrativeRows = db.query(
        "SELECT * FROM code_narrative WHERE task_id = ? ORDER BY id"
      ).all(taskId) as any[];
      const narrative = narrativeRows.map(mapEntry);

      const decisionRows = db.query(
        "SELECT * FROM code_decisions WHERE task_id = ? ORDER BY created_at DESC"
      ).all(taskId) as any[];
      const decisions = decisionRows.map(mapDecision);

      const snapshotRows = db.query(
        "SELECT id, task_id, file_path, hash, snapshot_at FROM code_file_snapshots WHERE task_id = ? ORDER BY id"
      ).all(taskId) as any[];

      return {
        ok: true,
        result: {
          task: taskInfo ?? { id: taskId, description: "Unknown task" },
          narrative: { count: narrative.length, entries: narrative },
          decisions: { count: decisions.length, entries: decisions },
          snapshots: { count: snapshotRows.length, files: snapshotRows.map((s: any) => ({ filePath: s.file_path, hash: s.hash, snapshotAt: s.snapshot_at })) },
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
