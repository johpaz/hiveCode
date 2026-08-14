import { col, toIndexable } from "../storage/hive"
import type { AgentDoc } from "../storage/collections"

export const CORE_AGENT_TYPES = ["bee", "scout", "builder", "verifier", "reviewer"] as const
export type CoreAgentType = typeof CORE_AGENT_TYPES[number]

export type AgentPermissionProfile =
  | "orchestrate"
  | "read_only"
  | "write_workspace"
  | "verify"
  | "review"

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
      "mutaciones a Builder, validación de aceptación a Verifier y el gate final a Reviewer.",
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
    name: "Verifier",
    description: "Reproduce criterios de aceptación contra el sistema real y aporta evidencia.",
    role: "worker",
    permissionProfile: "verify",
    maxTurns: 24,
    tools: [
      ...READ_TOOLS,
      "shell_executor", "check_types", "code_test", "code_build", "run_script",
      "browser_navigate", "browser_click", "browser_type", "browser_screenshot",
      "speckit_artifact_read", "speckit_validate",
    ],
    skills: ["test_driven_development", "browser_automate", "code_analysis"],
    systemPrompt: [
      "Eres Verifier de hiveCode. No cambies código fuente. Reproduce cada criterio de aceptación",
      "contra el sistema real y registra comando, resultado y evidencia. No confíes en afirmaciones",
      "de Builder; marca cada criterio como cumple, no cumple o no reproducible.",
    ].join(" "),
    enabled: true,
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    description: "Gate independiente de calidad, seguridad, contratos y alineación con la spec.",
    role: "worker",
    permissionProfile: "review",
    maxTurns: 24,
    tools: [
      ...READ_TOOLS,
      "check_types", "code_test", "code_build",
      "speckit_artifact_read", "speckit_validate", "speckit_converge",
    ],
    skills: ["code_review", "code_security_audit", "code_analysis"],
    systemPrompt: [
      "Eres Reviewer de hiveCode. No modifiques código. Revisa el diff en contexto limpio,",
      "la especificación, el plan, las tareas y la evidencia del Verifier. Emite un veredicto",
      "estructurado con hallazgos accionables y bloquea desviaciones o criterios incumplidos.",
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
    const existing = await agents.get(type)
    const inheritedProvider = existing?.doc.provider_id
      ?? (type === "bee" ? existingCoordinator?.provider_id : undefined)
      ?? toIndexable(null)
    const inheritedModel = existing?.doc.model_id
      ?? (type === "bee" ? existingCoordinator?.model_id : undefined)
      ?? toIndexable(null)

    const doc: AgentDoc = {
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
    }

    if (existing) {
      await agents.put(type, doc, { expectedVersion: existing.version })
    } else {
      await agents.put(type, doc, { expectedVersion: 0 })
    }
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
