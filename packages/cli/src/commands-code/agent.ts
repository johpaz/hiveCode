/**
 * Agent commands — manage Hive-Code agents/sub-agents.
 *
 * hivecode agent list [--coordinator <name>]
 * hivecode agent inspect <name>
 * hivecode agent edit <name>
 * hivecode agent configure <name> [--provider=...] [--model=...] [...]
 * hivecode agent reset <name>
 */

import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveText, isCancel,
} from "../cli-ui.ts"
import { col, fromIndexable } from "@johpaz/hivecode-core/storage/hive"
import type { AgentDoc } from "@johpaz/hivecode-core/storage/collections"

export async function agentList(args: string[] = []): Promise<void> {
  hiveIntro("hivecode · Agentes")

  const roleFilter = args.find(a => a.startsWith("--role="))?.split("=")[1]

  const agents = await col<AgentDoc>("agents")
  const rows = (await agents.scan())
    .map((entry) => entry.doc)
    .filter((agent) => !roleFilter || agent.role === roleFilter)
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))

  if (rows.length === 0) {
    hiveNote("Sin agentes", ["No hay agentes configurados.", "Ejecuta: hivecode doctor"])
    hiveOutro("Sin agentes")
    return
  }

  for (const row of rows) {
    const statusIcon = row.enabled ? "●" : "○"
    const color = row.enabled ? "\x1b[38;5;114m" : "\x1b[38;5;240m"
    hivePhaseComplete(row.role, `${row.name}`)
    process.stdout.write(`  │    ${color}${statusIcon}\x1b[0m  ${row.role}`)
    const parentId = fromIndexable(row.parent_id)
    const modelId = fromIndexable(row.model_id)
    if (parentId) process.stdout.write(`  ·  worker de ${parentId}`)
    if (modelId) process.stdout.write(`  ·  ${modelId}`)
    process.stdout.write(`\n  │\n`)
  }

  hiveOutro(`${rows.length} agente(s)`)
}

export async function agentInspect(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode agent inspect <name>", "error")
    process.exit(1)
  }

  const row = await findAgent(name)

  if (!row) {
    hiveOutro(`Agente no encontrado: ${name}`, "error")
    process.exit(1)
  }

  hiveIntro(`hivecode · Agente: ${row.name}`)

  console.log(`\n  \x1b[1mID:\x1b[0m           ${row.id}`)
  console.log(`  \x1b[1mNombre:\x1b[0m       ${row.name}`)
  console.log(`  \x1b[1mRol:\x1b[0m          ${row.role}`)
  console.log(`  \x1b[1mParent:\x1b[0m       ${fromIndexable(row.parent_id) || "—"}`)
  console.log(`  \x1b[1mModelo:\x1b[0m       ${fromIndexable(row.model_id) || "default"}`)
  console.log(`  \x1b[1mHabilitado:\x1b[0m   ${row.enabled ? "Sí" : "No"}`)
  console.log(`  \x1b[1mMax iter:\x1b[0m     ${row.max_iterations || 10}`)
  console.log(``)

  if (row.system_prompt) {
    const preview = row.system_prompt.slice(0, 500).replace(/\n/g, "\n  │    ")
    console.log(`  \x1b[1mSystem Prompt:\x1b[0m\n  │    ${preview}...\n`)
  }

  hiveOutro("Agente inspeccionado")
}

export async function agentEdit(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode agent edit <name>", "error")
    process.exit(1)
  }

  const row = await findAgent(name)

  if (!row) {
    hiveOutro(`Agente no encontrado: ${name}`, "error")
    process.exit(1)
  }

  // Core prompts are immutable; the editor appends user-owned instructions.
  const tmpFile = `/tmp/hive-agent-${row.id}-${Date.now()}.md`
  await Bun.write(tmpFile, row.user_instructions || "")

  // Open in $EDITOR
  const editor = process.env.EDITOR || "nano"
  const proc = Bun.spawn([editor, tmpFile], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  await proc.exited

  // Read back
  const userInstructions = await Bun.file(tmpFile).text()
  await updateAgent(row.id, {
    user_instructions: userInstructions,
    config_version: (row.config_version ?? 0) + 1,
  })

  // Cleanup
  try { await Bun.file(tmpFile).delete() } catch {}

  hiveOutro(`Instrucciones personales de ${name} actualizadas`)
}

export async function agentConfigure(name: string | undefined, args: string[] = []): Promise<void> {
  if (!name) {
    hiveOutro("Uso: hivecode agent configure <name> [--provider=x] [--model=y] [--effort=medium] [--max-turns=20]", "error")
    process.exit(1)
  }
  const row = await findAgent(name)
  if (!row?.agent_type) {
    hiveOutro(`Perfil core no encontrado: ${name}`, "error")
    process.exit(1)
  }
  const flags = new Map(
    args.filter(arg => arg.startsWith("--") && arg.includes("="))
      .map(arg => {
        const [key, ...value] = arg.slice(2).split("=")
        return [key, value.join("=")]
      }),
  )
  const numeric = (key: string, current: number | undefined) =>
    flags.has(key) ? Number(flags.get(key)) : current
  await updateAgent(row.id, {
    provider_id: flags.get("provider") ?? row.provider_id,
    model_id: flags.get("model") ?? row.model_id,
    fallback_provider_id: flags.get("fallback-provider") ?? row.fallback_provider_id,
    fallback_model_id: flags.get("fallback-model") ?? row.fallback_model_id,
    effort: (["low", "medium", "high", "xhigh", "max"].includes(flags.get("effort") ?? "")
      ? flags.get("effort")
      : row.effort) as AgentDoc["effort"],
    max_iterations: numeric("max-turns", row.max_iterations) ?? row.max_iterations,
    max_input_tokens: numeric("max-input-tokens", row.max_input_tokens) ?? 0,
    max_output_tokens: numeric("max-output-tokens", row.max_output_tokens) ?? 0,
    max_cost_usd: numeric("max-cost-usd", row.max_cost_usd) ?? 0,
    config_version: (row.config_version ?? 0) + 1,
  })
  hiveOutro(`Configuración de ${row.name} actualizada`)
}

export async function agentReset(name?: string): Promise<void> {

  if (!name) {
    hiveOutro("Uso: hivecode agent reset <name>", "error")
    process.exit(1)
  }

  const row = await findAgent(name)

  if (!row) {
    hiveOutro(`Agente no encontrado: ${name}`, "error")
    process.exit(1)
  }

  await updateAgent(row.id, {
    user_instructions: "",
    config_version: (row.config_version ?? 0) + 1,
  })

  hiveOutro(`Instrucciones personales de ${name} restauradas`)
}

async function findAgent(name: string): Promise<AgentDoc | null> {
  const agents = await col<AgentDoc>("agents")
  const direct = await agents.get(name)
  if (direct) return direct.doc
  return (await agents.scan()).map((entry) => entry.doc).find((agent) => agent.name === name) ?? null
}

async function updateAgent(id: string, patch: Partial<AgentDoc>): Promise<void> {
  const agents = await col<AgentDoc>("agents")
  const row = await agents.get(id)
  if (!row) return
  await agents.put(id, { ...row.doc, ...patch, updated_at: Date.now() }, { expectedVersion: row.version })
}
