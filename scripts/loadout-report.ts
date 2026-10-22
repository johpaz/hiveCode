/**
 * What each role used of the tools it started with, read from the database.
 *
 *   bun scripts/loadout-report.ts                     # the default HiveDB
 *   HIVE_DB_PATH=/path/to/db bun scripts/loadout-report.ts
 *
 * Reads only; changes nothing. `unused` is the list to question when trimming a loadout, `discovery runs`
 * the signal that a tool belongs in the starting set.
 */
import { col } from "../packages/core/src/storage/hive"
import { reportLoadouts, MIN_SAMPLE } from "../packages/core/src/harness/loadout-learning"

const runs = (await (await col<any>("agentRuns")).scan()).map((e: any) => e.doc)
const tools = (await (await col<any>("toolRuns")).scan()).map((e: any) => e.doc)
const reports = reportLoadouts(runs, tools)
if (!reports.length) console.log("Sin runs en esta base de datos.")
for (const r of reports) {
  console.log(`\n## ${r.role} · ${r.runs} run(s)`)
  console.log(`  cargadas: ${r.loaded.length || "— (los runs son anteriores al registro del loadout)"}${r.startTokens ? ` · arranque ≈ ${r.startTokens.tools} tok de tools + ${r.startTokens.skills} de skills` : ""}`)
  console.log(`  sin usar: ${r.unused.length ? r.unused.join(", ") : "—"}`)
  console.log(`  usadas:   ${r.used.slice(0, 10).map(u => `${u.tool}×${u.runs}`).join(", ") || "—"}`)
  console.log(`  runs con búsqueda de capacidades: ${r.discoveryRuns}/${r.runs}${r.diskShare == null ? "" : ` · lecturas a disco: ${Math.round(r.diskShare * 100)} %`}`)
  console.log(`  grupos (ruta/especialidad): ${r.groups.map(g => `${g.route}/${g.specialty}×${g.runs}${g.enough ? "" : `*`}`).join(", ") || "—"}${r.groups.some(g => !g.enough) ? `  (* menos de ${MIN_SAMPLE} runs: sin evidencia, vale el núcleo por defecto)` : ""}`)
  console.log(`  descubiertas tras arrancar: ${r.discovered.slice(0, 10).map(d => `${d.name}(${d.kind})×${d.runs}`).join(", ") || "—"}`)
}
process.exit(0)
