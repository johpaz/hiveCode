/**
 * What makes a tool relevant to a task, written once and indexed with the tool.
 *
 * Skills carry `triggers` in the database; tools did not, so nothing could say "this task is about a browser, bring
 * the browser tools". These triggers go to the capability index as tags (tool-selector.ts) and are matched against
 * the task text by `computeLoadout` before a turn, so the choice costs no model turn.
 *
 * A trigger is a lowercase fragment of the task text, in Spanish or English.
 */

export interface ToolMeta {
  triggers: string[]
}

interface Group {
  /** Tools the group applies to: exact names, or a `prefix_` for a family. */
  tools: string[]
  triggers: string[]
}

const GROUPS: Group[] = [
  { tools: ["browser_"], triggers: ["navegador", "browser", "página web", "pagina web", "interfaz", "pantalla", "captura", "screenshot", "clic", "click", "formulario", "e2e", "ui ", "scrap", "login", "sesión web", "aceptación visual"] },
  { tools: ["web_search", "web_fetch"], triggers: ["internet", "en la web", "web search", "busca en la web", "documentación oficial", "official docs", "url", "https://", "http://", "investiga en", "noticias", "paper"] },
  { tools: ["api_request"], triggers: ["api", "endpoint", "rest", "webhook", "petición http", "http request", "curl", "json de"] },
  { tools: ["git_status", "git_diff", "git_log", "git_commit", "git_branch", "git_blame", "git_create_pr", "git_rollback"], triggers: ["git", "commit", "rama", "branch", "historial", "diff", "merge", "pull request", "pr ", "revert"] },
  { tools: ["code_build"], triggers: ["compila", "build", "empaqueta", "bundle", "binario", "release"] },
  { tools: ["run_script"], triggers: ["script", "migración", "migracion", "migration", "seed", "ejecuta el archivo"] },
  { tools: ["speckit_init", "speckit_artifact_read", "speckit_artifact_write", "speckit_validate", "speckit_tasks_sync", "speckit_converge"], triggers: ["especificación", "especificacion", "spec", "plan de", "planifica", "planea", "roadmap", "arquitectura", "tareas del plan", "speckit", "diseña"] },
  { tools: ["fs_delete"], triggers: ["borra", "elimina el archivo", "delete", "remove the file", "limpia los archivos"] },
  { tools: ["fs_list", "fs_glob"], triggers: ["lista los archivos", "list files", "estructura de carpetas", "qué archivos", "which files", "glob", "árbol de"] },
  { tools: ["parse_ast", "find_imports"], triggers: ["ast", "árbol sintáctico", "complejidad", "imports", "quién importa"] },
  { tools: ["memory_write", "memory_read", "memory_search"], triggers: ["recuerda", "memoria", "remember", "memory", "la última vez"] },
  { tools: ["spawn_agent"], triggers: ["subagente", "sub-agente", "en paralelo", "subagent", "delega en un agente temporal"] },
  { tools: ["wait_for"], triggers: ["espera a que", "depende de", "after", "cuando termine"] },
]

const exact = new Map<string, string[]>()
const families: Array<{ prefix: string; triggers: string[] }> = []
for (const group of GROUPS) {
  for (const name of group.tools) {
    if (name.endsWith("_")) families.push({ prefix: name, triggers: group.triggers })
    else exact.set(name, [...(exact.get(name) ?? []), ...group.triggers])
  }
}

/** The triggers of a tool: its own, plus those of its family (`browser_*`). Empty for tools every role already starts with. */
export function toolTriggers(name: string): string[] {
  return [...new Set([...(exact.get(name) ?? []), ...families.filter(f => name.startsWith(f.prefix)).flatMap(f => f.triggers)])]
}

/** Tools whose triggers appear in `text`, among `candidates`. */
export function toolsTriggeredBy(text: string, candidates: Iterable<string>): string[] {
  const lower = text.toLowerCase()
  return [...candidates].filter(name => toolTriggers(name).some(trigger => lower.includes(trigger)))
}
