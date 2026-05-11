import { getExecutionMode, setExecutionMode, modeCycle } from "@johpaz/hive-code-core"

export async function mode(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case "plan":
      setExecutionMode("plan")
      console.log("🟡 Modo PLAN — Solo lectura. Solo el Architecture Coordinator ejecuta.")
      console.log("   Cambia con: hive-code mode set approval")
      break

    case "approval":
      setExecutionMode("approval")
      console.log("🟠 Modo APPROVAL — Ejecución completa con checkpoints entre fases.")
      console.log("   Cada fase requiere tu aprobación antes de continuar.")
      break

    case "auto":
      setExecutionMode("auto")
      console.log("🟢 Modo AUTO — Ejecución completa sin pausas.")
      console.log("   Solo se pausa en interrupciones automáticas (CRITICAL, DROP TABLE, etc.).")
      break

    case "get":
    case "status":
    case undefined:
      {
        const current = getExecutionMode()
        const labels: Record<string, string> = {
          plan: "🟡 PLAN — Solo lectura",
          approval: "🟠 APPROVAL — Checkpoints entre fases",
          auto: "🟢 AUTO — Ejecución completa",
        }
        console.log(`\n${labels[current] ?? current}`)
        console.log(`   Próximo: ${modeCycle(current)}`)

        const nextMode = modeCycle(current)
        console.log(`   Shift+Tab cicla a: ${nextMode}`)
      }
      break

    case "cycle":
      {
        const current = getExecutionMode()
        const next = modeCycle(current)
        setExecutionMode(next)
        console.log(`🔄 Modo cambiado: ${current} → ${next}`)
      }
      break

    case "set": {
      const modeArg = process.argv[4]
      if (!modeArg || !["plan", "approval", "auto"].includes(modeArg)) {
        console.log("❌ Uso: hive-code mode set <plan|approval|auto>")
        process.exit(1)
      }
      setExecutionMode(modeArg as "plan" | "approval" | "auto")
      console.log(`✅ Modo establecido: ${modeArg}`)
      break
    }

    default:
      console.log("❌ Uso: hive-code mode <get|set|status|cycle|plan|approval|auto>")
      console.log("   get|status     - Mostrar modo actual")
      console.log("   set <mode>     - Establecer modo (plan|approval|auto)")
      console.log("   cycle          - Ciclar al siguiente modo")
      process.exit(1)
  }
}
