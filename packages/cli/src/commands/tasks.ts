import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

export async function tasks(subcommand?: string, args?: string[]): Promise<void> {
  const db = getDb()

  try {
    db.query("SELECT 1 FROM code_tasks LIMIT 1").get()
  } catch {
    console.log("No code_tasks table found. Run 'hive-code migrate' first.")
    return
  }

  switch (subcommand) {
    case "list": {
      const status = args?.[0]
      const rows = (status
        ? db.query("SELECT * FROM code_tasks WHERE status = ? ORDER BY created_at DESC LIMIT 20").all(status)
        : db.query("SELECT * FROM code_tasks ORDER BY created_at DESC LIMIT 20").all()) as any[]
      if (rows.length === 0) { console.log("No tasks found."); return }
      console.log("Tasks:")
      for (const r of rows) {
        const statusIcon: Record<string, string> = {
          pending: "⏳", planning: "📋", running: "🔄", paused: "⏸️",
          completed: "✅", failed: "❌", cancelled: "🚫",
        }
        console.log(` ${statusIcon[r.status] || "◻"} ${r.id.slice(0, 8)} — ${r.description.slice(0, 60)} [${r.status}]`)
        if (r.branch_name) console.log(`    branch: ${r.branch_name}`)
        if (r.pr_url) console.log(`    PR: ${r.pr_url}`)
      }
      break
    }
    case "status": {
      const id = args?.[0]
      if (!id) { console.log("Usage: hive-code task status <id>"); return }
      const task = db.query("SELECT * FROM code_tasks WHERE id LIKE ?").get(`%${id}%`) as any
      if (!task) { console.log("Task not found."); return }
      console.log(`\nTask: ${task.id}`)
      console.log(`Description: ${task.description}`)
      console.log(`Status: ${task.status}`)
      console.log(`Mode: ${task.mode}`)
      if (task.branch_name) console.log(`Branch: ${task.branch_name}`)
      if (task.pr_url) console.log(`PR: ${task.pr_url}`)
      console.log(`Created: ${task.created_at}`)
      if (task.completed_at) console.log(`Completed: ${task.completed_at}`)

      const phases = db.query("SELECT * FROM code_task_phases WHERE task_id = ? ORDER BY id").all(task.id) as any[]
      if (phases.length > 0) {
        console.log("\nPhases:")
        for (const p of phases) {
          const icon: Record<string, string> = { pending: "⏳", running: "🔄", completed: "✅", skipped: "⏭️", failed: "❌" }
          console.log(`  ${icon[p.status] || "◻"} ${p.phase_name} (${p.coordinator}) [${p.status}]`)
        }
      }

      const narrative = db.query("SELECT * FROM code_narrative WHERE task_id = ? ORDER BY id DESC LIMIT 5").all(task.id) as any[]
      if (narrative.length > 0) {
        console.log("\nRecent narrative:")
        for (const n of narrative.reverse()) {
          console.log(`  [${n.coordinator}] ${n.entry.slice(0, 120)}`)
        }
      }
      break
    }
    case "cancel": {
      const id = args?.[0]
      if (!id) { console.log("Usage: hive-code task cancel <id>"); return }
      db.query("UPDATE code_tasks SET status = 'cancelled', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id LIKE ?").run(`%${id}%`)
      console.log("✅ Task cancelled.")
      break
    }
    case "rollback": {
      const id = args?.[0]
      if (!id) { console.log("Usage: hive-code task rollback <id>"); return }
      const snapshots = db.query("SELECT * FROM code_file_snapshots WHERE task_id LIKE ? ORDER BY id DESC").all(`%${id}%`) as any[]
      if (snapshots.length === 0) { console.log("No snapshots found for this task."); return }
      console.log(`Rolling back ${snapshots.length} file(s)...`)
      for (const snap of snapshots) {
        try {
          await Bun.write(snap.file_path, snap.content)
          console.log(`  ✅ Restored: ${snap.file_path}`)
        } catch (err) {
          console.log(`  ❌ Failed to restore ${snap.file_path}: ${(err as Error).message}`)
        }
      }
      db.query("DELETE FROM code_file_snapshots WHERE task_id LIKE ?").run(`%${id}%`)
      db.query("UPDATE code_tasks SET status = 'cancelled', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id LIKE ?").run(`%${id}%`)
      console.log("✅ Rollback complete.")
      break
    }
    case "resume": {
      const id = args?.[0]
      if (!id) { console.log("Usage: hive-code task resume <id>"); return }
      db.query("UPDATE code_tasks SET status = 'running' WHERE id LIKE ? AND status IN ('paused', 'pending')").run(`%${id}%`)
      console.log("✅ Task resumed.")
      break
    }
    default:
      console.log("Usage:")
      console.log("  hive-code task list [status]       Listar tareas")
      console.log("  hive-code task status <id>         Mostrar detalles de tarea")
      console.log("  hive-code task cancel <id>         Cancelar tarea")
      console.log("  hive-code task rollback <id>       Revertir archivos")
      console.log("  hive-code task resume <id>         Reanudar tarea")
  }
}
