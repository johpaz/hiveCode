/**
 * Core Tools - 4 tools
 *
 * @category core
 */

import type { Tool } from "../types.ts";
import { col } from "../../storage/hive.ts";
import type {
  CodeContextCacheDoc,
  CodeFileDoc,
  CodeSessionDoc,
  McpToolDoc,
  PlaybookDoc,
  ScratchpadDoc,
  SkillDoc,
  TaskDoc,
  ToolDoc,
} from "../../storage/collections.ts";
import { logger } from "../../utils/logger.ts";
import {
  searchCapabilities,
  type CapabilityHit,
  type CapabilityType,
} from "../../agent/capability-search.ts";
import { CORE_TOOL_CATALOG } from "../../agent/tool-selector.ts";

const log = logger.child("core");

async function getActiveCodeSessionId(): Promise<string> {
  const sessions = await col<CodeSessionDoc>("codeSessions");
  const active = (await sessions.findBy("status", "active"))
    .map((entry) => entry.doc)
    .sort((a, b) => b.last_active.localeCompare(a.last_active))[0];
  return active?.id ?? "";
}

// ─── Bilingual dictionary: Spanish → English ────────────────────────────────

const ES_EN_DICT: Record<string, string[]> = {
  // Acciones
  "buscar": ["search", "find", "list", "get", "query"],
  "listar": ["list", "get", "fetch", "retrieve"],
  "crear": ["create", "add", "insert", "new", "make"],
  "actualizar": ["update", "edit", "modify", "change"],
  "eliminar": ["delete", "remove", "destroy"],
  "obtener": ["get", "fetch", "retrieve", "read"],
  "enviar": ["send", "post", "submit", "push"],
  "leer": ["read", "get", "fetch"],
  "escribir": ["write", "create", "save"],
  "modificar": ["update", "modify", "edit", "change"],
  "ejecutar": ["execute", "run", "invoke"],
  "conectar": ["connect", "link"],
  "desconectar": ["disconnect", "remove"],
  "descargar": ["download", "export", "fetch"],
  "subir": ["upload", "import", "create"],
  "analizar": ["analyze", "review", "examine"],
  "generar": ["generate", "create", "produce"],
  "convertir": ["convert", "transform", "translate"],
  "validar": ["validate", "verify", "check"],
  "importar": ["import", "load", "ingest"],
  "exportar": ["export", "download", "extract"],
  "comprimir": ["compress", "zip", "archive"],
  "extraer": ["extract", "get", "retrieve", "parse"],
  "reemplazar": ["replace", "update", "swap"],
  "cargar": ["load", "import", "upload"],
  "guardar": ["save", "store", "create"],
  "consultar": ["query", "search", "get", "list"],
  "registrar": ["register", "create", "log", "record"],
  "programar": ["schedule", "plan", "cron"],
  "notificar": ["notify", "alert", "send"],
  "reiniciar": ["restart", "reset", "reboot"],
  "configurar": ["configure", "setup", "set"],
  "autenticar": ["authenticate", "login", "auth"],
  "publicar": ["publish", "deploy", "release"],
  "desplegar": ["deploy", "publish", "release"],
  "copiar": ["copy", "clone", "duplicate"],
  "mover": ["move", "transfer", "migrate"],
  "comparar": ["compare", "diff", "match"],
  "fusionar": ["merge", "combine", "join"],
  "dividir": ["split", "divide", "partition"],
  "filtrar": ["filter", "search", "query"],
  "ordenar": ["sort", "order", "arrange"],
  "traducir": ["translate", "convert"],

  // Entidades
  "base": ["base", "database", "db"],
  "bases": ["bases", "databases"],
  "datos": ["data", "records", "rows", "entries"],
  "registro": ["record", "entry", "row", "item"],
  "registros": ["records", "entries", "rows", "items"],
  "tabla": ["table", "schema", "collection"],
  "tablas": ["tables", "schemas"],
  "campo": ["field", "column", "property"],
  "campos": ["fields", "columns", "properties"],
  "usuario": ["user", "account"],
  "usuarios": ["users", "accounts"],
  "proyecto": ["project", "repo", "workspace"],
  "proyectos": ["projects", "repos", "workspaces"],
  "archivo": ["file", "document"],
  "archivos": ["files", "documents"],
  "correo": ["email", "mail", "message"],
  "correos": ["emails", "mails", "messages"],
  "noticia": ["news", "article", "post"],
  "noticias": ["news", "articles", "posts"],
  "contenido": ["content", "data", "text"],
  "tarea": ["task", "job", "issue", "ticket"],
  "tareas": ["tasks", "jobs", "issues", "tickets"],
  "pagina": ["page", "site", "web"],
  "enlace": ["link", "url", "reference"],
  "imagen": ["image", "picture", "photo"],
  "video": ["video", "media"],
  "audio": ["audio", "sound", "media"],
  "categoria": ["category", "tag", "label"],
  "estado": ["status", "state", "condition"],
  "error": ["error", "exception", "fault"],
  "fuente": ["source", "origin", "reference"],
  "esquema": ["schema", "structure", "model"],
  "respuesta": ["response", "reply", "answer"],
  "solicitud": ["request", "query", "call"],
  "repositorio": ["repository", "repo"],
  "seguridad": ["security", "auth", "permission"],
  "permiso": ["permission", "role", "access"],
  "acceso": ["access", "login", "entry"],
  "servidor": ["server", "host", "service"],
  "conexion": ["connection", "link", "integration"],
  "integracion": ["integration", "connector", "plugin"],
  "herramienta": ["tool", "utility", "function"],
  "informacion": ["info", "information", "details"],
  "lista": ["list", "collection", "array"],
  "reporte": ["report", "summary", "analytics"],
  "metrica": ["metric", "stat", "analytics"],
  "contacto": ["contact", "lead", "person"],
};

/**
 * Translate a Spanish query to English equivalents for the bilingual fallback.
 * Returns an array of English keyword tokens.
 */
function translateQueryToEnglish(query: string): string {
  const words = query.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(w => w.length > 1);
  const translated: string[] = [];

  for (const word of words) {
    const equivalents = ES_EN_DICT[word];
    if (equivalents) {
      translated.push(...equivalents);
    }
  }

  return [...new Set(translated)].join(" ");
}

function parseJsonOr<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildSnippet(content: string, query: string, maxLen = 420): string {
  const terms = query
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lower = content.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    idx = lower.indexOf(term);
    if (idx !== -1) break;
  }
  if (idx === -1) return content.slice(0, maxLen);
  const start = Math.max(0, idx - Math.floor(maxLen / 2));
  const end = Math.min(content.length, start + maxLen);
  return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}

// ─── search_knowledge ────────────────────────────────────────────────────────

export const searchKnowledgeTool: Tool = {
  name: "search_knowledge",
  description: "Busca herramientas NATIVAS (tools), MCP (tools externas), habilidades (skills), reglas del playbook o CÓDIGO FUENTE del proyecto en la base de conocimientos HiveDB. Usa fallback bilingüe español→inglés. type='mcp' para herramientas MCP, type='code' para buscar en el código fuente, type='all' para buscar en todo.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Término de búsqueda (nombre, descripción, categoría, función, clase). Se busca primero en español, luego en inglés si hay pocos resultados.",
      },
      type: {
        type: "string",
        enum: ["all", "tools", "skills", "playbook", "mcp", "code"],
        description: "Tipo de conocimiento a buscar",
      },
      limit: {
        type: "number",
        description: "Máximo de resultados (default: 10)",
      },
    },
    required: ["query"],
  },
  execute: async (params: Record<string, unknown>) => {
    const query = params.query as string;
    const type = (params.type as string) ?? "all";
    const limit = (params.limit as number) ?? 10;
    const MIN_RESULTS_FOR_BILINGUAL = 2;

    try {
      if (!query) {
        return { ok: true, query, type, tools: [], skills: [], playbook: [], toolsmcp: [], code: [], totalResults: 0 };
      }

      const normalizedQuery = query.replace(/_/g, " ").trim();

      const result: any = { query, type, tools: [], skills: [], playbook: [], toolsmcp: [], code: [] };

      const typeMap: Record<string, CapabilityType[]> = {
        tools: ["tool"],
        skills: ["skill"],
        playbook: ["playbook"],
        mcp: ["mcp"],
        code: ["code"],
      };
      const wantsCode = type === "all" || type === "code";
      const nonCodeTypes = type === "all"
        ? ["tool", "skill", "playbook", "mcp"] as CapabilityType[]
        : (typeMap[type] ?? []).filter(t => t !== "code");

      let activeSessionId = "";
      if (wantsCode) {
        try {
          activeSessionId = await getActiveCodeSessionId();
        } catch {
          activeSessionId = "";
        }
      }

      const coreCatalog = new Map(CORE_TOOL_CATALOG.map(t => [t.name, t]));
      const toolsCol = await col<ToolDoc>("tools");
      const skillsCol = await col<SkillDoc>("skills");
      const playbookCol = await col<PlaybookDoc>("playbook");
      const mcpToolsCol = await col<McpToolDoc>("mcpTools");
      const codeFilesCol = await col<CodeFileDoc>("codeFiles");

      async function runCapabilitySearch(text: string): Promise<CapabilityHit[]> {
        const groups: Promise<CapabilityHit[]>[] = [];
        if (nonCodeTypes.length > 0) {
          groups.push(searchCapabilities(text, { types: nonCodeTypes, k: limit * 4 }));
        }
        if (wantsCode && activeSessionId) {
          groups.push(searchCapabilities(text, {
            types: ["code"],
            filters: [{ field: "session_id", value: activeSessionId }],
            k: limit * 4,
          }));
        }
        const merged = (await Promise.all(groups)).flat();
        return merged.sort((a, b) => b.score - a.score);
      }

      async function hydrateTool(hit: CapabilityHit): Promise<any | null> {
        const entry = await toolsCol.get(hit.rawId);
        if (entry) {
          const row = entry.doc;
          return {
            id: row.id, name: row.name, description: row.description, category: row.category,
            enabled: row.enabled, active: row.active, rank: hit.score,
          };
        }
        const cat = coreCatalog.get(hit.rawId);
        if (!cat) return null;
        return {
          id: cat.name, name: cat.name, description: cat.description, category: cat.category,
          enabled: true, active: true, rank: hit.score,
        };
      }

      async function hydrateSkill(hit: CapabilityHit): Promise<any | null> {
        const entry = await skillsCol.get(hit.rawId);
        const s = entry?.doc;
        if (!s || !s.active) return null;
        return {
          id: s.id, name: s.name, description: s.description, category: s.category,
          tools: s.tools, triggers: s.triggers,
          preferred_agents: parseJsonOr(s.preferred_agents, []),
          body: s.body ? (s.body.length > 1500 ? s.body.substring(0, 1500) + "…" : s.body) : undefined,
          active: s.active, rank: hit.score,
        };
      }

      async function hydratePlaybook(hit: CapabilityHit): Promise<any | null> {
        const entry = await playbookCol.get(hit.rawId);
        const p = entry?.doc;
        if (!p || !p.active) return null;
        return {
          id: p.id, rule: p.rule, category: p.category,
          applicable_to: parseJsonOr(p.applicable_to, null),
          helpful_count: p.helpful_count, harmful_count: p.harmful_count,
          active: p.active, rank: hit.score,
        };
      }

      async function hydrateMcp(hit: CapabilityHit): Promise<any | null> {
        const entry = await mcpToolsCol.get(hit.rawId);
        const t = entry?.doc;
        if (!t || !t.active) return null;
        return {
          id: t.id, full_name: t.id, server_name: t.server_name, tool_name: t.tool_name,
          description: t.description, category: t.category,
          active: t.active, rank: hit.score,
        };
      }

      async function hydrateCode(hit: CapabilityHit): Promise<any | null> {
        const entry = await codeFilesCol.get(hit.rawId);
        const c = entry?.doc;
        if (!c) return null;
        return {
          file_path: c.file_path,
          snippet: buildSnippet(c.content, normalizedQuery),
          rank: hit.score,
        };
      }

      const seenIds = new Set<string>();
      async function mergeHits(hits: CapabilityHit[]): Promise<number> {
        let added = 0;
        for (const hit of hits) {
          if (seenIds.has(hit.id)) continue;
          let entry: any = null;
          let bucket: any[] | null = null;
          switch (hit.type) {
            case "tool":
              if (result.tools.length < limit) { entry = await hydrateTool(hit); bucket = result.tools; }
              break;
            case "skill":
              if (result.skills.length < limit) { entry = await hydrateSkill(hit); bucket = result.skills; }
              break;
            case "playbook":
              if (result.playbook.length < limit) { entry = await hydratePlaybook(hit); bucket = result.playbook; }
              break;
            case "mcp":
              if (result.toolsmcp.length < limit) { entry = await hydrateMcp(hit); bucket = result.toolsmcp; }
              break;
            case "code":
              if (result.code.length < limit) { entry = await hydrateCode(hit); bucket = result.code; }
              break;
          }
          if (entry && bucket) {
            bucket.push(entry);
            seenIds.add(hit.id);
            added++;
          }
        }
        return added;
      }

      const totalFirst = await mergeHits(await runCapabilitySearch(normalizedQuery));

      if (totalFirst < MIN_RESULTS_FOR_BILINGUAL) {
        const englishQuery = translateQueryToEnglish(normalizedQuery);
        if (englishQuery.length > 0) {
          log.info(`[search_knowledge] Bilingual fallback: "${normalizedQuery}" → "${englishQuery}" (first pass: ${totalFirst} results)`);
          await mergeHits(await runCapabilitySearch(englishQuery));
        }
      }

      result.totalResults = result.tools.length + result.skills.length + result.playbook.length + result.toolsmcp.length + result.code.length;

      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        error: `Search failed: ${(error as Error).message}`,
      };
    }
  },
};

// ─── notify ──────────────────────────────────────────────────────────────────

// ─── get_project_context ─────────────────────────────────────────────────────

export const getProjectContextTool: Tool = {
  name: "get_project_context",
  description: "Retrieve the global project context summary: structure, key files, critical modules, and active ADRs. Call this FIRST before exploring the project — it replaces fs_list/fs_glob for understanding the codebase.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: async (_params: Record<string, unknown>, _config?: any) => {
    try {
      const sessionId = await getActiveCodeSessionId();
      if (!sessionId) {
        return { ok: false, error: "No active session found." };
      }

      const cacheEntry = await (await col<CodeContextCacheDoc>("codeContextCache")).get(`project_context:${sessionId}`);
      const cacheRow = cacheEntry?.doc;

      if (cacheRow?.compiled && new Date(cacheRow.expires_at).getTime() > Date.now()) {
        return { ok: true, context: cacheRow.compiled };
      }

      return {
        ok: false,
        error: "Project context not cached yet. Run 'hivecode init' or wait for reconciliation.",
        hint: "You can still use search_knowledge(type='code', query='...') to find specific symbols.",
      };
    } catch (error) {
      return { ok: false, error: `Failed to retrieve project context: ${(error as Error).message}` };
    }
  },
};

// ─── notify ──────────────────────────────────────────────────────────────────

export const notifyTool: Tool = {
  name: "notify",
  description: "Send a notification or progress update to the user's active channel. Use this to keep the user informed while working on long tasks.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Notification message to send to the user",
      },
    },
    required: ["message"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const { sendToUserChannel } = await import("../../gateway/channel-notify");
    const message = params.message as string;
    const channel = (config?.configurable?.channel as string) ?? "webchat";
    const userId = (config?.configurable?.user_id as string) ?? "";

    log.info(`[notify] Sending to ${channel}/${userId}: ${message.substring(0, 80)}`);

    const result = await sendToUserChannel(channel, userId, message)
    if (!result.ok) throw new Error(`Channel send failed: ${result.error}`)
    return result
  },
};

// ─── save_note (scratchpad) ──────────────────────────────────────────────────

export const saveNoteTool: Tool = {
  name: "save_note",
  description: "Save a note to the scratchpad (survives context compression).",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Unique key for the note",
      },
      value: {
        type: "string",
        description: "Note content",
      },
      thread_id: {
        type: "string",
        description: "Thread ID (optional, uses current thread if not specified)",
      },
    },
    required: ["key", "value"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const key = params.key as string;
    const value = params.value as string;
    const threadId = (params.thread_id as string) ?? config?.configurable?.thread_id ?? "default";

    // Without this the note is silently lost: a model that guesses the argument
    // names writes a row keyed "<thread>:undefined" with no content and still
    // gets "Note saved." back.
    if (typeof key !== "string" || !key.trim()) {
      return { ok: false, error: "save_note requires a non-empty 'key' string." };
    }
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, error: "save_note requires a non-empty 'value' string." };
    }

    try {
      const scratchpad = await col<ScratchpadDoc>("scratchpad");
      const id = `${threadId}:${key}`;
      const existing = await scratchpad.get(id);
      await scratchpad.put(
        id,
        {
          id,
          thread_id: threadId,
          key,
          value,
          source: "agent",
          created_at: existing?.doc.created_at ?? Date.now(),
          updated_at: Date.now(),
        },
        { expectedVersion: existing?.version ?? 0 },
      );

      return { ok: true, key, message: "Note saved." };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to save note: ${(error as Error).message}`,
      };
    }
  },
};

// ─── report_progress ─────────────────────────────────────────────────────────

export const reportProgressTool: Tool = {
  name: "report_progress",
  description: "Report progress of an ongoing task to the user. Sends a real-time update to the active channel. Use frequently during long operations so the user knows what's happening.",
  parameters: {
    type: "object",
    properties: {
      progress: {
        type: "number",
        description: "Progress percentage (0-100)",
      },
      message: {
        type: "string",
        description: "Progress message describing what you are currently doing",
      },
      task_id: {
        type: "string",
        description: "Task or project ID (optional)",
      },
    },
    required: ["progress", "message"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const { sendToUserChannel } = await import("../../gateway/channel-notify");
    const progress = params.progress as number;
    const message = params.message as string;
    const taskId = (params.task_id as string) ?? null;
    const channel = (config?.configurable?.channel as string) ?? "webchat";
    const userId = (config?.configurable?.user_id as string) ?? "";

    log.info(`[report_progress] ${progress}% — ${message}`);

    // Update task progress in DB if task_id provided
    if (taskId) {
      const tasks = await col<TaskDoc>("tasks");
      const task = await tasks.get(taskId);
      if (task) {
        await tasks.put(taskId, { ...task.doc, progress, updated_at: Date.now() }, { expectedVersion: task.version });
      }
    }

    // Send real-time update to the user's channel
    const progressEmoji = progress >= 100 ? "✅" : progress >= 50 ? "⚙️" : "🔄";
    const result = await sendToUserChannel(channel, userId, `${progressEmoji} ${progress}% — ${message}`)
    if (!result.ok) throw new Error(`Channel send failed: ${result.error}`)

    return { ok: true, progress, message, task_id: taskId };
  },
};

export function createTools(): Tool[] {
  return [searchKnowledgeTool, getProjectContextTool, notifyTool, saveNoteTool, reportProgressTool];
}
