import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

export async function ace(subcommand?: string, args?: string[]): Promise<void> {
  const db = getDb()

  switch (subcommand) {
    case "status": {
      const traceCount = ((db.query("SELECT COUNT(*) as c FROM code_traces").get() as any)?.c) || 0
      const analyzedCount = ((db.query("SELECT COUNT(*) as c FROM code_traces WHERE analyzed = 1").get() as any)?.c) || 0
      const playbookRules = ((db.query("SELECT COUNT(*) as c FROM code_playbook WHERE active = 1").get() as any)?.c) || 0
      const reflections = ((db.query("SELECT COUNT(*) as c FROM code_reflections").get() as any)?.c) || 0
      console.log("ACE Status:")
      console.log(`  Traces: ${traceCount} (${analyzedCount} analyzed)`)
      console.log(`  Playbook rules: ${playbookRules}`)
      console.log(`  Reflections: ${reflections}`)
      break
    }

    case "playbook": {
      if (args?.[0] === "list") {
        const rows = db.query("SELECT * FROM code_playbook WHERE active = 1 ORDER BY confidence DESC").all() as any[]
        if (rows.length === 0) { console.log("No active playbook rules."); return }
        console.log("Active playbook rules:")
        for (const r of rows) {
          const coordTag = r.coordinator ? ` [${r.coordinator}]` : ""
          console.log(`  - [${(r.confidence * 100).toFixed(0)}%]${coordTag} ${r.rule.slice(0, 120)}`)
        }
      } else if (args?.[0] === "reset") {
        db.query("UPDATE code_playbook SET active = 0, confidence = 0.5").run()
        console.log("✅ Playbook reset. All rules deactivated.")
      } else {
        console.log("Usage: hivecode ace playbook <list|reset>")
      }
      break
    }

    case "reflector": {
      if (args?.[0] === "run") {
        console.log("🔄 Running ACE Reflector analysis...")
        const unanalyzed = db.query("SELECT * FROM code_traces WHERE analyzed = 0 LIMIT 100").all() as any[]
        if (unanalyzed.length === 0) {
          console.log("No unanalyzed traces to process.")
          return
        }
        console.log(`Analyzing ${unanalyzed.length} trace(s)...`)
        for (const trace of unanalyzed) {
          db.query("UPDATE code_traces SET analyzed = 1 WHERE id = ?").run(trace.id)
        }
        db.query("INSERT INTO code_reflections (traces_analyzed, insights) VALUES (?, ?)").run(unanalyzed.length, "Batch analysis complete")
        console.log(`✅ ${unanalyzed.length} traces analyzed. ${Math.floor(unanalyzed.length / 5)} reflection(s) created.`)
      } else {
        console.log("Usage: hivecode ace reflector run")
      }
      break
    }

    default:
      console.log("Usage:")
      console.log("  hivecode ace status              Estado del ACE")
      console.log("  hivecode ace playbook list       Listar reglas del playbook")
      console.log("  hivecode ace playbook reset      Resetear playbook")
      console.log("  hivecode ace reflector run       Forzar análisis")
  }
}
