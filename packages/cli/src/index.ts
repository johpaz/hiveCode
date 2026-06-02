#!/usr/bin/env bun

import { doctor } from "./commands-code/doctor"
import { upgrade } from "./commands-code/extras"
import { repl } from "./commands-code/repl"
import { stop } from "./commands/gateway"
import { logger } from "@johpaz/hivecode-core/utils/logger"
import pkg from "../../../package.json"

const VERSION = pkg.version

const HELP = `
╔══════════════════════════════════════════╗
║     hivecode — Multi-AI Coding Tool      ║
║     v${VERSION}                              ║
╚══════════════════════════════════════════╝

Uso: hivecode [comando]

  hivecode           Iniciar el entorno de trabajo
  hivecode doctor    Diagnóstico del sistema
  hivecode upgrade   Verificar actualizaciones
  hivecode exit      Detener el sistema

  --version, -v      Mostrar versión
  --help, -h         Mostrar esta ayuda
`

import { bootstrap, registerModule } from "@johpaz/hivecode-core"
import { HiveCodeModule } from "@johpaz/hivecode-code"

let _dbInitialized = false

function ensureGlobalInit(): void {
  if (_dbInitialized) return
  if (!process.env.HIVE_DEV) logger.setLevel("warn")
  try {
    registerModule(HiveCodeModule)
    bootstrap()
    _dbInitialized = true
  } catch (err) {
    logger.error("[cli] ❌ Error de inicialización:", (err as Error).message)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const isDev = process.argv[1]?.endsWith(".ts")
  const args = process.argv.slice(isDev ? 2 : 1)
  const normalizedArgs = args[0]?.includes("\\") || args[0]?.includes("/") ? args.slice(1) : args
  const command = normalizedArgs[0]
  const flags = normalizedArgs.filter(a => a.startsWith("--"))

  const skipInit = ["--help", "-h", "--version", "-v", "upgrade", "exit", undefined].includes(command)
  if (!skipInit) ensureGlobalInit()

  switch (command) {
    case undefined:
      await repl()
      break

    case "doctor":
      ensureGlobalInit()
      await doctor(flags)
      break

    case "upgrade":
      await upgrade()
      break

    case "exit":
      await stop()
      break

    case "--version":
    case "-v":
    case "version":
      console.log(`hivecode v${VERSION}`)
      break

    case "--help":
    case "-h":
    case "help":
      console.log(HELP)
      break

    default:
      console.error(`❌ Comando desconocido: "${command}"`)
      console.log(HELP)
      process.exit(1)
  }
}

process.on("uncaughtException", (err) => {
  logger.error("[cli] Error no capturado:", err)
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  logger.error("[cli] Promesa rechazada:", reason)
})

main().catch(err => {
  logger.error("[cli] Error fatal:", err.message)
  process.exit(1)
})
