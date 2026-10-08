import { col, mutateDoc, toIndexable } from "../storage/hive"
import type { AgentDoc } from "../storage/collections"
import { obscuraToolNames } from "../tools/web/obscura"

/** Perfiles canónicos. `reviewer` se fusionó con `verifier`: los dos eran el
 *  mismo gate en dos momentos, y el de calidad hereda su `id` para que las
 *  corridas en curso y los datos ya persistidos sigan resolviendo. */
export const CORE_AGENT_TYPES = ["bee", "scout", "builder", "verifier", "spider"] as const
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
  tools: string[]
  skills: string[]
  systemPrompt: string
  enabled: boolean
}

const READ_TOOLS = [
  "fs_read", "fs_list", "fs_glob", "fs_exists", "search_in_files",
  "find_imports", "parse_ast", "git_status", "git_diff", "git_log",
  "search_knowledge", "get_project_context", "web_search", "web_fetch",
]

export const CORE_AGENT_DEFINITIONS: Record<CoreAgentType, CoreAgentDefinition> = {
  bee: {
    id: "bee",
    name: "BEE",
    description: "Lead y orquestador del objetivo, los artefactos y el DAG de ejecución.",
    role: "coordinator",
    permissionProfile: "orchestrate",
    maxTurns: 30,
    tools: [
      ...READ_TOOLS,
      "speckit_init", "speckit_artifact_read", "speckit_artifact_write",
      "speckit_validate", "speckit_tasks_sync", "speckit_converge",
      "report_progress", "save_note",
    ],
    skills: ["spec-kit", "task_orchestrator", "busqueda_hivedb"],
    systemPrompt: [
      "Eres BEE, Lead de hiveCode. Eres el único interlocutor del usuario y dueño del objetivo.",
      "Resuelve directamente preguntas y cambios pequeños. Para features, refactors amplios o arquitectura,",
      "activa obligatoriamente la skill spec-kit antes de implementar. Delega investigación a Scout,",
      "mutaciones a Builder, validación de aceptación a Verifier, el gate final a Reviewer",
      "y búsqueda/scraping/automatización web a Spider.",
      "No confundas una identidad de agente con una especialidad: carga skills según la tarea.",
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
    tools: READ_TOOLS,
    skills: ["file_manager", "file_read_and_summarize", "code_analysis", "web_research"],
    systemPrompt: [
      "Eres Scout de hiveCode. Investiga sin modificar archivos, git ni estado externo.",
      "Devuelve un handoff autocontenido con evidencia, rutas, riesgos, dudas y recomendación.",
      "Evita transcribir logs extensos: conserva solo lo necesario para que otro agente actúe.",
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
    tools: [
      ...READ_TOOLS,
      "fs_write", "fs_edit", "fs_delete", "shell_executor", "check_types",
      "code_test", "code_build", "run_script", "git_diff",
    ],
    skills: ["test_driven_development", "git_workflow", "busqueda_hivedb"],
    systemPrompt: [
      "Eres Builder de hiveCode. Implementa únicamente la tarea asignada y respeta su ownership,",
      "la especificación, el plan y los contratos. Descubre skills de dominio bajo demanda.",
      "Verifica tu trabajo antes del handoff y reporta archivos, pruebas, riesgos y trabajo restante.",
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
    skills: [
      "test_driven_development", "browser_automate", "code_analysis",
      "code_review", "code_security_audit",
    ],
    systemPrompt: [
      "Eres el gate de calidad de hiveCode. No cambies código fuente. Trabaja en dos mitades,",
      "en orden: (1) reproduce cada criterio de aceptación contra el sistema real y registra",
      "comando, resultado y evidencia — no confíes en afirmaciones de Builder, y marca cada",
      "criterio como cumple, no cumple o no reproducible; (2) revisa el diff en contexto limpio,",
      "la especificación, el plan y las tareas, y cruza los contratos entre módulos. Emite un",
      "veredicto estructurado con hallazgos accionables y bloquea desviaciones o criterios",
      "incumplidos. Detectar que un test fue debilitado para aprobar es motivo de rechazo",
      "automático.",
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
    skills: ["web_research", "browser_automate", "browser_scrape", "web_monitor"],
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
        system_prompt: definition.systemPrompt,
        tone: existing?.doc.tone ?? "direct",
        role: definition.role,
        agent_type: type,
        status: existing?.doc.status ?? "idle",
        enabled: type === "bee" ? true : existing?.doc.enabled ?? definition.enabled,
        provider_id: inheritedProvider,
        model_id: inheritedModel,
        fallback_provider_id: existing?.doc.fallback_provider_id ?? toIndexable(null),
        fallback_model_id: existing?.doc.fallback_model_id ?? toIndexable(null),
        effort: existing?.doc.effort ?? "medium",
        max_input_tokens: existing?.doc.max_input_tokens ?? 0,
        max_output_tokens: existing?.doc.max_output_tokens ?? 0,
        max_cost_usd: existing?.doc.max_cost_usd ?? 0,
        tools_json: JSON.stringify(definition.tools),
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
