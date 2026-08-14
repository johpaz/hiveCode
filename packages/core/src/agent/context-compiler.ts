/**
 * Context Compiler — Implementa las 4 estrategias de Context Engineering:
 * 
 * 1. ESCRIBIR (Write) — Guardar información fuera del contexto:
 *    - Scratchpad: notas persistentes por conversación
 *    - Trazas de ejecución: registro en traces table
 * 
 * 2. SELECCIONAR (Select) — Traer solo lo relevante:
 *    - Tool Loadout: máx 3-5 tools relevantes por turno
 *    - Playbook filtering: reglas ACE aplicables a esta tarea
 *    - Historial selectivo: resumen + mensajes recientes
 * 
 * 3. COMPRIMIR (Compress) — Reducir tokens manteniendo información:
 *    - Compaction: resumir mensajes viejos
 *    - Tool result clearing: reemplazar resultados antiguos por resúmenes
 * 
 * 4. AISLAR (Isolate) — Separar contextos por agente:
 *    - Cada worker recibe su propio contexto mínimo
 *    - El Coordinador ve el panorama completo
 * 
 * TODOS los datos se formatean en TOON para ahorro de tokens.
 */

import { logger } from "../utils/logger"
import type { LLMMessage, LLMToolDef, ContentPart } from "./llm-client"
import type { MCPClientManager } from "@johpaz/hivecode-mcp"
import { syncToolCatalogToIndex, mcpToolFullName } from "./tool-selector"
import { syncSkillsToIndex, getMinimalSkills, selectSkills, type SkillDescriptor } from "./skill-selector"
import { syncPlaybookToIndex } from "./playbook-selector"
import { getRecentMessages, getSummary, getScratchpad, toAPIMessages } from "./conversation-store"
import { formatContext, estimateTokens } from "../utils/toon"
import { buildSystemPromptWithProjects } from "./prompt-builder"
import { createAllTools } from "../tools/index"
import { getMCPManager as getSingletonMCPManager } from "../mcp/singleton"
import { syncMCPToolsToDB, syncMCPToolsToIndex } from "../mcp/tool-sync"
import { getUserDate, getUserTime } from "../utils/date"
import { col } from "../storage/hive"
import type { AgentDoc, CodePlaybookDoc, McpServerDoc, ProjectDoc, SkillDoc, TaskDoc } from "../storage/collections"

const log = logger.child("context-compiler")

// Configuration constants
const KEEP_LAST_N_MESSAGES = 40      // Always keep last N messages (Strategy: SELECT) — increased because tool calls/results are now persisted
const TOKEN_COMPACT_THRESHOLD = 6000 // Compact when exceeds this (Strategy: COMPRESS)

// MINIMAL TOOL SET — fixed always-available tools
// The agent discovers the rest via search_knowledge
const MINIMAL_TOOLS = new Set([
  "save_note",
  "notify",
  "report_progress",
  "search_knowledge",
])

// MINIMAL SKILL SET — fixed always-available skills
// These skills are ALWAYS in context - the agent uses them to discover everything else
//
// Only skills whose tools are actually in the loadout belong here. `memory_manager` used
// to be pinned but declares memory_write/memory_read/…, none of which are in
// MINIMAL_TOOLS — so it advertised capabilities the model did not have and pushed its
// note-taking intent onto save_note. It stays discoverable via search_knowledge, which
// its triggers already cover.
const MINIMAL_SKILL_NAMES = [
  "busqueda_hivedb", // Discovery central: tools, skills, MCP, playbook via search_knowledge
]

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return value.split(",").map(item => item.trim()).filter(Boolean)
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

// Simple tool interface for context compilation
export interface ContextTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute?: (params: Record<string, unknown>) => Promise<unknown>
}

export interface CompiledContext {
  systemPrompt: string
  messages: LLMMessage[]
  tools: LLMToolDef[]
  allTools: ContextTool[]
  skills: SkillDescriptor[]  // Skills loaded (minimal + discovered)
}

// ─── Main compiler ─────────────────────────────────────────────────────────

/**
 * Compile context for agent execution implementing 4 strategies:
 *   1. WRITE - Load scratchpad notes
 *   2. SELECT - Tool loadout, playbook rules, selective history
 *   3. COMPRESS - Use summaries, clear old tool results
 *   4. ISOLATE - Worker gets minimal context
 */
export async function compileContext(opts: {
  agentId: string
  threadId: string
  userId?: string
  userMessage: string | ContentPart[]
  channel?: string
  isolated?: boolean
  taskContext?: string | ContentPart[]
  mcpManager?: MCPClientManager | null
}): Promise<CompiledContext> {
  const { agentId, threadId, mcpManager, userMessage, isolated, taskContext } = opts

  // Fallback: Get MCP Manager from singleton if not provided
  const effectiveMcpManager = mcpManager ?? (() => {
    const singletonMcp = getSingletonMCPManager()
    if (singletonMcp) {
      log.info(`[context-compiler] Using MCP Manager from singleton`)
      return singletonMcp
    }
    return null
  })()

  // Resolve userId from database with priority: explicit param → channel identity → single user
  const userId = opts.userId || threadId || "default"

  // [STEP-1] Load agent config
  log.info(`[context-compiler] [STEP-1] Loading agent config for id=${agentId}`)
  let agent: AgentDoc | null
  try {
    agent = (await (await col<AgentDoc>("agents")).get(agentId))?.doc ?? null
  } catch (err) {
    log.error(`[context-compiler] [STEP-1] ❌ FAILED loading agent: ${JSON.stringify(err)}`)
    throw err
  }

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`)
  }

  const isWorker = agent.role === 'worker' || !!isolated
  log.info(`[context-compiler] [STEP-1] ✅ Compiling for ${isWorker ? 'worker' : 'coordinator'} agent=${agent.name}`)

  // [STEP-2] STRATEGY 1: WRITE — Load scratchpad (persistent notes)
  log.info(`[context-compiler] [STEP-2] Loading scratchpad...`)
  let scratchpadNotes: Awaited<ReturnType<typeof getScratchpad>> = []
  try {
    scratchpadNotes = await getScratchpad(threadId)
    log.info(`[context-compiler] [STEP-2] ✅ Loaded ${scratchpadNotes.length} scratchpad notes`)
  } catch (err) {
    log.error(`[context-compiler] [STEP-2] ❌ FAILED loading scratchpad: ${JSON.stringify(err)}`)
    throw err
  }

  // [STEP-3c] Load MCP tools (executors only — FTS sync happens here too)
  log.info(`[context-compiler] [STEP-3c] Loading MCP tools...`)
  const mcpToolExecutors: ContextTool[] = []

  if (effectiveMcpManager) {
    try {
      const mcpServers = await col<McpServerDoc>("mcpServers")
      const dbServers = (await mcpServers.findBy("enabled", true)).map((entry) => entry.doc)

      for (const server of dbServers) {
        // Try ID first (normalized), then name
        let serverTools = effectiveMcpManager.getServerTools(server.id)
        if (!serverTools || serverTools.length === 0) {
          serverTools = effectiveMcpManager.getServerTools(server.name)
        }

        if (serverTools && serverTools.length > 0) {
          log.info(`[context-compiler] [STEP-3c] Server ${server.name}: ${serverTools.length} tools`)

          for (const mcpTool of serverTools) {
            // Sanitized name valid for all LLM providers (no spaces, max 64 chars)
            const fullName = mcpToolFullName(server.name, mcpTool.name)

            // Executor for agent-loop (has the real call)
            mcpToolExecutors.push({
              name: fullName,
              description: mcpTool.description || `Tool from ${server.name}`,
              parameters: mcpTool.inputSchema || { type: "object", properties: {} },
              execute: async (params: Record<string, unknown>) => {
                // Return raw JS value — agent-loop will TOON-encode via formatToolResult.
                // Never pre-stringify here: formatToolResult(string) double-encodes.
                return await effectiveMcpManager.callTool(server.id, mcpTool.name, params)
              },
            })

          }
        } else {
          log.warn(`[context-compiler] [STEP-3c] Server ${server.name} has no tools (not connected yet)`)
        }
      }

      log.info(`[context-compiler] [STEP-3c] ✅ Loaded ${mcpToolExecutors.length} MCP tools`)

      // Persist MCP tool definitions to HiveDB for search_knowledge
      if (mcpToolExecutors.length > 0) {
        try {
          for (const server of dbServers) {
            let serverTools = effectiveMcpManager!.getServerTools(server.id)
            if (!serverTools || serverTools.length === 0) {
              serverTools = effectiveMcpManager!.getServerTools(server.name)
            }
            if (serverTools && serverTools.length > 0) {
              await syncMCPToolsToDB(server.id || server.name, server.name, serverTools)
            }
          }
          await syncMCPToolsToIndex();
          log.info(`[context-compiler] [STEP-3c] ✅ Persisted MCP tools to HiveDB`)
        } catch (syncErr) {
          log.warn(`[context-compiler] [STEP-3c] ⚠️ Failed to persist MCP tools to DB: ${(syncErr as Error).message}`)
        }
      }
    } catch (err) {
      log.error(`[context-compiler] [STEP-3c] ❌ Failed: ${(err as Error).message}`)
    }
  } else {
    log.info(`[context-compiler] [STEP-3c] ⚠️ No MCP manager, skipping MCP tools`)
  }

  // [STEP-4] Minimal tool set — agent discovers the rest via search_knowledge
  log.info(`[context-compiler] [STEP-4] Building minimal tool set`)

  // [STEP-8] Combine native tools + MCP executors loaded in STEP-3c
  const config = { tools: {} }
  const allNativeTools = createAllTools(config)
  const nativeTools: ContextTool[] = allNativeTools.map(t => ({
    name: t.name,
    description: t.description || "",
    parameters: t.parameters as any,
    execute: t.execute,
  }))

  // Core profiles use an immutable capability envelope. User configuration may
  // change model/budgets/instructions, but cannot silently grant more tools.
  const configuredToolNames = new Set(parseStringList(agent.tools_json))
  const isCoreProfile = !!agent.agent_type
  const allTools = isCoreProfile
    ? [...nativeTools, ...mcpToolExecutors].filter(tool => configuredToolNames.has(tool.name))
    : [...nativeTools, ...mcpToolExecutors]

  // Loadout policy, by role:
  //
  //  - BEE (coordinator): minimal set + Spec Kit. It orchestrates rather than works,
  //    and search_knowledge already covers discovery over tools, skills, MCP, playbook
  //    and project code. SDD is a mandatory planning contract, not optional discovery.
  //  - Other core profiles (scout/builder/verifier/reviewer): their own curated,
  //    permission-bounded envelope from agent-profiles.ts, in full. They are specialists;
  //    withholding their tools left them unable to act and reduced to writing notes.
  //  - Generic agents: the minimal set, discovering the rest via search_knowledge.
  //
  // MCP tools are always discovered dynamically via search_knowledge(type="mcp").
  const isCoordinator = agent.agent_type === "bee"
  const isSpecialistProfile = isCoreProfile && !isCoordinator

  const initialToolNames = new Set(MINIMAL_TOOLS)
  if (isCoordinator) {
    for (const name of configuredToolNames) {
      if (name.startsWith("speckit_")) initialToolNames.add(name)
    }
  } else if (isSpecialistProfile) {
    for (const name of configuredToolNames) initialToolNames.add(name)
  }
  const filteredNativeTools: ContextTool[] = allTools.filter(t => initialToolNames.has(t.name))

  const nativeToolsForLLM: LLMToolDef[] = filteredNativeTools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  const toolsForLLM: LLMToolDef[] = nativeToolsForLLM

  const loadoutKind = isCoordinator ? "coordinator (minimal + speckit)"
    : isSpecialistProfile ? `specialist envelope (${agent.agent_type})`
      : "minimal"
  log.info(`[context-compiler] [STEP-4] Native tool loadout [${loadoutKind}]: ${filteredNativeTools.length} tools`)
  log.info(`[context-compiler] [STEP-4b] MCP tools available via search_knowledge: ${mcpToolExecutors.length} (not injected)`)
  log.info(`[context-compiler] [STEP-8] ✅ Combined tools: ${allTools.length} total executors, ${toolsForLLM.length} in LLM context`)

  // [STEP-8b] STRATEGY 2: SELECT — Skill Loadout (minimal + discovered)
  log.info(`[context-compiler] [STEP-8b] Building skill loadout...`)
  let minimalSkills: SkillDescriptor[] = []
  let discoveredSkills: SkillDescriptor[] = []
  let configuredSkills: SkillDescriptor[] = []

  try {
    // Load minimal skills (always available)
    minimalSkills = await getMinimalSkills()
    log.info(`[context-compiler] [STEP-8b] ✅ Loaded ${minimalSkills.length} minimal skills`)

    const configuredSkillNames = new Set(parseStringList(agent.skills_json))
    if (configuredSkillNames.size > 0) {
      const skillsCol = await col<SkillDoc>("skills")
      configuredSkills = (await skillsCol.scan())
        .map(entry => entry.doc)
        .filter(skill => skill.active && configuredSkillNames.has(skill.name))
        .map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description ?? "",
          category: skill.category,
          tools: skill.tools,
          triggers: skill.triggers,
          preferred_agents: skill.preferred_agents,
          body: skill.body,
          version: skill.version,
          version_num: skill.version_num,
          active: skill.active,
        }))
      log.info(`[context-compiler] [STEP-8b] ✅ Loaded ${configuredSkills.length} profile skills`)
    }

    // Discover additional skills via HiveDB capability search (coordinator only)
    if (!isWorker) {
      const inputForSkills = taskContext || userMessage
      const textMessage = typeof inputForSkills === "string"
        ? inputForSkills
        : Array.isArray(inputForSkills)
          ? inputForSkills.filter(p => p.type === "text").map(p => (p as any).text).join("\n")
          : String(inputForSkills)
      discoveredSkills = await selectSkills(textMessage)
      log.info(`[context-compiler] [STEP-8b] ✅ Discovered ${discoveredSkills.length} additional skills via HiveDB`)
    }
  } catch (err) {
    log.warn(`[context-compiler] [STEP-8b] ⚠️ Skill loadout failed: ${(err as Error).message}`)
  }

  // Combine skills (minimal + discovered, avoiding duplicates)
  const skillMap = new Map<string, SkillDescriptor>()
  for (const skill of minimalSkills) {
    skillMap.set(skill.name, skill)
  }
  for (const skill of configuredSkills) {
    skillMap.set(skill.name, skill)
  }
  for (const skill of discoveredSkills) {
    if (!skillMap.has(skill.name)) {
      skillMap.set(skill.name, skill)
    }
  }
  const allSkills = Array.from(skillMap.values())

  // [STEP-9] STRATEGY 3: COMPRESS — Load history with compaction
  log.info(`[context-compiler] [STEP-9] Loading conversation history...`)
  let recentMessages: Awaited<ReturnType<typeof getRecentMessages>> = []
  try {
    recentMessages = await getRecentMessages(threadId, KEEP_LAST_N_MESSAGES)
    log.info(`[context-compiler] [STEP-9] ✅ Loaded ${recentMessages.length} recent messages`)
  } catch (err) {
    log.error(`[context-compiler] [STEP-9] ❌ FAILED loading history: ${JSON.stringify(err)}`)
    throw err
  }

  // Check if we need to use summary (conversation is long)
  let summary: Awaited<ReturnType<typeof getSummary>> = null
  try {
    summary = await getSummary(threadId)
  } catch (err) {
    log.error(`[context-compiler] [STEP-9b] ❌ FAILED loading summary: ${JSON.stringify(err)}`)
    throw err
  }

  const totalTokens = recentMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  let messages: LLMMessage[]

  if (summary && totalTokens > TOKEN_COMPACT_THRESHOLD) {
    // Use summary + recent messages (Strategy: COMPRESS)
    messages = [
      { role: "system", content: `[Conversation Summary]: ${summary.summary}` },
      ...toAPIMessages(recentMessages),
    ]
    log.info(`[context-compiler] [STEP-9c] Using summary (${summary.messages_covered} messages compressed)`)
  } else {
    // Conversation is short enough, use all recent messages
    messages = toAPIMessages(recentMessages)
  }

  // [STEP-10] STRATEGY 4: ISOLATE — Build context based on agent role
  log.info(`[context-compiler] [STEP-10] Building system prompt...`)
  let systemPrompt: string
  try {
    systemPrompt = await buildSystemPromptWithProjects({ agentId })
    log.info(`[context-compiler] [STEP-10] ✅ System prompt built (${systemPrompt.length} chars)`)
  } catch (err) {
    log.error(`[context-compiler] [STEP-10] ❌ FAILED building system prompt: ${JSON.stringify(err)}`)
    throw err
  }

  const now = new Date()

  const workspaceLine = agent.workspace ? `\n**Workspace**: ${agent.workspace} (usa SIEMPRE este path como basePath en herramientas de filesystem)` : ""
  systemPrompt += `\n\n# ENTORNO ACTUAL\n${workspaceLine}\n`


  // Inject scratchpad (Strategy: WRITE) — usando TOON para ahorro de tokens
  if (scratchpadNotes.length > 0) {
    const scratchpadData: Record<string, string> = {}
    for (const n of scratchpadNotes) {
      scratchpadData[n.key] = n.value
    }
    // TOON comprime el formato clave-valor
    const scratchpadContent = formatContext(scratchpadData)
    systemPrompt += `\n\n# SCRATCHPAD (Persistent Notes)\n${scratchpadContent}\n`
  }

  // Inject active/recent project state from DB (coordinator only)
  if (!isWorker) {
    try {
      const projects = await col<ProjectDoc>("projects")
      const tasksCol = await col<TaskDoc>("tasks")
      const recentProjects = (await projects.scan())
        .map((entry) => entry.doc)
        .filter((project) => ["active", "pending", "paused"].includes(project.status))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 10)

      if (recentProjects.length > 0) {
        let projectSection = `\n\n# ESTADO DE PROYECTOS\n`
        for (const proj of recentProjects) {
          const tasks = (await tasksCol.findBy("project_id", proj.id))
            .map((entry) => entry.doc)
            .sort((a, b) => a.id.localeCompare(b.id))
          const doneTasks = tasks.filter((task) => task.status === "completed").length
          projectSection += `\n## ${proj.name} [${proj.status.toUpperCase()}] (${doneTasks}/${tasks.length} tareas, ${proj.progress ?? 0}%)\n`
          if (proj.description) projectSection += `> ${proj.description}\n`

          for (const task of tasks) {
            const resultSummary = task.result
              ? ` → ${task.result.substring(0, 120)}${task.result.length > 120 ? "…" : ""}`
              : ""
            projectSection += `  - [${task.status}] ${task.name}${resultSummary}\n`
          }
        }
        systemPrompt += projectSection
        log.info(`[context-compiler] [STEP-10c] Injected ${recentProjects.length} projects into context`)
      }
    } catch (err) {
      log.warn(`[context-compiler] [STEP-10c] Failed to inject projects: ${(err as Error).message}`)
    }

    // Dynamic tool discovery instruction (coordinator only)
    const minimalToolsDocs = filteredNativeTools
      .filter(t => MINIMAL_TOOLS.has(t.name))
      .map(t => `- **${t.name}**: ${t.description || "Herramienta nativa"}`)
      .join("\n")

    systemPrompt += `\n\n# HERRAMIENTAS NATIVAS BÁSICAS (SIEMPRE DISPONIBLES)\n` +
      `Estas 4 herramientas nativas están SIEMPRE disponibles en tu contexto y tienen prioridad sobre MCP:\n\n` +
      `${minimalToolsDocs}\n\n` +
      `**REGLAS DE USO:**\n` +
      `1. Llama \`get_project_context()\` PRIMERO para obtener el resumen global del proyecto.\n` +
      `2. Si necesitas una herramienta que no esté en la lista arriba → USA \`search_knowledge\` para encontrarla:\n` +
      `   - Herramientas nativas: \`search_knowledge(type="tools", query="<qué necesitas>")\`\n` +
      `   - Herramientas MCP (externas): \`search_knowledge(type="mcp", query="<qué necesitas>")\`\n` +
      `   - Código fuente del proyecto: \`search_knowledge(type="code", query="<función o clase>")\`\n` +
      `   - Todo junto: \`search_knowledge(type="all", query="<qué necesitas>")\`\n` +
      `2. NUNCA uses una herramienta MCP si existe una nativa equivalente en el catálogo\n` +
      `3. Las herramientas MCP se activan dinámicamente vía search_knowledge — NO están en tu contexto por defecto\n\n` +
      `# CATÁLOGO DE HERRAMIENTAS\n` +
      `Usá \`search_knowledge\` para descubrir:\n` +
      `- Skills (instrucciones de tareas complejas): type="skills"\n` +
      `- Playbook (buenas prácticas): type="playbook"\n` +
      `- Herramientas nativas: type="tools"\n` +
      `- Herramientas MCP (externas): type="mcp"\n` +
      `- Todo: type="all"\n` +
      `\n## REGLA CRÍTICA — Delegación a workers\n` +
      `Los workers arrancan con herramientas mínimas (save_note, notify, report_progress, search_knowledge).\n` +
      `**ANTES de crear o delegar a un worker**, SIEMPRE debes:\n` +
      `1. Usar \`search_knowledge(type="tools", query="<tarea del worker>")\` para identificar qué herramientas necesita.\n` +
      `2. Incluir esas herramientas en el campo \`tools\` al crear el agente con \`create_agent\`, o\n` +
      `   en el campo \`task_description\` de \`task_delegate\` como instrucción explícita:\n` +
      `   "Usa las herramientas: web_search, fs_read, ... para completar esta tarea."\n` +
      `3. El worker con esa instrucción usará \`search_knowledge\` para activar las tools por nombre.\n` +
      `Ejemplo: si el worker debe investigar en internet → busca "web search herramienta internet, herramientas de navegacion, browser" → obtienes "web_search" → dile al worker que use web_search.\n` +
      `4. Las herramientas se inyectan dinamicamente vía search_knowledge — NO están en tu contexto por defecto\n`


    // Inject developer preferences from ACE reflector (coordinator only)
    try {
      const codePlaybook = await col<CodePlaybookDoc>("codePlaybook")
      const devPrefs = (await codePlaybook.scan())
        .map((entry) => entry.doc)
        .filter((rule) => rule.source === "preferences" && rule.coordinator === "user" && rule.active)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10)
      if (devPrefs.length > 0) {
        let prefsSection = `\n\n# PREFERENCIAS DEL DESARROLLADOR\nEl desarrollador ha expresado estas preferencias en sesiones anteriores:\n\n`
        for (const p of devPrefs) {
          prefsSection += `- ${p.rule}\n`
        }
        systemPrompt += prefsSection
        log.info(`[context-compiler] [STEP-10e] Injected ${devPrefs.length} developer preferences`)
      }
    } catch {
      // codePlaybook may not be initialized yet — skip silently
    }

  }

  // Profile skills are executable operating instructions, so their bodies must
  // be present for workers as well as BEE. This also makes spec-kit mandatory
  // for BEE without relying on probabilistic trigger matching.
  if (allSkills.length > 0) {
    const skillBodies = allSkills
      .map(skill => `## Skill: ${skill.name}\n${skill.body}`)
      .join("\n\n")
    systemPrompt += `\n\n# SKILLS ACTIVAS\n${skillBodies}`
    log.info(
      `[context-compiler] [STEP-10d] Injected ${allSkills.length} skill bodies ` +
      `(${minimalSkills.length} minimal, ${configuredSkills.length} profile, ${discoveredSkills.length} discovered)`
    )
  }

  // For isolated workers, add task context + tool discovery instruction
  if (isWorker && opts.taskContext) {
    systemPrompt += `\n\n# HERRAMIENTAS DISPONIBLES\n` +
      `Arrancas con herramientas básicas. Si tu tarea requiere herramientas adicionales (web_search, fs_read, browser_navigate, etc.):\n` +
      `1. Usá \`search_knowledge(type="tools", query="<herramienta o tarea>")\` para encontrarlas.\n` +
      `2. Las herramientas que encuentres estarán disponibles para usar inmediatamente.\n` +
      `Si el coordinador te indicó herramientas específicas, buscalas primero con search_knowledge antes de ejecutar tu tarea.\n` +
      `\n# CURRENT TASK\n${opts.taskContext}\n\nFocus ONLY on this task. Do not deviate.`
  }

  log.info(
    `[context-compiler] ✅ DONE: ${allTools.length} permitted tools, ` +
    `${toolsForLLM.length} selected tools, ${messages.length} messages, ` +
    `${allSkills.length} skills (${minimalSkills.length} minimal, ${discoveredSkills.length} discovered), ` +
    `isolated=${isWorker}`
  )

  return {
    systemPrompt,
    messages,
    tools: toolsForLLM,
    allTools,
    skills: allSkills,
  }
}

// Re-export sync functions for gateway/initializer
export {
  syncToolCatalogToIndex as syncToolsToIndex,
  syncSkillsToIndex,
  syncPlaybookToIndex,
}
