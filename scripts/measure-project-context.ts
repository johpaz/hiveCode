/**
 * What it costs, in context, to explore a whole project. No model is called: it measures the project and
 * the answers hivecode's tools give, then runs the agent loop's own retention rules over them.
 *
 *   bun scripts/measure-project-context.ts [dir]            # default: the current directory
 *   bun scripts/measure-project-context.ts [dir] --json
 *
 * Three parts:
 *  1. The project: files, characters, tokens, by area. How much there is to see.
 *  2. What each way of seeing it costs: all raw, outlines, the one-line map, ranged reads.
 *  3. The loop: tokens an exploration spends re-sending its context, turn by turn, by strategy. Calibrated
 *     against a real run (see CALIBRATION): if the model does not reproduce it, the model is wrong, not the run.
 *
 * Tokens are estimated, not counted: `CHARS_PER_TOKEN` is the harness's own (3.5) and `DENSE` a pessimistic one.
 * Real providers land between them for code and above for JSON/Spanish (the first turn of a real scout was 1.7x
 * its estimate). The conclusions that matter hold at both ends; the table shows both.
 */
import fs from "node:fs"
import path from "node:path"
import { CODE_EXTENSIONS, SKIP_DIRS, indexFile, shouldIndexFile } from "../packages/core/src/agent/source-index"
import { projectIdentity } from "../packages/core/src/agent/project-identity"
import { clearOldToolResults } from "../packages/core/src/agent/compaction"

const CHARS_PER_TOKEN = 3.5
const DENSE = 2.5
const tok = (chars: number, per = CHARS_PER_TOKEN) => Math.ceil(chars / per)
const K = (n: number) => `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`
const M = (n: number) => `${(n / 1e6).toFixed(2)}M`

// ── Real-run constants (measured, see docs/rutas-por-costo.md and the T1 runs) ──────────────────────────
/** Tokens every turn of a scout re-sends before any history: system, skills, tools, project packet. Real, first turn. */
const SCOUT_PREFIX_TOKENS = 10_000
/** Largest result one tool call may put in the context (`toolResultCap`): 16,000 chars. */
const RESULT_CAP_CHARS = 16_000
/** What a cleared (older than 4 turns) tool result is cut to (`TOOL_RESULT_MAX_CHARS`). */
const CLEARED_CHARS = 600
const KEEP_FULL_TURNS = 4

const args = process.argv.slice(2)
const json = args.includes("--json")
const root = path.resolve(args.find(a => !a.startsWith("--")) ?? process.cwd())
const project = projectIdentity(root)

// ── 1. The project ────────────────────────────────────────────────────────────────────────────────────────
interface Measured { rel: string; area: string; chars: number; lines: number; outlineChars: number; mapChars: number; symbols: number }
const files: Measured[] = []
const glob = new Bun.Glob(`**/*.{${CODE_EXTENSIONS.join(",")}}`)
for await (const rel of glob.scan({ cwd: project.root, onlyFiles: true })) {
  if (rel.split(path.sep).some(part => SKIP_DIRS.has(part))) continue
  const abs = path.join(project.root, rel)
  if (!shouldIndexFile(abs, project.root)) continue
  const index = await indexFile(abs, project.root)
  if (!index) continue
  // The same shape the `outline` tool returns: one entry per symbol with its lines and signature.
  const outline = JSON.stringify({ path: rel, symbols: index.symbols.map(s => ({ name: s.name, kind: s.kind, lines: `${s.startLine}-${s.endLine}`, signature: s.signature })), imports: index.imports.slice(0, 25), exports: index.exports.slice(0, 25) })
  const top = [...new Set([...index.exports, ...index.functions, ...index.classes])].slice(0, 4)
  const map = `- ${rel}${top.length ? ` → ${top.join(", ")}` : ""}`
  const parts = rel.split("/")
  files.push({ rel, area: parts[0] === "packages" ? parts.slice(0, 2).join("/") : parts[0], chars: index.content.length, lines: index.content.split("\n").length, outlineChars: outline.length, mapChars: map.length, symbols: index.symbols.length })
}
const sum = (f: (m: Measured) => number, xs: Measured[] = files) => xs.reduce((s, m) => s + f(m), 0)
const total = { files: files.length, chars: sum(m => m.chars), lines: sum(m => m.lines), outline: sum(m => m.outlineChars), map: sum(m => m.mapChars) }

const areas = new Map<string, Measured[]>()
for (const f of files) areas.set(f.area, [...(areas.get(f.area) ?? []), f])
const byArea = [...areas].map(([area, fs_]) => ({ area, files: fs_.length, chars: sum(m => m.chars, fs_), outline: sum(m => m.outlineChars, fs_) })).sort((a, b) => b.chars - a.chars)
const biggest = [...files].sort((a, b) => b.chars - a.chars).slice(0, 8)
const overCap = files.filter(f => f.chars > RESULT_CAP_CHARS)

// ── 2. What each way of seeing it costs ──────────────────────────────────────────────────────────────────
const RANGE_LINES = 80
/** Lines a reader gets from `fs_read` on a big file without a range (fs-read.ts). */
const READER_LINES = 120
const rangeChars = (f: Measured) => Math.min(f.chars, Math.round((f.chars / Math.max(1, f.lines)) * RANGE_LINES))
const strategies = [
  { name: "leer todo en bruto (fs_read de cada archivo)", chars: total.chars, note: `${overCap.length} archivos pasan el tope de ${RESULT_CAP_CHARS / 1000}K y se recortan` },
  { name: "lo que de verdad ve fs_read sin rango (tope por llamada)", chars: sum(m => Math.min(m.chars, RESULT_CAP_CHARS)), note: "cada archivo, hasta el tope" },
  { name: "lo que ve un lector (scout/planner) con fs_read sin rango", chars: sum(m => Math.min(m.chars, Math.round((m.chars / Math.max(1, m.lines)) * READER_LINES) + (m.lines > READER_LINES ? Math.min(60, m.symbols) * 70 : 0))), note: `${READER_LINES} líneas + estructura del archivo` },
  { name: "outline de cada archivo", chars: total.outline, note: "símbolos, rangos, firmas" },
  { name: "mapa de una línea por archivo", chars: total.map, note: "ruta → 4 símbolos principales" },
  { name: `un rango de ${RANGE_LINES} líneas por archivo`, chars: sum(rangeChars), note: "lo que cuesta mirar un trozo de cada uno" },
]

// ── 3. The loop ──────────────────────────────────────────────────────────────────────────────────────────
interface Loop { turns: number; callsPerTurn: number; resultChars: number; scouts: number }
/** The tools a scout calls, in the proportion it called them in the real run. */
const TOOL_MIX = ["fs_read", "search_in_files", "outline", "fs_read", "search_in_files", "dependents"]

/**
 * Input tokens of a whole exploration: every turn re-sends the prefix and the retained history. Messages are built the
 * way the loop builds them (the assistant turn carries the calls, each result answers one), because the clearing rule
 * keeps the freshest result of every tool and tells them apart by the call that produced them.
 */
function loopCost(loop: Loop, per = CHARS_PER_TOKEN): { input: number; peak: number; perTurn: number } {
  const messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string } }> }> = []
  let input = 0
  let peak = 0
  for (let t = 0; t < loop.turns; t++) {
    const prepared = clearOldToolResults(messages, KEEP_FULL_TURNS)
    const turnInput = SCOUT_PREFIX_TOKENS + tok(prepared.reduce((s, m) => s + m.content.length, 0), per)
    input += turnInput
    peak = Math.max(peak, turnInput)
    const calls = Array.from({ length: loop.callsPerTurn }, (_, c) => ({ id: `${t}-${c}`, function: { name: TOOL_MIX[(t * loop.callsPerTurn + c) % TOOL_MIX.length] } }))
    messages.push({ role: "assistant", content: "x".repeat(200), tool_calls: calls })
    for (const call of calls) messages.push({ role: "tool", content: "r".repeat(loop.resultChars), tool_call_id: call.id })
  }
  return { input: input * loop.scouts, peak, perTurn: Math.round((input * loop.scouts) / (loop.turns * loop.scouts)) }
}

// CALIBRATION: T1 on this repo (MiniMax 3.1): 3 scouts, 45 turns in total, 1.11M input, avg 24.6K per turn, ~3.2 calls/turn,
// of which about half were fs_read/search_in_files (unbounded, cap-sized) and half index calls (small).
const calibration = { observedInput: 1_106_564, observedTurns: 45, observedScouts: 3 }
/**
 * The average size of a tool answer that makes the model reproduce the real run: bisect on it. This is inferred
 * from ONE run, not measured per call — it is the number to replace when the step trace records result sizes.
 */
function calibratedResultChars(): number {
  let lo = 200
  let hi = RESULT_CAP_CHARS
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const cost = loopCost({ turns: 15, callsPerTurn: 3, resultChars: Math.round(mid), scouts: 3 }).input
    if (cost > calibration.observedInput) hi = mid; else lo = mid
  }
  return Math.round((lo + hi) / 2)
}
const TODAY_RESULT_CHARS = calibratedResultChars()
const calModel = loopCost({ turns: 15, callsPerTurn: 3, resultChars: TODAY_RESULT_CHARS, scouts: 3 })
const AVG_OUTLINE_CHARS = Math.round(total.outline / Math.max(1, total.files))

const dir = Math.ceil(total.chars / CHARS_PER_TOKEN)
const scenario = (label: string, loop: Loop) => ({ label, loop, ...loopCost(loop), dense: loopCost(loop, DENSE).input })
/**
 * Turns an exploration of `coverage` of the source takes. `costChars` is what a call puts in the context;
 * `coverChars` is how much source it lets the agent see. They differ for an outline (a file for a fraction of its size).
 */
const explore = (costChars: number, coverChars: number, callsPerTurn: number, scouts: number, coverage: number) => {
  const callsNeeded = Math.ceil((total.chars * coverage) / coverChars)
  return { turns: Math.max(1, Math.ceil(callsNeeded / callsPerTurn / scouts)), callsPerTurn, resultChars: costChars, scouts }
}
const AVG_FILE_CHARS = Math.round(total.chars / Math.max(1, total.files))
const scenarios = [
  scenario(`hoy: respuesta media ${K(tok(TODAY_RESULT_CHARS))}, 3 llamadas por turno, 3 scouts, 40 % del código`, explore(TODAY_RESULT_CHARS, TODAY_RESULT_CHARS, 3, 3, 0.4)),
  scenario("rangos de 80 líneas (~1,1K), 3 llamadas por turno, 3 scouts, 40 %", explore(4_000, 4_000, 3, 3, 0.4)),
  scenario(`outline por archivo (${K(tok(AVG_OUTLINE_CHARS))} cubre ${K(tok(AVG_FILE_CHARS))}), 8 por turno, 3 scouts, 40 %`, explore(AVG_OUTLINE_CHARS, AVG_FILE_CHARS, 8, 3, 0.4)),
  scenario("hoy, 1 scout, 40 % del código", explore(TODAY_RESULT_CHARS, TODAY_RESULT_CHARS, 3, 1, 0.4)),
  scenario("hoy, 3 scouts, TODO el código", explore(TODAY_RESULT_CHARS, TODAY_RESULT_CHARS, 3, 3, 1)),
  scenario(`outline por archivo, 8 por turno, 3 scouts, TODO el código`, explore(AVG_OUTLINE_CHARS, AVG_FILE_CHARS, 8, 3, 1)),
]

if (json) {
  console.log(JSON.stringify({ project: project.name, root: project.root, total, byArea, strategies, calibration, calModel, scenarios: scenarios.map(s => ({ ...s, loop: s.loop })) }, null, 2))
  process.exit(0)
}

const pad = (s: string | number, n: number) => String(s).padEnd(n)
const lpad = (s: string | number, n: number) => String(s).padStart(n)
console.log(`# Contexto de explorar ${project.name}\n`)
console.log(`${total.files} archivos · ${total.lines.toLocaleString("es")} líneas · ${(total.chars / 1e6).toFixed(2)} MB de texto`)
console.log(`≈ ${M(tok(total.chars))} tokens (a ${CHARS_PER_TOKEN} car/tok) · hasta ${M(tok(total.chars, DENSE))} (a ${DENSE})\n`)

console.log("## 1. Dónde está el código\n")
console.log(`${pad("área", 26)} ${lpad("archivos", 8)} ${lpad("tokens", 9)} ${lpad("% ", 5)}`)
for (const a of byArea.slice(0, 10)) console.log(`${pad(a.area, 26)} ${lpad(a.files, 8)} ${lpad(K(tok(a.chars)), 9)} ${lpad(Math.round((100 * a.chars) / total.chars) + "%", 5)}`)
console.log(`\nArchivos más grandes: ${biggest.map(b => `${b.rel} (${K(tok(b.chars))})`).join(", ")}`)
console.log(`Archivos que no caben en una sola llamada (> ${RESULT_CAP_CHARS / 1000}K caracteres): ${overCap.length} de ${total.files} — fs_read sin rango los recorta\n`)

console.log("## 2. Qué cuesta ver el proyecto, según cómo se mire\n")
console.log(`${pad("forma de mirar", 58)} ${lpad("tokens", 9)} ${lpad("(a 2,5)", 9)}   nota`)
for (const s of strategies) console.log(`${pad(s.name, 58)} ${lpad(K(tok(s.chars)), 9)} ${lpad(K(tok(s.chars, DENSE)), 9)}   ${s.note}`)

console.log("\n## 3. Lo que gasta el loop (entrada total, con el recorte real de resultados)\n")
console.log(`Calibración con T1 real: ${calibration.observedScouts} scouts, ${calibration.observedTurns} turnos → ${M(calibration.observedInput)} de entrada observados.`)
console.log(`Para reproducirlos (15 turnos × 3 llamadas × 3 scouts) la respuesta media tiene que ser de ${TODAY_RESULT_CHARS} caracteres (~${K(tok(TODAY_RESULT_CHARS))}): ${M(calModel.input)}, pico ${K(calModel.peak)}. Ese tamaño es una inferencia de UNA corrida.\n`)
console.log(`${pad("escenario", 78)} ${lpad("turnos/scout", 12)} ${lpad("entrada", 9)} ${lpad("(a 2,5)", 9)} ${lpad("pico", 8)}`)
for (const s of scenarios) console.log(`${pad(s.label, 78)} ${lpad(s.loop.turns, 12)} ${lpad(M(s.input), 9)} ${lpad(M(s.dense), 9)} ${lpad(K(s.peak), 8)}`)
console.log(`\nPrefijo fijo por turno: ${K(SCOUT_PREFIX_TOKENS)} (medido). Tope por resultado: ${RESULT_CAP_CHARS} caracteres. Resultados anteriores a ${KEEP_FULL_TURNS} turnos: ${CLEARED_CHARS} caracteres.`)
console.log(`Aviso: el modelo del loop es una simulación con las reglas reales de recorte, no una medición; la calibración dice cuánto fiarse.`)
process.exit(0)
