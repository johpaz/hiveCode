/**
 * HiveDB-based Dynamic Tool Selector Module
 * 
 * Context Compiler Level 3 - Intelligent Tool Selection
 * 
 * This module intercepts each message BEFORE calling the LLM and uses
 * HiveDB BM25 scoring to select the most relevant tools.
 * 
 * DESIGN DECISIONS:
 * 
 * 1. Stateless: No memory between turns - each message is evaluated independently.
 *    Rationale: Prevents cascade effects where a bad selection in one turn affects
 *    future turns. Forces fresh evaluation each time.
 * 
 * 2. Maximum 4 tools per turn: Keeps token count low and prevents overwhelming
 *    the LLM with irrelevant tools. Forces prioritization.
 * 
 * 3. Relative relevance cutoff: HiveDB BM25 scores are positive and
 *    corpus-dependent, so hits are kept only when they are close enough to
 *    the top match.
 * 
 * 4. Atomic over orchestration: When ambiguous, prefer individual tools over
 *    compound/manager tools. Rationale: Atomic tools are more predictable and
 *    the LLM can combine them as needed.
 * 
 * 5. Performance: Must complete in under 50ms. HiveDB/tantivy queries are
 *    sub-millisecond for small tool catalogs.
 * 
 * 6. Tool categorization: Tools are categorized by semantic domain:
 *    - scheduling (cron tools)
 *    - projects (project/task management)
 *    - filesystem (file operations)
 *    - web (search/fetch)
 *    - browser (browser automation)
 *    - memory (notes, memory operations)
 *    - code (exec, terminal)
 *    - agents (agent creation/management)
 *    - core (notify, report_progress, save_note)
 */

import { col } from "../storage/hive"
import type { ToolDoc } from "../storage/collections"
import { logger } from "../utils/logger"
import { getExecutionMode, filterToolsByMode } from "./execution-mode"
import {
    searchCapabilities,
    applyRelativeCutoff,
    replaceCapabilityDocs,
    type CapabilityDoc,
} from "./capability-search"

const log = logger.child("tool-selector")

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface ToolDescriptor {
    name: string
    description: string
    category: string
    /** Abstraction level: atomic (single operation) vs orchestration (manages multiple) */
    abstractionLevel?: "atomic" | "orchestration"
}

export interface SelectedTool {
    name: string
    score: number
    category: string
}

export interface ToolSelectorResult {
    tools: ToolDescriptor[]
    selected: SelectedTool[]
    reasoning: string
    timingMs: number
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Maximum tools to return per message */
const MAX_TOOLS_PER_TURN = 12

/**
 * Relative relevance cutoff: keep a hit only if it scores at least this
 * fraction of the top hit. HiveDB BM25 scores are positive (higher = better)
 * but corpus-dependent, so absolute thresholds do not transfer.
 */
const RELEVANCE_RATIO = 0.3

/** Stopwords used by conversational filtering before capability search */
const STOPWORDS = new Set([
    "que", "con", "para", "por", "una", "uno", "los", "las", "del",
    "como", "esta", "esto", "ese", "eso", "the", "and", "for",
    "with", "this", "that", "have", "will", "also", "de", "en",
    "el", "la", "se", "su", "sus", "al", "es", "son", "pero",
    "más", "mas", "ya", "yo", "tu", "te", "ti", "mi", "me",
    "hola", "hi", "hello", "hey", "gracias", "thank", "please",
    "ok", "okay", "yes", "si", "no", "bien", "good", "great",
])

/** Conversational patterns that should return empty tool list */
const CONVERSATIONAL_PATTERNS = [
    /^(hola|hi|hello|hey|buenos? días?|buenas? noches?|qué tal|howdy)/i,
    /^(gracias|thank you|thanks|muchas gracias|muchas thanks)/i,
    /^(cómo estás?|how are you?|qué流水|you doing|qué cuentas)/i,
    /^(sí|yes|ok|okay|de acuerdo|perfecto|claro|por supuesto)/i,
    /^(adiós|bye|nos vemos|see you|later|chau)/i,
    /^(entiendo|understand|i see|ya veo|got it)/i,
    /^(bien|good|great|excelente|awesome|perfect)/i,
    /^(?:\?|¿)$/,  // Just a question mark
]

// ─── Tool Catalog ───────────────────────────────────────────────────────────
//
// These tools cover the full native toolset. Each has:
// - name: unique identifier
// - description: what the tool does (used for HiveDB BM25 matching)
// - category: semantic domain for grouping
// - abstractionLevel: atomic (single operation) vs orchestration (manages multiple)
//
// The descriptions are enriched with Spanish/English keywords for better HiveDB matching.

export const CORE_TOOL_CATALOG: ToolDescriptor[] = [
    // Cron tools (cron.*)
    { name: "cron.create", description: "Create new cron job: recurring (cron expression) or one-shot (fire_at). Requires 'task' field with instruction for the agent. Spanish keywords: programar tarea, crear recordatorio, agendar, automatizar horario, tarea recurrente, recordatorio diario, una vez", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.list", description: "List all cron jobs with next execution times and status. Spanish keywords: ver tareas programadas, listar cronograma, próximas ejecuciones, tareas activas, recordatorios pendientes", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.update", description: "Update an existing cron job: change expression, task instruction, channel, time window, etc. Use cron.list first to get task_id. Spanish keywords: actualizar tarea, modificar cron, editar recordatorio, cambiar horario, actualizar programación", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.pause", description: "Pause a cron job temporarily without deleting it. Spanish keywords: pausar tarea programada, detener temporalmente, suspender recordatorio", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.resume", description: "Resume a previously paused cron job. Spanish keywords: reanudar tarea, continuar tarea pausada, activar recordatorio", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.delete", description: "Delete a cron job permanently. Spanish keywords: eliminar tarea programada, borrar recordatorio, cancelar tarea", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.trigger", description: "Manually trigger immediate execution of a cron job now. Spanish keywords: ejecutar tarea ahora, forzar ejecución, disparar manualmente", category: "scheduling", abstractionLevel: "atomic" },
    { name: "cron.history", description: "Get execution history and run logs for a cron job. Spanish keywords: historial ejecuciones, logs tarea, cuándo corrió, registro de ejecuciones", category: "scheduling", abstractionLevel: "atomic" },


    // Code execution
    { name: "shell_executor", description: "Execute shell commands, run bash scripts and system commands. Spanish keywords: ejecutar comando, terminal, línea de comandos, bash, script, comando del sistema", category: "cli", abstractionLevel: "atomic" },

    // Web tools
    { name: "web_search", description: "Search web for current information, find up-to-date news facts and research. Spanish keywords: buscar en internet, buscar web, información, noticias, investigación, buscar", category: "web", abstractionLevel: "atomic" },
    { name: "web_fetch", description: "Fetch content from URL, download and extract content from web pages. Spanish keywords: obtener página, descargar web, extraer contenido, obtener contenido, página web", category: "web", abstractionLevel: "atomic" },

    // Memory tools
    { name: "memory_write", description: "Store in long-term memory, save information to persistent memory for later retrieval. Spanish keywords: guardar memoria, guardar información, recordar, guardar dato, memoria", category: "memory", abstractionLevel: "atomic" },
    { name: "memory_read", description: "Retrieve from memory by title, fetch saved information using memory identifier. Spanish keywords: leer memoria, recuperar información, recordar, obtener dato, buscar memoria", category: "memory", abstractionLevel: "atomic" },
    { name: "memory_list", description: "List all memory entries, show all saved memories and stored knowledge. Spanish keywords: listar memorias, ver memorias guardadas, todas las memorias, lista de memorias", category: "memory", abstractionLevel: "atomic" },
    { name: "memory_search", description: "Search memory by content, find memories containing specific keywords. Spanish keywords: buscar en memoria, buscar información guardada, buscar en recuerdos", category: "memory", abstractionLevel: "atomic" },
    { name: "memory_delete", description: "Delete memory entry, remove saved memory from long-term storage. Spanish keywords: borrar memoria, eliminar información guardada, borrar dato, eliminar memoria", category: "memory", abstractionLevel: "atomic" },

    // Agent/worker management
    { name: "agent_create", description: "Create specialized worker agent, spawn new agent for specific task execution. Spanish keywords: crear agente, nuevo agente, trabajador, crear worker, nuevo trabajador", category: "agents", abstractionLevel: "orchestration" },
    { name: "agent_find", description: "Find existing worker agents, locate running or idle worker agents. Spanish keywords: buscar agente, encontrar trabajador, localizar, buscar worker, encontrar agente", category: "agents", abstractionLevel: "atomic" },
    { name: "agent_archive", description: "Archive unnecessary worker, terminate and archive idle or completed agents. Spanish keywords: archivar agente, terminar agente, borrar trabajador, desactivar agente", category: "agents", abstractionLevel: "atomic" },

    // Notes/persistence
    { name: "save_note", description: "Save persistent note to scratchpad, write quick notes and reminders. Spanish keywords: guardar nota, escribir nota, recordatorio rápido, nota rápida, apuntar", category: "core", abstractionLevel: "atomic" },

    // Notifications/reporting
    { name: "notify", description: "Send system notification, alert user with message or alert. Spanish keywords: notificar, enviar notificación, alertar, aviso, alarma", category: "core", abstractionLevel: "atomic" },
    { name: "report_progress", description: "Report progress to user, inform user of current status and completion. Spanish keywords: reportar progreso, informar estado, actualizar,报告进度, progreso", category: "core", abstractionLevel: "atomic" },

    // Browser automation
    { name: "browser_navigate", description: "Navigate to URL, returns accessibility tree snapshot (200-400 tokens, 4-6x cheaper than screenshot). Falls back to screenshot if agent-browser not installed. Sets active session for browser_click/type/etc. Spanish keywords: navegar web, abrir página, ir a sitio, árbol accesibilidad, snapshot página", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_screenshot", description: "Take webpage screenshot, capture visual snapshot of web page. Use for canvas, visual verification, or when accessibility tree is insufficient. Spanish keywords: captura de pantalla, screenshot, fotografiar página, imagen de página", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_click", description: "Click element on page using CSS selector or ARIA ID like @e3. Requires active session from browser_navigate. Spanish keywords: hacer clic, presionar botón, clickear, pulsar, botón, selector ARIA", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_type", description: "Type into input field, fill forms and text inputs. Accepts CSS selector or ARIA ID like @e3. Requires active session from browser_navigate. Spanish keywords: escribir en página, llenar formulario, introducir texto, completar formulario", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_extract", description: "Extract text, links or structured JSON from page using CSS selector. Returns compact text (not screenshot). Requires active session from browser_navigate. Spanish keywords: extraer datos, obtener información, scraping, selectores, xpath, contenido", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_script", description: "Execute arbitrary JavaScript in the browser page context and return the result. Requires active session from browser_navigate. Spanish keywords: ejecutar javascript, script, código, función, evaluar, js en página, ejecutar código", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_wait", description: "Wait for a CSS selector or ARIA element to appear on the page. Requires active session from browser_navigate. Spanish keywords: esperar, wait, condición, elemento, selector, aguardar carga, elemento presente", category: "browser", abstractionLevel: "atomic" },


    // Git tools
    { name: "git_status", description: "Show working tree status (git status), view changed staged and untracked files. Spanish keywords: estado git, cambios, staged, repositorio", category: "git", abstractionLevel: "atomic" },
    { name: "git_diff", description: "Show changes in working tree or between commits (git diff). Spanish keywords: ver cambios, diff, comparar diferencias git", category: "git", abstractionLevel: "atomic" },
    { name: "git_log", description: "Show commit history (git log). Spanish keywords: historial commits, log git, commits recientes", category: "git", abstractionLevel: "atomic" },
    { name: "git_branch", description: "List create or delete git branches. Spanish keywords: ramas git, branch, crear rama, listar ramas", category: "git", abstractionLevel: "atomic" },
    { name: "git_commit", description: "Stage files and create a git commit. Spanish keywords: commit, confirmar cambios, git commit", category: "git", abstractionLevel: "orchestration" },

    // Code analysis tools
    { name: "code_search", description: "Search codebase for patterns using ripgrep or grep find function definitions and imports. Spanish keywords: buscar codigo, grep, encontrar funcion, buscar patron", category: "code", abstractionLevel: "atomic" },
    { name: "code_lint", description: "Run linter on codebase auto-detects ESLint or Ruff. Spanish keywords: linter, eslint, revisar codigo, calidad", category: "code", abstractionLevel: "atomic" },
    { name: "code_test", description: "Run test suites auto-detects test framework. Spanish keywords: tests, pruebas, ejecutar tests, bun test, npm test", category: "code", abstractionLevel: "atomic" },
    { name: "code_build", description: "Run build command for the project auto-detects build script. Spanish keywords: compilar, build, construir proyecto", category: "code", abstractionLevel: "atomic" },
    { name: "code_diff_create", description: "Generate unified diff between two files or versions for code review. Spanish keywords: crear diff, parche, diferencia archivos", category: "code", abstractionLevel: "atomic" },

    // Filesystem tools
    { name: "fs_read", description: "Read file content from workspace. Spanish keywords: leer archivo, ver contenido, abrir archivo, leer fichero, mostrar archivo", category: "filesystem", abstractionLevel: "atomic" },
    { name: "fs_write", description: "Create or overwrite file in workspace. Spanish keywords: crear archivo, guardar archivo, escribir archivo, crear fichero, escribir fichero", category: "filesystem", abstractionLevel: "atomic" },
    { name: "fs_edit", description: "Edit specific lines or sections of a file. Spanish keywords: editar archivo, modificar líneas, actualizar contenido, cambiar archivo", category: "filesystem", abstractionLevel: "atomic" },
    { name: "fs_delete", description: "Delete file or directory. Spanish keywords: eliminar archivo, borrar archivo, borrar carpeta, eliminar fichero", category: "filesystem", abstractionLevel: "atomic" },
    { name: "fs_list", description: "List files and directories. Spanish keywords: listar archivos, ver carpeta, explorar directorio, listar ficheros", category: "filesystem", abstractionLevel: "atomic" },
    { name: "fs_glob", description: "Find files matching wildcard patterns. Spanish keywords: buscar archivos, patrón, encontrar archivos, buscar ficheros", category: "filesystem", abstractionLevel: "atomic" },
    { name: "fs_exists", description: "Check if a file or directory exists. Spanish keywords: verificar archivo, comprobar, existe archivo, comprobar fichero", category: "filesystem", abstractionLevel: "atomic" },

    // Agent delegation and communication
    { name: "task_delegate", description: "Delegate general task to worker agent. Spanish keywords: delegar tarea, asignar worker, ejecutar por agente, encomendar tarea", category: "agents", abstractionLevel: "orchestration" },
    { name: "task_delegate_code", description: "Delegate coding task to CLI subagent (Qwen, Claude Code, Gemini CLI). Spanish keywords: delegar código, subagente CLI, programación, codificar", category: "agents", abstractionLevel: "orchestration" },
    { name: "task_status", description: "Get execution status of delegated tasks. Spanish keywords: estado tarea delegada, verificar progreso, consultar tarea, progreso delegado", category: "agents", abstractionLevel: "atomic" },
    { name: "bus_publish", description: "Publish message to Agent Bus for worker-to-worker communication. Spanish keywords: publicar mensaje, comunicar workers, enviar bus, mensaje bus", category: "agents", abstractionLevel: "atomic" },
    { name: "bus_read", description: "Read unread messages from Agent Bus. Spanish keywords: leer mensajes bus, recibir mensajes, verificar bus, mensajes workers", category: "agents", abstractionLevel: "atomic" },
    { name: "project_updates", description: "Get recent status updates from workers in project. Spanish keywords: actualizaciones proyecto, estado workers, progreso equipo, noticias proyecto", category: "agents", abstractionLevel: "atomic" },
    { name: "get_available_models", description: "List active LLM providers and models from DB. Required before agent_create to select provider+model. Spanish keywords: ver modelos, listar providers, modelos disponibles, consultar modelos, qué modelos tengo", category: "agents", abstractionLevel: "atomic" },
    { name: "spawn_agent", description: "Create ephemeral subagent, execute with own context, evaluate result and destroy — with retries. Spanish keywords: subagente efímero, agente temporal, crear y ejecutar agente, one-shot agent", category: "agents", abstractionLevel: "orchestration" },

    // Filesystem (extra)
    { name: "search_in_files", description: "Search for string or regex pattern in files using ripgrep/grep, returns matching lines with numbers. Spanish keywords: buscar en archivos, grep, buscar patrón, encontrar texto en código, buscar código", category: "filesystem", abstractionLevel: "atomic" },

    // Core discovery and context
    { name: "search_knowledge", description: "HiveDB search over native tools, MCP tools, skills, playbook rules, and project code. The primary discovery mechanism. Spanish keywords: buscar herramienta, encontrar skill, qué herramienta usar, descubrir capacidad, buscar conocimiento", category: "core", abstractionLevel: "atomic" },
    { name: "get_project_context", description: "Get cached project structure summary: key files, modules, active ADRs. Faster than recursive fs_list. Spanish keywords: contexto del proyecto, estructura del proyecto, resumen del proyecto", category: "core", abstractionLevel: "atomic" },

    // Git (advanced)
    { name: "git_blame", description: "Show line-by-line authorship (git blame). Spanish keywords: git blame, autoría, quién escribió, historial de línea", category: "git", abstractionLevel: "atomic" },
    { name: "git_create_pr", description: "Create GitHub Pull Request via API. Auto-detects base branch and changes. Spanish keywords: crear PR, pull request, github PR, abrir pull request", category: "git", abstractionLevel: "orchestration" },
    { name: "git_rollback", description: "Restore files from pre-task snapshots. Spanish keywords: revertir, rollback, deshacer cambios, restaurar archivos, volver al estado anterior", category: "git", abstractionLevel: "atomic" },

    // Code analysis (advanced)
    { name: "parse_ast", description: "Analyze TypeScript/JavaScript AST: imports, exports, functions, cyclomatic complexity. Spanish keywords: analizar código, AST, árbol sintáctico, estructura de código, imports del archivo", category: "code", abstractionLevel: "atomic" },
    { name: "find_imports", description: "Find all files importing a given module via the indexed code graph. Spanish keywords: quién importa, dependencias inversas, importadores, dependientes del módulo", category: "code", abstractionLevel: "atomic" },
    { name: "check_types", description: "Run TypeScript type checking (bun tsc --noEmit). Returns errors, warnings, duration. Spanish keywords: typecheck, verificar tipos, tsc, errores typescript, validar tipos", category: "code", abstractionLevel: "atomic" },
    { name: "run_script", description: "Execute TypeScript/JavaScript file in isolated subprocess (60s timeout). Spanish keywords: ejecutar script, correr archivo, run script, ejecutar código aislado", category: "code", abstractionLevel: "atomic" },
    { name: "code_test_parallel", description: "Run multiple test suites concurrently and aggregate pass/fail results. Spanish keywords: tests paralelos, suites en paralelo, ejecutar tests múltiples", category: "code", abstractionLevel: "atomic" },

    // Browser (extras not in basic set)
    { name: "browser_capture_clipboard", description: "Read image from system clipboard, return as base64 WebP for agent context. Spanish keywords: capturar portapapeles, leer clipboard, imagen copiada", category: "browser", abstractionLevel: "atomic" },
    { name: "browser_preview_html", description: "Serve HTML on temp local server and capture headless screenshot. Spanish keywords: preview HTML, renderizar HTML, ver HTML generado, screenshot de HTML", category: "browser", abstractionLevel: "atomic" },

    // Narrative — story log and architectural decisions
    { name: "read_narrative", description: "Read narrative entries for session/task in chronological order. Spanish keywords: leer narrativa, historial de tarea, log de trabajo, qué se hizo, historia del proyecto", category: "narrative", abstractionLevel: "atomic" },
    { name: "append_narrative", description: "Append entry to the narrative log (markdown). Spanish keywords: agregar narrativa, escribir log, documentar progreso, guardar avance", category: "narrative", abstractionLevel: "atomic" },
    { name: "search_narrative", description: "Full-text search over narrative entries with relevance scores. Spanish keywords: buscar en narrativa, buscar en historial, encontrar en log", category: "narrative", abstractionLevel: "atomic" },
    { name: "read_decisions", description: "List Architecture Decision Records (ADRs) by status or task. Spanish keywords: leer decisiones, ver ADRs, decisiones arquitecturales, historial de decisiones", category: "narrative", abstractionLevel: "atomic" },
    { name: "write_decision", description: "Save ADR with context, options, decision and consequences. Spanish keywords: guardar decisión, crear ADR, documentar decisión, registrar ADR", category: "narrative", abstractionLevel: "atomic" },
    { name: "get_task_context", description: "Full context for a task: narrative + decisions + file snapshots. Spanish keywords: contexto completo de tarea, todo sobre la tarea, estado completo", category: "narrative", abstractionLevel: "atomic" },

    // API
    { name: "api_request", description: "HTTP client for REST APIs: full control over method, headers, body, auth. Spanish keywords: llamar API, petición HTTP, curl, REST, endpoint, webhook, consumir servicio", category: "api", abstractionLevel: "atomic" },
]

// ─── Helper Functions ───────────────────────────────────────────────────────-

/**
 * Check if message is purely conversational (no tools needed)
 * 
 * Uses pattern matching for common conversational phrases.
 * Also checks for very short messages that are likely greetings.
 */
function isConversational(message: string): boolean {
    log.info(`[tool-selector] Checking if message is conversational: "${message}"`)
    const trimmed = message.trim()

    // Empty or very short messages
    if (trimmed.length < 2) return true

    // Check conversational patterns
    for (const pattern of CONVERSATIONAL_PATTERNS) {
        if (pattern.test(trimmed)) {
            log.debug(`[tool-selector] Message matched conversational pattern: ${pattern}`)
            return true
        }
    }

    // Check if all words are stopwords (likely conversational)
    const words = trimmed.toLowerCase().split(/\s+/)
    const meaningfulWords = words.filter(w => w.length > 2 && !STOPWORDS.has(w))
    if (meaningfulWords.length === 0) {
        log.debug(`[tool-selector] All words are stopwords - conversational`)
        return true
    }

    return false
}

/**
 * Determine abstraction level preference
 * 
 * Returns 'atomic' to prefer individual tools, 'orchestration' to prefer
 * manager tools. Currently always prefers atomic for better control.
 */
function getAbstractionPreference(): "atomic" | "orchestration" {
    // Prefer atomic tools for more predictable behavior
    return "atomic"
}

// ─── Main Selection Function ─────────────────────────────────────────────────

/**
 * Select tools for a given user message using HiveDB BM25 scoring
 * 
 * @param userMessage - The raw user message
 * @param fullToolList - Full list of available tools (for validation/filtering)
 * @returns Array of 0-4 selected tools with scores
 * 
 * ALGORITHM:
 * 1. If conversational → return []
 * 2. Query the HiveDB capability index with the raw message
 * 3. Keep hits scoring at least RELEVANCE_RATIO of the top hit
 * 5. If ambiguous → prefer atomic over orchestration
 * 6. Return top maxTools results (default: MAX_TOOLS_PER_TURN)
 */
export async function selectTools(
    userMessage: string,
    fullToolList: ToolDescriptor[] = CORE_TOOL_CATALOG,
    maxTools: number = MAX_TOOLS_PER_TURN
): Promise<ToolDescriptor[]> {
    const startTime = performance.now()

    // Log incoming user message for debugging/validation
    log.debug(`[tool-selector] Processing user message: "${userMessage.substring(0, 100)}"`)

    // Step 1: Check if conversational
    if (isConversational(userMessage)) {
        log.debug(`[tool-selector] Conversational message, returning empty array`)
        return []
    }

    // Step 2: Query the HiveDB capability index with the raw user text.
    let hits
    try {
        hits = await searchCapabilities(userMessage, {
            types: ["tool"],
            k: maxTools * 2,
        })
    } catch (err) {
        log.error(`[tool-selector] Capability search failed:`, err)
        return []
    }

    if (hits.length === 0) {
        log.debug(`[tool-selector] No matches, returning empty array`)
        return []
    }

    log.info(`[tool-selector] Raw scores: ${hits.slice(0, 10).map(h => `${h.rawId}=${h.score.toFixed(2)}`).join(", ")}`)

    // Step 3: Keep only hits close enough to the best match
    const relevantHits = applyRelativeCutoff(hits, RELEVANCE_RATIO)
    if (relevantHits.length === 0) {
        log.debug(`[tool-selector] All results below ratio cutoff, returning empty`)
        return []
    }

    // Step 4: Map to tool descriptors with additional metadata
    const toolMap = new Map(fullToolList.map(t => [t.name, t]))

    const scoredTools: SelectedTool[] = []

    for (const hit of relevantHits) {
        const tool = toolMap.get(hit.rawId)
        if (tool) {
            scoredTools.push({
                name: tool.name,
                score: hit.score,
                category: tool.category,
            })
        }
    }

    // Step 6: Prefer atomic over orchestration when ambiguous
    // If we have more than MAX_TOOLS_PER_TURN, prioritize by abstraction level
    const abstractionPref = getAbstractionPreference()

    if (scoredTools.length > MAX_TOOLS_PER_TURN) {
        // Sort by score first, then by abstraction level preference
        scoredTools.sort((a, b) => {
            // First by score (descending: HiveDB scores are positive, higher = better)
            if (Math.abs(a.score - b.score) > 0.1) {
                return b.score - a.score
            }
            // Then by abstraction preference (preferred type first)
            const aTool = toolMap.get(a.name)
            const bTool = toolMap.get(b.name)
            const aLevel = aTool?.abstractionLevel ?? "atomic"
            const bLevel = bTool?.abstractionLevel ?? "atomic"

            if (abstractionPref === "atomic") {
                return (aLevel === "atomic" ? -1 : 1)
            } else {
                return (aLevel === "orchestration" ? -1 : 1)
            }
        })
    }

    // Step 7: Take top N tools
    const topTools = scoredTools.slice(0, maxTools)

    // Step 8: Return as ToolDescriptor array
    let result = topTools.map(t => toolMap.get(t.name)!).filter(Boolean)

    // Step 9: Filter by execution mode (plan/exec)
    result = filterToolsByMode(result)

    const timing = performance.now() - startTime

    // Log final selected tools with info level (important for tracking tool selection process)
    if (result.length > 0) {
        log.info(`[tool-selector] Selected ${result.length} tools in ${timing.toFixed(2)}ms (mode: ${getExecutionMode()}):`,
            result.map(t => ({ name: t.name, category: t.category })))
    } else {
        log.debug(`[tool-selector] No tools selected, returning empty array in ${timing.toFixed(2)}ms`)
    }

    return result
}

// ─── Sync Tools to HiveDB ───────────────────────────────────────────────────

/**
 * Sync tool catalog to the HiveDB capability index.
 *
 * Called on initialization from gateway/initializer.ts to populate the HiveDB index.
 * Descriptions are enriched with bilingual keywords for better matching.
 *
 * @param tools - Optional array of tools to sync. If not provided, fetches from DB.
 */
export async function syncToolCatalogToIndex(tools?: ToolDescriptor[]): Promise<void> {
    try {
        // Step 1: Build full catalog = CORE_TOOL_CATALOG + any tools in DB not already covered
        // CORE_TOOL_CATALOG has bilingual keywords; DB tools may be dynamically registered
        const catalogByName = new Map<string, ToolDescriptor>(
            CORE_TOOL_CATALOG.map(t => [t.name, t])
        )

        // Merge in any tools from HiveDB that are missing from the static catalog
        const toolsCol = await col<ToolDoc>("tools")
        const dbTools = (await toolsCol.scan({})).map(e => e.doc)
        for (const row of dbTools) {
            if (!catalogByName.has(row.name)) {
                catalogByName.set(row.name, {
                    name: row.name,
                    description: row.description ?? row.name,
                    category: (row.category ?? "core") as any,
                    abstractionLevel: "atomic",
                })
            }
        }

        // Also merge any explicitly passed tools (e.g. from initializer)
        for (const t of (tools || [])) {
            if (!catalogByName.has(t.name)) {
                catalogByName.set(t.name, t)
            }
        }

        const toolCatalog = Array.from(catalogByName.values())

        // Step 2: Replace all tool documents in the HiveDB capability index
        const docs: CapabilityDoc[] = toolCatalog.map(tool => ({
            type: "tool" as const,
            rawId: tool.name,
            name: tool.name,
            body: enrichToolDescription(tool),
            tags: tool.category,
        }))

        await replaceCapabilityDocs("tool", docs)

        log.info(`[tool-selector] Sync complete: ${toolCatalog.length} tools indexed in HiveDB`)

    } catch (err) {
        log.error(`[tool-selector] Tool index sync failed:`, err)
        throw err // Re-throw to inform initializer
    }
}

/**
 * Enrich tool description with category-specific keywords
 * 
 * This improves HiveDB matching for both English and Spanish queries.
 */
function enrichToolDescription(tool: ToolDescriptor): string {
    const keywordsByCategory: Record<string, string> = {
        scheduling: "programar recordatorio alarma cron schedule reminder task future tiempo",
        projects: "proyecto tarea plan organizer milestone backlog sprint work",
        filesystem: "archivo file leer escribir editar documento content source code",
        web: "buscar internet google web search find information news research",
        browser: "navegador browser click screenshot form automation web page UI",
        memory: "recordar nota guardar memory store remember persist knowledge",
        code: "code ejecutar run script bash shell terminal command devops",
        agents: "agente worker specialist create delegate hire team manager",
        core: "notificar message alert notify communicate progress status",
        voice: "voz audio transcribir speech speak sintetizar audio voice transcription",
    }

    const extra = keywordsByCategory[tool.category] ?? ""
    return `${tool.description} ${extra}`
}

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Sanitize an MCP tool name to comply with LLM function-name rules.
 *
 * Gemini (and OpenAI) require: start with letter/underscore, only [a-zA-Z0-9_.-:], max 64 chars.
 * Server names from the UI can contain spaces and special chars (e.g. "X antes twiter").
 *
 * Canonical format: `{safeServer}__{safeTool}` (double underscore as separator)
 */
export function mcpToolFullName(serverName: string, toolName: string): string {
    const safe = (s: string) => s.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.\-:]/g, '_')
    const full = `${safe(serverName)}__${safe(toolName)}`
    // Ensure starts with letter/underscore and fits within 64 chars
    const trimmed = full.length > 64 ? full.substring(0, 64) : full
    return /^[a-zA-Z_]/.test(trimmed) ? trimmed : `_${trimmed}`.substring(0, 64)
}

/**
 * Initialize the tool selector
 *
 * DEPRECATED: syncToolCatalogToIndex() is now called from gateway/initializer.ts
 * This function is kept for backward compatibility but is no longer needed
 */
export function initializeToolSelector(): void {
    log.info(`[tool-selector] Initializing (deprecated - sync is done in gateway/initializer.ts)`)
    // syncToolCatalogToIndex() - No longer needed here, done in gateway/initializer.ts
}

// ─── Debug/Test Helpers ─────────────────────────────────────────────────────

/**
 * Get all tools (for debugging/testing)
 */
export function getAllTools(): ToolDescriptor[] {
    return [...CORE_TOOL_CATALOG]
}

/**
 * Get tool by name
 */
export function getToolByName(name: string): ToolDescriptor | undefined {
    return CORE_TOOL_CATALOG.find(t => t.name === name)
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: string): ToolDescriptor[] {
    return CORE_TOOL_CATALOG.filter(t => t.category === category)
}
