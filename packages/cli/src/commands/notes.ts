import { deleteScratchpadNote, getScratchpad, saveScratchpadNote } from "@johpaz/hivecode-core/agent/conversation-store"

export async function notes(subcommand?: string, args?: string[]): Promise<void> {
  const threadId = process.env.HIVE_THREAD_ID || "cli-default"

  switch (subcommand) {
    case "list": {
      const rows = await getScratchpad(threadId)
      if (rows.length === 0) { console.log("No notes for this thread."); return }
      console.log("Notes:")
      for (const r of rows) console.log(`  ${r.key}: ${r.value.slice(0, 120)}`)
      break
    }
    case "add": {
      const key = args?.[0]
      const value = args?.slice(1).join(" ")
      if (!key || !value) { console.log("Usage: hivecode note add <key> <value>"); return }
      await saveScratchpadNote(threadId, key, value, "cli")
      console.log(`✅ Note saved: ${key}`)
      break
    }
    case "get": {
      const key = args?.[0]
      if (!key) { console.log("Usage: hivecode note get <key>"); return }
      const row = (await getScratchpad(threadId)).find((entry) => entry.key === key)
      if (row) console.log(row.value)
      else console.log(`Note '${key}' not found.`)
      break
    }
    case "delete": {
      const key = args?.[0]
      if (!key) { console.log("Usage: hivecode note delete <key>"); return }
      await deleteScratchpadNote(threadId, key)
      console.log(`✅ Note '${key}' deleted.`)
      break
    }
    default:
      console.log("Usage:")
      console.log("  hivecode note list              Listar notas")
      console.log("  hivecode note add <key> <val>   Añadir nota")
      console.log("  hivecode note get <key>         Leer nota")
      console.log("  hivecode note delete <key>      Eliminar nota")
  }
}
