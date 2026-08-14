import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote,
} from "../cli-ui.ts"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeNarrativeDoc, CodeTaskDoc } from "@johpaz/hivecode-core/storage/collections"

async function listNarrative(): Promise<CodeNarrativeDoc[]> {
  return (await (await col<CodeNarrativeDoc>("codeNarrative")).scan())
    .map((entry) => entry.doc)
}

export async function narrativeShow(args: string[]): Promise<void> {
  const taskFlag = args.find(a => a.startsWith("--task="))
  const taskId = taskFlag ? taskFlag.split("=")[1] : undefined
  const lastFlag = args.find(a => a.startsWith("--last="))
  const lastN = lastFlag ? parseInt(lastFlag.split("=")[1] ?? "10", 10) : 10

  hiveIntro("hivecode · Narrativo")

  const rows = (await listNarrative())
    .filter((entry) => !taskId || entry.task_id === taskId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, lastN)

  if (rows.length === 0) {
    hiveNote("Sin entradas", ["No hay entradas en el narrativo para los criterios dados."])
    hiveOutro("Narrativo vacío")
    return
  }

  if (taskId && rows.length > 0) {
    const taskRow = (await (await col<CodeTaskDoc>("codeTasks")).get(taskId))?.doc
    if (taskRow) {
      process.stdout.write(`  │  Tarea: ${taskRow.description}\n`)
      process.stdout.write(`  │  Estado: ${taskRow.status}\n`)
      process.stdout.write(`  │\n`)
    }
  }

  const entries = rows.reverse()
  for (const entry of entries) {
    const badges = []
    if (entry.is_draft) badges.push("DRAFT")
    if (entry.is_override) badges.push("OVERRIDE")

    const date = new Date(entry.created_at).toLocaleString("es-CO", {
      hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
    })

    hivePhaseComplete(entry.coordinator, `[${date}] ${entry.coordinator}${badges.length > 0 ? ` · ${badges.join(" ")}` : ""}`)

    const lines = entry.entry.split("\n").slice(0, 8)
    for (const line of lines) {
      process.stdout.write(`  │    ${line}\n`)
    }
    if (entry.entry.split("\n").length > 8) {
      process.stdout.write(`  │    ... (${entry.entry.split("\n").length - 8} líneas más)\n`)
    }
    process.stdout.write(`  │\n`)
  }

  hiveOutro(`Mostrando ${entries.length} entrada(s)`)
}

export async function narrativeSearch(args: string[]): Promise<void> {
  const query = args[0]

  if (!query) {
    hiveOutro("Uso: hivecode narrative search <query>", "error")
    process.exit(1)
  }

  hiveIntro("hivecode · Buscar en Narrativo")

  const needle = query.toLowerCase()
  const rows = (await listNarrative())
    .filter((entry) =>
      entry.entry.toLowerCase().includes(needle) ||
      entry.coordinator.toLowerCase().includes(needle) ||
      (entry.phase ?? "").toLowerCase().includes(needle)
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20)

  if (rows.length === 0) {
    hiveNote("Sin resultados", [`No se encontraron entradas para: "${query}"`])
    hiveOutro("Búsqueda sin resultados")
    return
  }

  for (const entry of rows) {
    const date = new Date(entry.created_at).toLocaleDateString("es-CO")
    hivePhaseComplete(entry.coordinator, `[${date}] ${entry.coordinator}`)
    const preview = entry.entry.slice(0, 200).replace(/\n/g, " ")
    process.stdout.write(`  │    ${preview}...\n\n`)
  }

  hiveOutro(`${rows.length} resultado(s) encontrado(s)`)
}

export async function narrativeExport(args: string[]): Promise<void> {
  const formatFlag = args.find(a => a.startsWith("--format="))
  const format = formatFlag ? formatFlag.split("=")[1] : "md"

  hiveIntro("hivecode · Exportar Narrativo")

  const rows = (await listNarrative()).sort((a, b) => a.created_at.localeCompare(b.created_at))

  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    console.log("# Hive-Code Narrativo\n")
    for (const entry of rows) {
      const date = new Date(entry.created_at).toISOString()
      console.log(`## [${entry.coordinator}] ${date}`)
      console.log()
      console.log(entry.entry)
      console.log()
      console.log("---")
      console.log()
    }
  }

  hiveOutro(`Exportado ${rows.length} entrada(s) en formato ${format}`)
}
