import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodePlaybookDoc, CodeReflectionDoc, CodeTraceDoc } from "@johpaz/hivecode-core/storage/collections"
import { runReflector } from "@johpaz/hivecode-code/agent/reflector"

export async function ace(subcommand?: string, args?: string[]): Promise<void> {
  switch (subcommand) {
    case "status": {
      const traces = (await (await col<CodeTraceDoc>("codeTraces")).scan()).map((entry) => entry.doc)
      const traceCount = traces.length
      const analyzedCount = traces.filter((trace) => trace.analyzed).length
      const playbookRules = (await (await col<CodePlaybookDoc>("codePlaybook")).findBy("active", true)).length
      const reflections = (await (await col<CodeReflectionDoc>("codeReflections")).scan()).length
      console.log("ACE Status:")
      console.log(`  Traces: ${traceCount} (${analyzedCount} analyzed)`)
      console.log(`  Playbook rules: ${playbookRules}`)
      console.log(`  Reflections: ${reflections}`)
      break
    }

    case "playbook": {
      if (args?.[0] === "list") {
        const rows = (await (await col<CodePlaybookDoc>("codePlaybook")).findBy("active", true))
          .map((entry) => entry.doc)
          .sort((a, b) => b.confidence - a.confidence)
        if (rows.length === 0) { console.log("No active playbook rules."); return }
        console.log("Active playbook rules:")
        for (const r of rows) {
          const coordTag = r.coordinator ? ` [${r.coordinator}]` : ""
          console.log(`  - [${(r.confidence * 100).toFixed(0)}%]${coordTag} ${r.rule.slice(0, 120)}`)
        }
      } else if (args?.[0] === "reset") {
        const playbook = await col<CodePlaybookDoc>("codePlaybook")
        const rows = await playbook.scan()
        for (const row of rows) {
          await playbook.put(row.id, { ...row.doc, active: false, confidence: 0.5 }, { expectedVersion: row.version })
        }
        console.log("✅ Playbook reset. All rules deactivated.")
      } else {
        console.log("Usage: hivecode ace playbook <list|reset>")
      }
      break
    }

    case "reflector": {
      if (args?.[0] === "run") {
        console.log("🔄 Running ACE Reflector analysis...")
        const result = await runReflector()
        if (result.traces === 0) {
          console.log("No unanalyzed traces to process.")
          return
        }
        console.log(`✅ ${result.traces} traces analyzed. ${result.rules} rule(s) created.`)
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
