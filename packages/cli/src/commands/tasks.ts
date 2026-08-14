import { col } from "@johpaz/hivecode-core/storage/hive"
import type {
  CodeFileSnapshotDoc,
  CodeNarrativeDoc,
  CodeTaskDoc,
  CodeTaskPhaseDoc,
} from "@johpaz/hivecode-core/storage/collections"

function nowIso(): string {
  return new Date().toISOString()
}

async function findTask(id: string): Promise<{ id: string; doc: CodeTaskDoc; version: number } | null> {
  const tasks = await col<CodeTaskDoc>("codeTasks")
  const exact = await tasks.get(id)
  if (exact) return { id, doc: exact.doc, version: exact.version }
  const rows = await tasks.scan()
  const match = rows.find((entry) => entry.id.startsWith(id) || entry.id.includes(id))
  return match ? { id: match.id, doc: match.doc, version: match.version } : null
}

export async function tasks(subcommand?: string, args?: string[]): Promise<void> {
  switch (subcommand) {
    case "list": {
      const status = args?.[0]
      const rows = (await (await col<CodeTaskDoc>("codeTasks")).scan())
        .map((entry) => entry.doc)
        .filter((task) => !status || task.status === status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 20)
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
      if (!id) { console.log("Usage: hivecode task status <id>"); return }
      const task = await findTask(id)
      if (!task) { console.log("Task not found."); return }
      console.log(`\nTask: ${task.doc.id}`)
      console.log(`Description: ${task.doc.description}`)
      console.log(`Status: ${task.doc.status}`)
      console.log(`Mode: ${task.doc.mode}`)
      if (task.doc.branch_name) console.log(`Branch: ${task.doc.branch_name}`)
      if (task.doc.pr_url) console.log(`PR: ${task.doc.pr_url}`)
      console.log(`Created: ${task.doc.created_at}`)
      if (task.doc.completed_at) console.log(`Completed: ${task.doc.completed_at}`)

      const phases = (await (await col<CodeTaskPhaseDoc>("codeTaskPhases")).findBy("task_id", task.doc.id))
        .map((entry) => entry.doc)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (phases.length > 0) {
        console.log("\nPhases:")
        for (const p of phases) {
          const icon: Record<string, string> = { pending: "⏳", running: "🔄", completed: "✅", skipped: "⏭️", failed: "❌" }
          console.log(`  ${icon[p.status] || "◻"} ${p.phase_name} (${p.coordinator}) [${p.status}]`)
        }
      }

      const narrative = (await (await col<CodeNarrativeDoc>("codeNarrative")).findBy("task_id", task.doc.id))
        .map((entry) => entry.doc)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5)
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
      if (!id) { console.log("Usage: hivecode task cancel <id>"); return }
      const task = await findTask(id)
      if (task) {
        await (await col<CodeTaskDoc>("codeTasks")).put(task.id, { ...task.doc, status: "cancelled", completed_at: nowIso() }, { expectedVersion: task.version })
      }
      console.log("✅ Task cancelled.")
      break
    }
    case "rollback": {
      const id = args?.[0]
      if (!id) { console.log("Usage: hivecode task rollback <id>"); return }
      const task = await findTask(id)
      if (!task) { console.log("Task not found."); return }
      const snapshots = (await (await col<CodeFileSnapshotDoc>("codeFileSnapshots")).findBy("task_id", task.doc.id))
        .map((entry) => entry.doc)
        .sort((a, b) => b.id.localeCompare(a.id))
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
      const snapshotCol = await col<CodeFileSnapshotDoc>("codeFileSnapshots")
      for (const snap of snapshots) await snapshotCol.delete(snap.id)
      await (await col<CodeTaskDoc>("codeTasks")).put(task.id, { ...task.doc, status: "cancelled", completed_at: nowIso() }, { expectedVersion: task.version })
      console.log("✅ Rollback complete.")
      break
    }
    case "resume": {
      const id = args?.[0]
      if (!id) { console.log("Usage: hivecode task resume <id>"); return }
      const task = await findTask(id)
      if (task && (task.doc.status === "paused" || task.doc.status === "pending")) {
        await (await col<CodeTaskDoc>("codeTasks")).put(task.id, { ...task.doc, status: "running" }, { expectedVersion: task.version })
      }
      console.log("✅ Task resumed.")
      break
    }
    default:
      console.log("Usage:")
      console.log("  hivecode task list [status]       Listar tareas")
      console.log("  hivecode task status <id>         Mostrar detalles de tarea")
      console.log("  hivecode task cancel <id>         Cancelar tarea")
      console.log("  hivecode task rollback <id>       Revertir archivos")
      console.log("  hivecode task resume <id>         Reanudar tarea")
  }
}
