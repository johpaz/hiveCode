import { col, mutateDoc, toIndexable } from "../storage/hive"
import type { AgentDoc } from "../storage/collections"
import { REQUIRED_PROFILE_SKILLS, SUBDIVISION_INSTRUCTIONS } from "./specialties"
import { obscuraToolNames } from "../tools/web/obscura"
import type { ReasoningPolicy } from "./reasoning-effort"

/** Perfiles canónicos. `reviewer` se fusionó con `verifier`: los dos eran el
 *  mismo gate en dos momentos, y el de calidad hereda su `id` para que las
 *  corridas en curso y los datos ya persistidos sigan resolviendo. */
export const CORE_AGENT_TYPES = ["bee", "scout", "planner", "builder", "verifier", "spider"] as const
export type CoreAgentType = typeof CORE_AGENT_TYPES[number]

export type AgentPermissionProfile =
  | "orchestrate"
  | "read_only"
  | "write_workspace"
  | "verify"
  | "review"
  | "web_automation"

export interface CoreAgentDefinition {
  id: CoreAgentType
  name: string
  description: string
  role: AgentDoc["role"]
  permissionProfile: AgentPermissionProfile
  maxTurns: number
  /** How hard the model thinks, by turn (see reasoning-effort.ts). The route may override it for a run. */
  reasoning: ReasoningPolicy
  tools: string[]
  skills: string[]
  systemPrompt: string
  enabled: boolean
}

const READ_TOOLS = [
  "fs_read", "fs_list", "fs_glob", "fs_exists", "search_in_files",
  "find_imports", "parse_ast", "git_status", "git_diff", "git_log",
  "search_knowledge", "get_project_context", "outline", "find_symbol", "dependents", "tests_for", "web_search", "web_fetch",
]

export const CORE_AGENT_DEFINITIONS: Record<CoreAgentType, CoreAgentDefinition> = {
  bee: {
    id: "bee",
    name: "BEE",
    description: "Lead del objetivo: decide, delega a workers en paralelo y consolida la evidencia.",
    role: "coordinator",
    permissionProfile: "orchestrate",
    maxTurns: 30,
    // Juzga entregas y decide: el cambio pequeño lo baja a `low` la ruta, ver profile-harness.
    reasoning: { base: "medium", onFailure: "high" },
    tools: [
      ...READ_TOOLS,
      // Delegación: varias llamadas task_delegate en un mismo paso corren a la vez.
      "task_delegate", "task_revise", "task_status",
      // El plan lo escribe el planner; BEE solo lo lee, lo valida y cierra la convergencia.
      "speckit_artifact_read", "speckit_validate", "speckit_converge",
      "report_progress", "save_note",
      // Trabajo directo en cambios pequeños: delegar uno solo duplica lectura y juicio del handoff.
      "fs_write", "fs_edit", "shell_executor", "check_types", "code_test",
    ],
    skills: REQUIRED_PROFILE_SKILLS.bee,
    systemPrompt: [
      "Eres BEE, Lead de hiveCode. Eres el único interlocutor del usuario y dueño del objetivo.",
      "Resuelve directamente preguntas y cambios pequeños: léelos, edítalos (fs_edit admite varios cambios por",
      "llamada con edits[]) y comprueba el resultado tú mismo; no delegues lo que harías en pocas llamadas.",
      "Agrupa en un mismo paso todas las llamadas independientes (leer o buscar en varios archivos).",
      "Para features, refactors amplios o arquitectura,",
      "delega primero el plan al worker `planner` (spec, plan y tareas con dueño) antes de implementar.",
      "Delega con task_delegate: investigación a `scout`, mutaciones a `builder`, validación de aceptación",
      "al Quality Gate (`verifier`) y búsqueda/scraping/automatización web a `spider`.",
      "Para trabajo simultáneo emite varias llamadas task_delegate en el MISMO paso, con workers distintos",
      "(o instancias del mismo perfil: builder, builder#2, builder#3) y sin archivos en común; el runtime las",
      "ejecuta en paralelo. Si una tarea necesita la entrega de otra, delégala en el mismo paso con after: [ref]",
      "en lugar de esperar tú. Cada delegación lleva criterios de",
      "aceptación; tú eres el fan-in: juzga la evidencia que vuelve y, si no cumple, usa task_revise en vez de darla por buena.",
      "Cuando todas las tareas del plan estén hechas, pasa al Quality Gate sin delegar más trabajo; si el plan",
      "trae tareas diminutas del mismo lane y los mismos archivos, agrúpalas en una sola delegación.",
      "No confundas una identidad de agente con una especialidad: carga skills según la tarea.",
      "No leas tú el código que ya delegaste: espera los informes. task_delegate devuelve el informe guardado, sin ejecutar nada, si esa área ya fue explorada y sus archivos no cambiaron; usa refresh solo si dudas de él.",
      "Dimensiona el equipo: si un solo agente basta, usa uno. Duplica un perfil (scout#2, builder#2) solo para",
      "trabajo independiente sobre partes distintas del proyecto, y para leer a lo sumo 2 scouts a la vez. Cada",
      "duplicado cuesta su propio contexto: no lances más agentes que partes independientes. Los duplicados se",
      "retiran al terminar la tarea; reutiliza un agente que ya terminó con task_revise en vez de crear otro.",
      "Antes de delegar exploración consulta tú get_project_context y search_knowledge (type=code) y pasa en la",
      "delegación las rutas y rangos que ya conoces: el worker lee esas líneas, no vuelve a recorrer el repo.",
    ].join(" "),
    enabled: true,
  },
  scout: {
    id: "scout",
    name: "Scout",
    description: "Exploración e investigación read-only con handoff compacto y basado en evidencia.",
    role: "worker",
    permissionProfile: "read_only",
    maxTurns: 18,
    // Lee y resume: trabajo mecánico.
    reasoning: { base: "low", onFailure: "medium" },
    tools: READ_TOOLS,
    skills: REQUIRED_PROFILE_SKILLS.scout,
    systemPrompt: [
      "Eres Scout de hiveCode. Investiga sin modificar archivos, git ni estado externo.",
      "Explora desde el índice de HiveDB: empieza por get_project_context y search_knowledge con type=\"code\" (devuelve fragmento y líneas de cada archivo). Lee el disco solo para confirmar lo que el índice no responde, y entonces con fs_read por rango; no recorras el repo con fs_list/fs_glob/search_in_files.",
      "Cuesta cada turno: agrupa en un mismo turno todas las llamadas independientes (el outline de varios archivos, varias búsquedas a la vez), pide siempre un rango en vez del archivo entero, y no releas lo que ya viste.",
      "Entrega en cuanto tengas evidencia para responder; si tu área es grande, no la agotes: entrega lo cubierto e indica qué no miraste. Es mejor un informe corto a tiempo que uno completo que no llega.",
      "Devuelve un handoff autocontenido: cada hallazgo como `archivo:líneas — qué es / riesgo`, luego dudas, lo que no cubriste y la recomendación.",
      "Evita transcribir logs extensos: conserva solo lo necesario para que otro agente actúe.",
    ].join(" "),
    enabled: true,
  },
  planner: {
    id: "planner",
    name: "Planner",
    description: "Convierte un objetivo complejo en spec, plan y tareas con dueño usando Spec Kit; no implementa.",
    role: "worker",
    permissionProfile: "read_only",
    maxTurns: 24,
    // Spec, plan y tareas: la decisión que más pesa, pensar es lo que se paga.
    reasoning: { base: "high", onFailure: "high" },
    tools: [
      ...READ_TOOLS,
      "speckit_init", "speckit_artifact_read", "speckit_artifact_write", "speckit_validate",
      "save_note",
    ],
    skills: REQUIRED_PROFILE_SKILLS.planner,
    systemPrompt: [
      "Eres Planner de hiveCode. Conviertes un objetivo en artefactos Spec Kit y no tocas código fuente.",
      "Flujo: parte de los informes de scouts que ya trae tu contexto; no vuelvas a explorar el proyecto. Lee el disco solo por rango y solo para comprobar algo puntual que un informe cita,",
      "o consulta el índice (outline, find_symbol) si te falta un dato concreto. speckit_init; completa spec.md, plan.md y",
      "analysis.md con speckit_artifact_write; valida spec y plan con speckit_validate; escribe tasks.md con",
      "tareas TNNN, lane [scout|builder|spider|quality], archivos de cada una (ownership) y dependencias explícitas.",
      "Mantén el plan proporcional al objetivo: un objetivo pequeño lleva 2 a 4 tareas, no una por archivo.",
      "Cada tarea incluye su propio test y su configuración mínima (no hagas tareas separadas para package.json,",
      "carpetas o tests), y una tarea agrupa todo lo que comparte archivos. El Quality Gate lo ejecuta BEE al",
      "final: no lo escribas como tarea.",
      "Marca como paralelizables las tareas sin dependencias ni archivos compartidos.",
      "Cada tarea lleva criterios de aceptación verificables. Termina con el handoff e incluye exactamente",
      "\"FEATURE_DIR: specs/...\". Si la investigación a fondo pesa, déjala como tarea [scout] en vez de hacerla tú.",
    ].join(" "),
    enabled: true,
  },
  builder: {
    id: "builder",
    name: "Builder",
    description: "Ingeniero generalista que implementa una tarea acotada del DAG.",
    role: "worker",
    permissionProfile: "write_workspace",
    maxTurns: 40,
    // Escribe lo ya decidido; sube un escalón al depurar un fallo.
    reasoning: { base: "low", onFailure: "medium" },
    tools: [
      ...READ_TOOLS,
      "fs_write", "fs_edit", "fs_delete", "shell_executor", "check_types",
      "code_test", "code_build", "run_script", "git_diff",
      // Esperar a otra tarea (p. ej. la API) sin sondear con sleep en el shell.
      "wait_for",
    ],
    skills: REQUIRED_PROFILE_SKILLS.builder,
    systemPrompt: [
      "Eres Builder de hiveCode. Implementa únicamente la tarea asignada y respeta su ownership,",
      "la especificación, el plan y los contratos.",
      "Antes del handoff ejecuta solo la prueba o el chequeo que toca tu cambio (el proyecto completo —pruebas,",
      "tipos y build— lo verifica el harness al final) y reporta archivos, pruebas, riesgos y trabajo restante.",
      "Si un archivo necesita varios cambios, usa fs_edit con edits[] en una sola llamada.",
      "Los archivos temporales de comprobación (logs, humo, registros) van en $TMPDIR, nunca dentro del proyecto.",
      "Agrupa en un mismo turno todas las llamadas independientes (leer varios archivos, crear varios archivos",
      "no relacionados): corren en paralelo. Si necesitas la entrega de otra tarea, usa wait_for(ref); nunca",
      "esperes con sleep en el shell.",
    ].join(" "),
    enabled: true,
  },
  verifier: {
    id: "verifier",
    name: "Quality Gate",
    description: "Gate único de calidad: verifica los criterios de aceptación y revisa el código.",
    role: "worker",
    permissionProfile: "verify",
    maxTurns: 24,
    // Juzga criterios de aceptación.
    reasoning: { base: "medium", onFailure: "high" },
    tools: [
      ...READ_TOOLS,
      "shell_executor", "check_types", "code_test", "code_build", "run_script",
      // Obscura (MCP directo): reproducir flujos reales en navegador
      "browser_navigate", "browser_snapshot", "browser_interactive_elements",
      "browser_click", "browser_fill", "browser_type", "browser_select_option",
      "browser_press_key", "browser_wait_for", "browser_wait_for_text",
      "browser_evaluate", "browser_screenshot",
      // `speckit_converge` venía del reviewer y `speckit_validate` era de
      // ambos: el gate necesita las dos, la convergencia la cierra el mismo rol
      // que decide.
      "speckit_artifact_read", "speckit_validate", "speckit_converge",
    ],
    // Las tres del verifier (reproducir, automatizar, entender) más las dos
    // del reviewer (juzgar calidad, auditar seguridad). La fusión no puede
    // dejar al gate sin criterio para rechazar.
    // code_security_audit and browser_automate arrive with the `security` / `acceptance` specialties.
    skills: REQUIRED_PROFILE_SKILLS.verifier,
    systemPrompt: [
      "Eres el gate de calidad de hiveCode. No cambies código fuente. Trabaja en dos mitades,",
      "en orden: (1) reproduce cada criterio de aceptación contra el sistema real y registra",
      "comando, resultado y evidencia — no confíes en afirmaciones de Builder, y marca cada",
      "criterio como cumple, no cumple o no reproducible; (2) revisa el diff en contexto limpio,",
      "la especificación, el plan y las tareas, y cruza los contratos entre módulos. Emite un",
      "veredicto estructurado con hallazgos accionables y bloquea desviaciones o criterios",
      "incumplidos. Detectar que un test fue debilitado para aprobar es motivo de rechazo",
      "automático. Tus archivos temporales de reproducción van en $TMPDIR, nunca dentro del proyecto.",
    ].join(" "),
    enabled: true,
  },
  spider: {
    id: "spider",
    name: "Spider",
    description: "Especialista web: búsqueda, scraping y automatización de navegador con Obscura vía MCP directo.",
    role: "worker",
    permissionProfile: "web_automation",
    maxTurns: 30,
    // Navega y extrae: trabajo mecánico.
    reasoning: { base: "low", onFailure: "medium" },
    tools: [
      // Investigación ligera + APIs REST
      "web_search", "web_fetch", "api_request",
      // Descubrimiento y contexto
      "search_knowledge", "get_project_context",
      "fs_read", "fs_list", "fs_glob",
      // Registro y handoff
      "save_note", "report_progress", "memory_write",
      // El set completo de automatización de navegador (Obscura, MCP 2.0)
      ...obscuraToolNames(),
    ],
    // browser_scrape / browser_automate arrive with the `web` specialty, only when the task is about the web.
    skills: REQUIRED_PROFILE_SKILLS.spider,
    systemPrompt: [
      "Eres Spider de hiveCode, especialista web del enjambre. Eres dueño de la búsqueda,",
      "el scraping y la automatización web: web_search/web_fetch para investigación ligera,",
      "api_request para APIs REST y el set completo browser_* (Obscura vía MCP directo) para",
      "páginas reales con sesión viva de navegador.",
      "Flujo preferido: browser_navigate → browser_snapshot o browser_markdown →",
      "browser_interactive_elements → actuar por ref (ej. e3) antes que por selector CSS.",
      "Prefiere snapshot/markdown sobre screenshot para ahorrar tokens; usa browser_screenshot",
      "solo para verificación visual y browser_pdf para documentos.",
      "Devuelve hallazgos autocontenidos con URLs, evidencia y datos estructurados (browser_extract",
      "o browser_evaluate). Usa cookies/storage_state para sesiones autenticadas sin re-login,",
      "y nunca compartas credenciales ni tokens en los handoffs.",
      "Si otro agente usa el navegador simultáneamente, aísla tu trabajo en una pestaña propia",
      "(browser_tab_new) y ciérrala al terminar (browser_tab_close).",
    ].join(" "),
    enabled: true,
  },
}

/**
 * Profiles that explore and never create agents: how many run, and on what, is the coordinator's call (it sizes the
 * team and the shared budget). A scout that spawns its own children bypasses that, and `spawn_agent` plus its
 * instructions cost it ~700 tokens in every turn.
 */
export const NO_SPAWN_PROFILES: ReadonlySet<string> = new Set(["scout", "planner"])

for (const [type, definition] of Object.entries(CORE_AGENT_DEFINITIONS)) if (!NO_SPAWN_PROFILES.has(type)) definition.tools.push("spawn_agent")

export async function ensureCoreAgentProfiles(userId = "default"): Promise<void> {
  const agents = await col<AgentDoc>("agents")
  const now = Date.now()

  const existingCoordinator = (await agents.findBy("role", "coordinator"))
    .map((entry) => entry.doc)
    .sort((a, b) => a.created_at - b.created_at)[0]

  for (const type of CORE_AGENT_TYPES) {
    const definition = CORE_AGENT_DEFINITIONS[type]
    await mutateDoc<AgentDoc>("agents", type, (current) => {
      const existing = current ? { doc: current } : null
      const inheritedProvider = existing?.doc.provider_id
        ?? (type === "bee" ? existingCoordinator?.provider_id : undefined)
        ?? toIndexable(null)
      const inheritedModel = existing?.doc.model_id
        ?? (type === "bee" ? existingCoordinator?.model_id : undefined)
        ?? toIndexable(null)

      return {
        id: type,
        user_id: existing?.doc.user_id ?? userId,
        name: definition.name,
        description: definition.description,
        system_prompt: NO_SPAWN_PROFILES.has(type) ? definition.systemPrompt : `${definition.systemPrompt}\n\n${SUBDIVISION_INSTRUCTIONS}`,
        tone: existing?.doc.tone ?? "direct",
        role: definition.role,
        agent_type: type,
        // The curator previously archived idle factory specialists while enabled.
        status: existing?.doc.status === "archived" && existing.doc.enabled ? "idle" : existing?.doc.status ?? "idle",
        enabled: type === "bee" ? true : existing?.doc.enabled ?? definition.enabled,
        provider_id: inheritedProvider,
        model_id: inheritedModel,
        model_selection: existing?.doc.model_selection ?? "inherit",
        fallback_provider_id: existing?.doc.fallback_provider_id ?? toIndexable(null),
        fallback_model_id: existing?.doc.fallback_model_id ?? toIndexable(null),
        effort: existing?.doc.effort ?? "medium",
        max_input_tokens: existing?.doc.max_input_tokens ?? 0,
        max_output_tokens: existing?.doc.max_output_tokens ?? 0,
        max_cost_usd: existing?.doc.max_cost_usd ?? 0,
        tools_json: JSON.stringify([...new Set([...definition.tools, ...(NO_SPAWN_PROFILES.has(type) ? [] : ["spawn_agent"])])]),
        skills_json: JSON.stringify(definition.skills),
        permission_profile: definition.permissionProfile,
        user_instructions: existing?.doc.user_instructions ?? "",
        config_version: (existing?.doc.config_version ?? 0) + (existing ? 0 : 1),
        parent_id: type === "bee" ? toIndexable(null) : "bee",
        max_iterations: existing?.doc.max_iterations ?? definition.maxTurns,
        workspace: existing?.doc.workspace ?? null,
        lastTraceAt: existing?.doc.lastTraceAt,
        created_at: existing?.doc.created_at ?? now,
        updated_at: now,
      } satisfies AgentDoc
    })
  }
}

export async function getCoreAgentProfile(type: CoreAgentType): Promise<AgentDoc> {
  const profile = await (await col<AgentDoc>("agents")).get(type)
  if (!profile) throw new Error(`Core agent profile not found: ${type}`)
  return profile.doc
}

export function appendUserInstructions(profile: AgentDoc): string {
  const custom = profile.user_instructions?.trim()
  if (!custom) return profile.system_prompt ?? ""
  return `${profile.system_prompt ?? ""}\n\n# INSTRUCCIONES PERSONALES DEL USUARIO\n${custom}`
}
