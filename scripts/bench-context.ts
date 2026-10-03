/**
 * bench:context — mide el tamaño del contexto por turno y lo proyecta a latencia.
 *
 * Contexto: el BENCHMARK.md del repo reporta prompt processing de 137 t/s
 * (Qwen3.6-35B), 46 t/s (Qwen3.8-27B) y 21 t/s (DeepSeek-V4-Flash) sobre
 * llama.cpp/Vulkan en un Ryzen AI MAX+ 395. El prefill domina el wall clock de
 * un turno, así que lo que importa medir no es cuánto tarda compileContext sino
 * cuántos tokens produce.
 *
 * Este script separa las dos cosas a propósito: mide ms de compilación (debe ser
 * pequeño) y tokens de prompt (que es lo que cuesta tiempo de GPU).
 *
 * Uso:
 *   bun run bench:context                # todos los agentes, 20 iteraciones
 *   bun run bench:context -- --agent bee # solo uno
 *   bun run bench:context -- --iters 50 # más muestras
 *
 * Apunta a la DB que marque HIVE_DB_PATH; si no, a ./hivecode. Es de solo
 * lectura salvo por la sincronización de tools/skills al índice, que ya hace
 * compileContext en su curso normal.
 */

import { compileContext } from "@johpaz/hivecode-core/agent/context-compiler"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { estimateTokens } from "@johpaz/hivecode-core/utils/toon"
import type { AgentDoc } from "@johpaz/hivecode-core/storage/collections"
import { logger } from "@johpaz/hivecode-core/utils/logger"

// compileContext narra cada paso a INFO; a nivel debug el bench es ilegible.
logger.setLevel?.("warn")

// ─── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}
const ITERS = flag("iters", 20)
const ONLY = argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : null
const MESSAGE =
  "analiza el repositorio, identifica los hotspots de rendimiento y propón un plan de pruebas"

// ─── Prompt processing medido en BENCHMARK.md ──────────────────────────────
// Tokens/segundo de prefill. El wall clock de un turno es esencialmente esto.
const PREFILL_TPS: Array<{ model: string; tps: number }> = [
  { model: "Qwen3.6-35B", tps: 137 },
  { model: "Qwen3.8-27B", tps: 46 },
  { model: "DeepSeek-V4F", tps: 21 },
]

/** Contexto de una conversación ya en curso, para proyectar el peor caso. */
const HISTORY_TOKENS = 12_000

// ─── Helpers ───────────────────────────────────────────────────────────────
const msgTokens = (content: unknown): number =>
  estimateTokens(typeof content === "string" ? content : JSON.stringify(content ?? ""))

function stats(samples: number[]): { p50: number; p95: number; min: number; max: number } {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
  return { p50: at(0.5), p95: at(0.95), min: s[0], max: s[s.length - 1] }
}

const sec = (tokens: number, tps: number) => {
  const t = tokens / tps
  return t < 60 ? `${t.toFixed(1)}s` : `${Math.floor(t / 60)}m${String(Math.round(t % 60)).padStart(2, "0")}s`
}

// ─── Main ──────────────────────────────────────────────────────────────────
const agentsCol = await col<AgentDoc>("agents")
const seeded = await agentsCol.scan({})
if (seeded.length === 0) {
  console.error("No hay agentes en la DB. Corre `hivecode init` primero.")
  process.exit(1)
}

const targets = ONLY
  ? seeded.filter((e) => e.doc.id === ONLY)
  : seeded

if (targets.length === 0) {
  console.error(`Agente "${ONLY}" no encontrado. Disponibles: ${seeded.map((e) => e.doc.id).join(", ")}`)
  process.exit(1)
}

const rows: Array<{
  id: string
  role: string
  ms: { p50: number; p95: number }
  spTokens: number
  toolCount: number
  toolTokens: number
  floor: number
  skillCount: number
}> = []

for (const entry of targets) {
  const agent = entry.doc

  // Una pasada en frío: la primera paga carga de módulos e índices.
  await compileContext({ agentId: agent.id, threadId: "bench:context", userMessage: MESSAGE })

  const ms: number[] = []
  let spTokens = 0
  let toolCount = 0
  let toolTokens = 0
  let skillCount = 0

  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now()
    const ctx = await compileContext({
      agentId: agent.id,
      threadId: "bench:context",
      userMessage: MESSAGE,
    })
    ms.push(performance.now() - t0)

    if (i === 0) {
      spTokens = estimateTokens(ctx.systemPrompt)
      toolCount = ctx.tools.length
      toolTokens = estimateTokens(JSON.stringify(ctx.tools))
      skillCount = ctx.skills.length
    }
  }

  rows.push({
    id: agent.id,
    role: String(agent.role),
    ms: stats(ms),
    spTokens,
    toolCount,
    toolTokens,
    floor: spTokens + toolTokens,
    skillCount,
  })
}

// ─── Reporte ───────────────────────────────────────────────────────────────
console.log(`\n  context bench — ${ITERS} iteraciones, piso sin historial\n`)
console.log(
  `  ${"agent".padEnd(10)}${"role".padEnd(12)}${"ms p50".padStart(8)}${"ms p95".padStart(8)}` +
    `${"prompt".padStart(9)}${"tools".padStart(7)}${"schemas".padStart(9)}${"skills".padStart(8)}${"PISO".padStart(9)}`,
)
console.log(`  ${"-".repeat(80)}`)

for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(10)}${r.role.padEnd(12)}${r.ms.p50.toFixed(1).padStart(8)}${r.ms.p95.toFixed(1).padStart(8)}` +
      `${String(r.spTokens).padStart(9)}${String(r.toolCount).padStart(7)}${String(r.toolTokens).padStart(9)}` +
      `${String(r.skillCount).padStart(8)}${String(r.floor).padStart(9)}`,
  )
}

console.log(`\n  ms = tiempo de compileContext (CPU). tokens = lo que se manda al modelo (GPU).\n`)

// Proyección de prefill. El piso es lo que se paga con la conversación vacía.
console.log(`  Prefill proyectado — solo el piso, sin historial\n`)
console.log(`  ${"agent".padEnd(10)}${"PISO".padStart(8)}  ${PREFILL_TPS.map((p) => p.model.padStart(13)).join("")}`)
console.log(`  ${"-".repeat(60)}`)

for (const r of rows) {
  const cells = PREFILL_TPS.map((p) => sec(r.floor, p.tps).padStart(13)).join("")
  console.log(`  ${r.id.padEnd(10)}${String(r.floor).padStart(8)}  ${cells}`)
}

// El piso no es el problema creciente: el historial sí. Con 12k tokens de
// conversación encima, un turno sin poda arrastra el piso completo cada vez.
console.log(`\n  Escenario con historial — piso + ${HISTORY_TOKENS} tokens de conversación\n`)
console.log(`  ${"agent".padEnd(10)}${"tokens".padStart(8)}  ${PREFILL_TPS.map((p) => p.model.padStart(13)).join("")}   vs. sin poda`)
console.log(`  ${"-".repeat(88)}`)

for (const r of rows) {
  const total = r.floor + HISTORY_TOKENS
  const cells = PREFILL_TPS.map((p) => sec(total, p.tps).padStart(13)).join("")
  const waste = PREFILL_TPS.map((p) => sec(HISTORY_TOKENS, p.tps)).join(" / ")
  console.log(`  ${r.id.padEnd(10)}${String(total).padStart(8)}  ${cells}   ${waste}`)
}

const worst = rows.reduce((a, b) => (a.floor > b.floor ? a : b))
console.log(
  `\n  El perfil más caro es "${worst.id}" con ${worst.floor} tokens de piso. ` +
    `Compilarlo toma ${worst.ms.p50.toFixed(1)}ms — la latencia no está en compilar, está en el prefill.\n`,
)

closeHiveDb()
process.exit(0)