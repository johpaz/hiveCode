// ─── Tool narration map ───────────────────────────────────────────────────────
// Maps tool name prefixes/exact names to human-readable Spanish narrations.
// Shown to the user while the agent executes a tool.
export const TOOL_NARRATIONS: Record<string, string> = {
  // Web
  web_search: "Buscando en la web...",
  web_fetch: "Leyendo página web...",
  // Files
  read: "Leyendo archivo...",
  write: "Escribiendo archivo...",
  edit: "Editando archivo...",
  exec: "Ejecutando comando...",
  // Cron
  "cron.create": "Programando tarea...",
  "cron.list": "Consultando tareas programadas...",
  "cron.update": "Actualizando tarea programada...",
  "cron.delete": "Eliminando tarea programada...",
  "cron.pause": "Pausando tarea programada...",
  "cron.resume": "Reanudando tarea programada...",
  "cron.trigger": "Ejecutando tarea ahora...",
  "cron.history": "Consultando historial...",
  // Agents
  create_agent: "Creando agente worker...",
  find_agent: "Buscando agente disponible...",
  archive_agent: "Archivando agente...",
  // Memory
  save_note: "Guardando nota...",
  memory_write: "Guardando en memoria...",
  memory_read: "Leyendo memoria...",
  memory_search: "Buscando en memoria...",
  memory_delete: "Eliminando de memoria...",
  memory_list: "Listando notas...",
  // Browser
  browser_navigate: "Navegando a la página...",
  browser_click: "Haciendo clic...",
  browser_type: "Escribiendo en la página...",
  browser_screenshot: "Tomando captura de pantalla...",
  browser_extract: "Extrayendo información de la página...",
  browser_script: "Ejecutando JavaScript en la página...",
  browser_wait: "Esperando elemento en la página...",
  // Notify / Core
  notify: "Enviando notificación...",
  report_progress: "Reportando progreso...",
  get_project_context: "Cargando contexto del proyecto...",
  search_knowledge: "Buscando en la base de conocimientos...",
  // Code analysis
  parse_ast: "Analizando AST del archivo...",
  find_imports: "Buscando importadores del módulo...",
  check_types: "Verificando tipos TypeScript...",
  run_script: "Ejecutando script...",
  code_test_parallel: "Ejecutando tests en paralelo...",
  code_diff_create: "Generando diff...",
  git_blame: "Consultando autoría del código...",
  git_create_pr: "Creando Pull Request...",
  git_rollback: "Revirtiendo cambios...",
  // Narrative
  read_narrative: "Leyendo narrativa de la tarea...",
  append_narrative: "Documentando progreso...",
  search_narrative: "Buscando en historial...",
  read_decisions: "Consultando decisiones arquitecturales...",
  write_decision: "Guardando decisión arquitectural...",
  get_task_context: "Cargando contexto de la tarea...",
  // Agents
  spawn_agent: "Creando subagente...",
  get_available_models: "Consultando modelos disponibles...",
  // API
  api_request: "Realizando petición HTTP...",
}

export function getNarration(toolName: string): string {
  if (TOOL_NARRATIONS[toolName]) return TOOL_NARRATIONS[toolName]
  // Prefix matching for MCP tools like "github__create_pr" → "Ejecutando github..."
  const prefix = toolName.split("__")[0]
  if (prefix && prefix !== toolName) return `Ejecutando ${prefix}...`
  // Fallback
  return `Ejecutando ${toolName.replace(/_/g, " ")}...`
}
