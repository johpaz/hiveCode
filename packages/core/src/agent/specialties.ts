export interface Specialty {
  id: string
  owner: string
  description: string
  skills: string[]
  instructions: string
  match: RegExp
}
/** Specialties are loadouts, not additional resident agents. */
export const FACTORY_SPECIALTIES: Specialty[] = [
  { id: "backend", owner: "builder", description: "Servicios, APIs y lógica de negocio", skills: ["code_generate", "code_debug"], instructions: "Define contratos de entrada/salida, valida errores y prueba el servicio real. Modifica únicamente los archivos asignados.", match: /backend|endpoint|api\b|servicio|service|autentic|auth/i },
  { id: "frontend", owner: "builder", description: "Interfaces, interacción y accesibilidad", skills: ["code_generate"], instructions: "Respeta contratos del backend; verifica estados de carga, error y accesibilidad. Usa navegador cuando esté autorizado; para TUI verifica tamaños, entrada y renderizado real.", match: /frontend|interfaz|interface|react|pantalla|tui|accesibilidad/i },
  { id: "data", owner: "builder", description: "Esquemas, consultas y persistencia", skills: ["code_analysis", "code_generate"], instructions: "Verifica compatibilidad de esquemas, idempotencia y consistencia. Prueba migraciones y consultas con fixtures; conserva la evidencia.", match: /database|sql|datos|schema|esquema|persist|migraci|hivedb/i },
  { id: "devops", owner: "builder", description: "CI, entorno y empaquetado", skills: ["cli_safe_exec", "cli_pipeline"], instructions: "Reproduce build y entorno; prepara entrega con comandos verificables. Mantén los límites de ejecución y permisos del responsable.", match: /devops|docker|pipeline|deploy|desplieg|empaquet|\bci\b/i },
  { id: "integration", owner: "builder", description: "Cambios pequeños e integración transversal", skills: ["code_refactor"], instructions: "Resuelve directamente cambios pequeños. Coordina contratos entre módulos y evita subdividir trabajo que comparte archivos.", match: /integraci|integration|refactor/i },
  { id: "architecture", owner: "planner", description: "Requisitos, contratos y dependencias", skills: [], instructions: "Define aceptación, ownership y dependencias. Divide por resultados verificables; no por cantidad de archivos.", match: /./ },
  { id: "repository", owner: "scout", description: "Investigación del repositorio", skills: [], instructions: "Busca símbolos y dependencias antes de leer archivos completos. Entrega rangos y referencias frescas, con incógnitas explícitas.", match: /./ },
  { id: "security", owner: "verifier", description: "Auditoría independiente", skills: ["code_security_audit"], instructions: "Audita permisos, secretos y límites de confianza; no modifiques código fuente. Entrega hallazgos reproducibles al responsable.", match: /seguridad|security|vulnerab|owasp|permiso|secret/i },
  { id: "acceptance", owner: "verifier", description: "Aceptación y pruebas reales", skills: ["browser_automate"], instructions: "Reproduce criterios de aceptación y registra comando, resultado y evidencia. Mantén un único veredicto aunque uses subagentes.", match: /./ },
  { id: "web", owner: "spider", description: "Fuentes externas, APIs y navegador", skills: ["browser_scrape", "browser_automate"], instructions: "Investiga fuentes externas por pregunta concreta. Si compartes navegador, crea una pestaña propia y ciérrala al terminar. Prefiere texto y referencias; usa capturas cuando sean necesarias para verificar aspectos visuales.", match: /./ },
]
export function selectSpecialty(owner: string | undefined, task: string, requested?: string): Specialty | undefined {
  if (requested) {
    const specialty = FACTORY_SPECIALTIES.find(item => item.id === requested && item.owner === owner)
    if (!specialty) throw new Error(`Specialty ${requested} is not available to ${owner ?? "this agent"}`)
    return specialty
  }
  const specialty = FACTORY_SPECIALTIES.find(item => item.owner === owner && item.match.test(task))
    ?? FACTORY_SPECIALTIES.find(item => item.owner === owner && item.id === "integration")
  if (specialty?.id === "acceptance" && !/browser|navegador|frontend|interfaz|pantalla|web|tui/i.test(task)) return {...specialty, skills: []}
  if (specialty?.id === "web" && !/browser|navegador|scrap|automat|session|sesión|login/i.test(task)) return {...specialty, skills: []}
  return specialty
}
export const REQUIRED_PROFILE_SKILLS: Record<string, string[]> = {
  bee: ["task_orchestrator", "busqueda_hivedb", "spec-kit"],
  planner: ["spec-kit", "code_analysis", "busqueda_hivedb"],
  scout: ["file_read_and_summarize", "code_analysis", "busqueda_hivedb"],
  builder: ["test_driven_development", "git_workflow", "busqueda_hivedb"],
  verifier: ["test_driven_development", "code_review", "code_analysis"],
  spider: ["web_research", "busqueda_hivedb"],
}
export const SUBDIVISION_INSTRUCTIONS = `Puedes crear subagentes con spawn_agent cuando una especialidad, un contexto demasiado grande o una subtarea independiente lo justifique. No es obligatorio: resuelve directamente lo pequeño. Da a cada subagente objetivo, aceptación, archivos asignados, especialidad y referencias de contexto; no copies toda la conversación. Solo hereda tools y skills autorizadas. Revisa e integra su resultado antes de entregar. Un subagente temporal no puede crear otra generación. Usa get_project_context(scope="task", query=..., paths=...) para ampliar evidencia faltante, no para repetir el mapa global.`
