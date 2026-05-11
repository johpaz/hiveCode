/**
 * Dev command stub — replaces commands/dev.ts that used @clack/prompts.
 * Runs the gateway in dev mode with Hive-Code UI.
 */

import { hiveIntro, hiveOutro, hiveSpinner } from "../ui/index.ts"
import { getHiveDir } from "@johpaz/hive-code-core/config/loader"
import * as path from "node:path"

export async function dev(): Promise<void> {
  hiveIntro("hive-code · Dev Mode")

  const hiveDir = getHiveDir()
  const spinner = hiveSpinner("default")
  spinner.start(`Iniciando en modo desarrollo (${hiveDir})...`)

  try {
    const { start } = await import("../commands/gateway")
    await start(["--dev-internal"])
    spinner.stop("Gateway iniciado en modo dev")
  } catch (err) {
    spinner.stop(`Error: ${(err as Error).message}`, "error")
    hiveOutro("Modo dev fallido", "error")
    process.exit(1)
  }
}
