import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

export async function notes(subcommand?: string, args?: string[]): Promise<void> {
  const db = getDb()
  const threadId = process.env.HIVE_THREAD_ID || "cli-default"

  switch (subcommand) {
    case "list": {
      const rows = db.query("SELECT * FROM scratchpad WHERE thread_id = ? ORDER BY updated_at DESC").all(threadId) as any[]
      if (rows.length === 0) { console.log("No notes for this thread."); return }
      console.log("Notes:")
      for (const r of rows) console.log(`  ${r.key}: ${r.value.slice(0, 120)}`)
      break
    }
    case "add": {
      const key = args?.[0]
      const value = args?.slice(1).join(" ")
      if (!key || !value) { console.log("Usage: hive-code note add <key> <value>"); return }
      db.query(
        "INSERT OR REPLACE INTO scratchpad (thread_id, key, value, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
      ).run(threadId, key, value)
      console.log(`✅ Note saved: ${key}`)
      break
    }
    case "get": {
      const key = args?.[0]
      if (!key) { console.log("Usage: hive-code note get <key>"); return }
      const row = db.query("SELECT value FROM scratchpad WHERE thread_id = ? AND key = ?").get(threadId, key) as any
      if (row) console.log(row.value)
      else console.log(`Note '${key}' not found.`)
      break
    }
    case "delete": {
      const key = args?.[0]
      if (!key) { console.log("Usage: hive-code note delete <key>"); return }
      db.query("DELETE FROM scratchpad WHERE thread_id = ? AND key = ?").run(threadId, key)
      console.log(`✅ Note '${key}' deleted.`)
      break
    }
    default:
      console.log("Usage:")
      console.log("  hive-code note list              Listar notas")
      console.log("  hive-code note add <key> <val>   Añadir nota")
      console.log("  hive-code note get <key>         Leer nota")
      console.log("  hive-code note delete <key>      Eliminar nota")
  }
}
