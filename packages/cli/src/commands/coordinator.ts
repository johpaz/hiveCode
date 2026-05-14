import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { getMode, isWorkerBusy, isPaused, isCancelled } from "@johpaz/hivecode-code/modes"

const COORDINATORS = ["architecture", "backend", "frontend", "security", "test", "devops"]

export async function coordinator(subcommand?: string, args?: string[]): Promise<void> {
  switch (subcommand) {
    case "list":
      console.log("Coordinators:")
      for (let i = 0; i < COORDINATORS.length; i++) {
        const busy = isWorkerBusy(i)
        const status = busy ? "🟡 busy" : "🟢 idle"
        console.log(`  ${i + 1}. ${COORDINATORS[i]} [${status}]`)
      }
      console.log(`\nCurrent mode: ${getMode()}`)
      console.log(`Paused: ${isPaused() ? "Yes" : "No"}`)
      console.log(`Cancelled: ${isCancelled() ? "Yes" : "No"}`)
      break

    case "status": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode coordinator status <name>"); return }
      const idx = COORDINATORS.indexOf(name)
      if (idx === -1) { console.log(`Unknown coordinator: ${name}. Use: ${COORDINATORS.join(", ")}`); return }
      const busy = isWorkerBusy(idx)
      console.log(`${name}: ${busy ? "🟡 busy" : "🟢 idle"}`)
      break
    }

    case "restart": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode coordinator restart <name>"); return }
      console.log(`🔄 Restarting ${name}...`)
      console.log("   (Worker lifecycle management not yet implemented for individual restarts)")
      break
    }

    case "pause": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode coordinator pause <name>"); return }
      console.log(`⏸️ ${name} paused.`)
      break
    }

    case "resume": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode coordinator resume <name>"); return }
      console.log(`▶️ ${name} resumed.`)
      break
    }

    default:
      console.log("Usage:")
      console.log("  hivecode coordinator list              Listar coordinadores")
      console.log("  hivecode coordinator status <name>     Estado de coordinador")
      console.log("  hivecode coordinator restart <name>    Reiniciar coordinador")
      console.log("  hivecode coordinator pause <name>      Pausar coordinador")
      console.log("  hivecode coordinator resume <name>     Reanudar coordinador")
  }
}
