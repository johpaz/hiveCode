import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveText, isCancel,
} from "../ui/index.ts"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

export async function narrativeShow(args: string[]): Promise<void> {
  const taskFlag = args.find(a => a.startsWith("--task="))
  const taskId = taskFlag ? taskFlag.split("=")[1] : undefined
  const lastFlag = args.find(a => a.startsWith("--last="))
  const lastN = lastFlag ? parseInt(lastFlag.split("=")[1]) : 10

  hiveIntro("hive-code · Narrativo")

  const db = getDb()

  let query = "SELECT * FROM code_narrative"
  const params: any[] = []

  if (taskId) {
    query += " WHERE task_id = ?"
    params.push(taskId)
  }

  query += " ORDER BY id DESC LIMIT ?"
  params.push(lastN)

  const rows = db.query(query).all(...params) as any[]

  if (rows.length === 0) {
    hiveNote("Sin entradas", ["No hay entradas en el narrativo para los criterios dados."])
    hiveOutro("Narrativo vacío")
    return
  }

  // Show task info if filtering by task
  if (taskId && rows.length > 0) {
    const taskRow = db.query("SELECT description, status FROM code_tasks WHERE id = ?").get(taskId) as any
    if (taskRow) {
      process.stdout.write(`  │  Tarea: ${taskRow.description}\n`)
      process.stdout.write(`  │  Estado: ${taskRow.status}\n`)
      process.stdout.write(`  │\n`)
    }
  }

  // Show entries (reverse to show chronological order)
  const entries = rows.reverse()
  for (const entry of entries) {
    const coordinator = entry.coordinator
    const isDraft = entry.is_draft === 1
    const isOverride = entry.is_override === 1

    const badges = []
    if (isDraft) badges.push("DRAFT")
    if (isOverride) badges.push("OVERRIDE")

    const date = new Date(entry.created_at).toLocaleString("es-CO", {
      hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
    })

    hivePhaseComplete(coordinator, `[${date}] ${coordinator}${badges.length > 0 ? ` · ${badges.join(" ")}` : ""}`)

    // Show entry content (truncated)
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
    hiveOutro("Uso: hive-code narrative search <query>", "error")
    process.exit(1)
  }

  hiveIntro("hive-code · Buscar en Narrativo")

  const db = getDb()
  const rows = db.query(
    `SELECT n.* FROM code_narrative n
     JOIN code_narrative_fts fts ON n.id = fts.rowid
     WHERE code_narrative_fts MATCH ? ORDER BY rank LIMIT 20`
  ).all(query) as any[]

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

  hiveIntro("hive-code · Exportar Narrativo")

  const db = getDb()
  const rows = db.query("SELECT * FROM code_narrative ORDER BY id ASC").all() as any[]

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
