import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote,
} from "@johpaz/hive-code-ui"
import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

export async function decisionList(): Promise<void> {

  hiveIntro("hive-code · Decisiones (ADRs)")

  const db = getDb()
  const rows = db.query("SELECT * FROM code_decisions ORDER BY created_at DESC").all() as any[]

  if (rows.length === 0) {
    hiveNote("Sin ADRs", ["No hay decisiones registradas todavía."])
    hiveOutro("Sin ADRs")
    return
  }

  for (const row of rows) {
    const statusColor = row.status === "active" ? "\x1b[38;5;114m" : "\x1b[38;5;172m"
    const statusIcon = row.status === "active" ? "●" : "○"
    hivePhaseComplete("architecture", `${row.title}`)
    process.stdout.write(`  │    ${statusColor}${statusIcon}${"\x1b[0m"}  ${row.status.toUpperCase()}  ·  ${new Date(row.created_at).toLocaleDateString("es-CO")}\n`)
    process.stdout.write(`  │    ${row.decision.slice(0, 120)}...\n\n`)
  }

  hiveOutro(`${rows.length} ADR(s)`)
}

export async function decisionShow(args: string[]): Promise<void> {

  const id = args[0]

  if (!id) {
    hiveOutro("Uso: hive-code decision show <id>", "error")
    process.exit(1)
  }

  hiveIntro("hive-code · ADR")

  const db = getDb()
  const row = db.query("SELECT * FROM code_decisions WHERE id = ?").get(id) as any

  if (!row) {
    hiveNote("No encontrado", [`No existe ADR con ID: ${id}`])
    hiveOutro("ADR no encontrado", "error")
    process.exit(1)
  }

  console.log(`\n  ${"\x1b[1m\x1b[38;5;214m"}${row.title}${"\x1b[0m"}`)
  console.log(`  ${"\x1b[2m"}ID: ${row.id} · Estado: ${row.status.toUpperCase()} · ${new Date(row.created_at).toLocaleDateString("es-CO")}${"\x1b[0m"}\n`)

  console.log(`  ${"\x1b[1m"}Contexto:${"\x1b[0m"}`)
  console.log(`  ${row.context}\n`)

  console.log(`  ${"\x1b[1m"}Opciones evaluadas:${"\x1b[0m"}`)
  console.log(`  ${row.options}\n`)

  console.log(`  ${"\x1b[1m"}Decisión:${"\x1b[0m"}`)
  console.log(`  ${row.decision}\n`)

  console.log(`  ${"\x1b[1m"}Consecuencias:${"\x1b[0m"}`)
  console.log(`  ${row.consequences}\n`)

  hiveOutro("ADR mostrado")
}
