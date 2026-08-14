/**
 * Prompt Builder — Construye el system prompt con la jerarquía constitucional.
 *
 * Orden de ensamblaje:
 * 1. ÉTICA (capa constitucional, siempre completa, inmutable)
 * 2. IDENTIDAD DEL AGENTE (colección agents)
 * 3. HIVE ECOSYSTEM (system prompt directo para el coordinador)
 * 4. IDENTIDAD DEL USUARIO (colección users)
 */

import { col } from "../storage/hive"
import type { AgentDoc, EthicsDoc, UserDoc } from "../storage/collections"
import { resolveUserId } from "../storage/onboarding"
import { logger } from "../utils/logger"
import { formatContext } from "../utils/toon"

const log = logger.child("prompt-builder")

export interface BuildSystemPromptOpts {
  agentId: string
  userId?: string
}

export async function buildSystemPrompt(opts: BuildSystemPromptOpts): Promise<string> {
  const { agentId = "main", userId } = opts

  const ethics = await col<EthicsDoc>("ethics")
  const ethicsRules = (await ethics.scan())
    .map((entry) => entry.doc)
    .filter((rule) => rule.enabled && rule.active)
    .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.id.localeCompare(b.id))

  let ethicsSection = ""
  if (ethicsRules.length > 0) {
    const ethicsContent = ethicsRules.map((rule) => `## ${rule.name}\n${rule.content}`).join("\n\n")
    ethicsSection = `# ÉTICA Y REGLAS CONSTITUCIONALES\n\n${ethicsContent}\n\n`
    log.info(`[prompt-builder] Loaded ${ethicsRules.length} ethics rules`)
  } else {
    ethicsSection = `# ÉTICA Y REGLAS CONSTITUCIONALES\n\n` +
      `- Sé útil, inofensivo y honesto\n` +
      `- No generes contenido dañino, ilegal o peligroso\n` +
      `- Respeta la privacidad y seguridad del usuario\n` +
      `- Si no sabes algo, admítelo\n\n`
  }

  const agents = await col<AgentDoc>("agents")
  const agent = (await agents.get(agentId))?.doc
  if (!agent) throw new Error(`Agent not found: ${agentId}`)

  let agentSection = `# IDENTIDAD DEL AGENTE\n\n`
  agentSection += `**Nombre**: ${agent.name}\n`
  agentSection += `**Rol**: ${agent.role}\n`
  if (agent.description) agentSection += `**Descripción**: ${agent.description}\n`
  if (agent.tone) agentSection += `**Tono**: ${agent.tone}\n`
  agentSection += `**Iteraciones máximas**: ${agent.max_iterations}\n\n`

  const workspacePath = agent.workspace || null
  if (workspacePath) {
    agentSection += `# WORKSPACE — ESPACIO DE TRABAJO EXCLUSIVO\n\n`
    agentSection += `**Tu directorio de trabajo es**: \`${workspacePath}\`\n\n`
    agentSection += `## REGLAS OBLIGATORIAS (no negociables)\n\n`
    agentSection += `1. **TODAS** tus operaciones de archivos y comandos ocurren DENTRO de \`${workspacePath}\`. Sin excepciones.\n`
    agentSection += `2. Cuando el sistema te pida listar archivos, explorar, leer o escribir — hazlo SIEMPRE dentro de \`${workspacePath}\`.\n`
    agentSection += `3. Nunca uses \`ls\`, \`find\`, \`cat\` u otras herramientas apuntando a directorios del sistema (\`/\`, \`~\`, \`/home\`, \`/etc\`, etc.).\n`
    agentSection += `4. Cuando uses \`shell_executor\`, el directorio de trabajo ya es \`${workspacePath}\` por defecto.\n`
    agentSection += `5. Para rutas relativas, son relativas a \`${workspacePath}\`.\n`
    agentSection += `6. Si el usuario pide explorar "el proyecto" o "los archivos", asume que se refiere a \`${workspacePath}\`.\n`
    agentSection += `7. Las tools de filesystem ya tienen tu workspace configurado — úsalas directamente con rutas relativas.\n\n`
    agentSection += `> IMPORTANTE: Cualquier intento de acceder fuera de \`${workspacePath}\` será bloqueado automáticamente por el sistema.\n\n`
  }

  if (agent.system_prompt) {
    agentSection += `## System Prompt\n\n${agent.system_prompt}\n\n`
  }
  if (agent.user_instructions?.trim()) {
    agentSection += `## Instrucciones personales del usuario\n\n${agent.user_instructions.trim()}\n\n`
  }

  const resolvedUserId = userId || await resolveUserId()
  const users = await col<UserDoc>("users")
  const user = (await users.get(resolvedUserId))?.doc
  let userSection = `# IDENTIDAD DEL USUARIO\n\n`
  if (user) {
    const userData: Record<string, string | null> = {}
    if (user.name) userData.Nombre = user.name
    if (user.language) userData.Idioma = user.language
    if (user.timezone) userData.ZonaHoraria = user.timezone
    if (user.occupation) userData.Ocupacion = user.occupation
    if (user.notes) userData.Notas = user.notes
    userSection += Object.keys(userData).length > 0
      ? `${formatContext(userData)}\n\n`
      : `Usuario ID: ${resolvedUserId}\n\n`
  } else {
    userSection += `Usuario ID: ${resolvedUserId}\n\n`
  }

  const systemPrompt = `${ethicsSection}${agentSection}${userSection}`.trim()
  log.info(`[prompt-builder] Built system prompt for agent=${agent.name} role=${agent.role}`)
  return systemPrompt
}

export async function buildSystemPromptWithProjects(opts: {
  agentId: string
  userId?: string
}): Promise<string> {
  const userId = opts.userId || await resolveUserId()
  return buildSystemPrompt({ agentId: opts.agentId, userId })
}
