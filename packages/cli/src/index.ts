#!/usr/bin/env bun

import { doctor } from "./commands-code/doctor"
import { upgrade } from "./commands-code/extras"
import { repl } from "./commands-code/repl"
import { freeDispatch } from "./commands-code/free"
import { login, logout, whoami } from "./commands-code/auth"
import { agentList, agentInspect, agentEdit, agentReset } from "./commands-code/agent"
import { providerList, providerAdd, providerRemove, providerEdit, providerSetDefault, providerSetModel, providerTest } from "./commands-code/provider"
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

  hivecode                     Iniciar el entorno de trabajo (REPL/TUI)
  hivecode login               Autenticarse vía Firebase (browser) para hivecode-free
  hivecode logout              Cerrar sesión hivecode-free
  hivecode whoami              Mostrar sesión actual
  hivecode doctor              Diagnóstico del sistema
  hivecode agent list          Listar agentes
  hivecode agent inspect <name> Ver detalles de un agente
  hivecode agent edit <name>   Editar system prompt de un agente
  hivecode agent reset <name>  Restaurar system prompt de un agente
  hivecode provider list       Listar providers configurados
  hivecode provider add [name] Añadir provider de IA
  hivecode provider remove <name>  Eliminar provider
  hivecode provider edit [name]    Editar provider
  hivecode provider set-default <name>  Establecer provider por defecto
  hivecode provider set-model <provider> <model>  Asignar modelo a provider
  hivecode provider test [name]    Probar conexión a provider
  hivecode upgrade             Verificar actualizaciones
  hivecode exit                Detener el sistema
  hivecode free                Modelos hivecode-free (requiere login)

  --version, -v                Mostrar versión
  --help, -h                   Mostrar esta ayuda
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

  const skipInit = command !== undefined && ["--help", "-h", "--version", "-v", "upgrade", "exit"].includes(command)
  if (!skipInit) ensureGlobalInit()

  switch (command) {
    case undefined:
      ensureGlobalInit()
      await repl()
      break

    case "doctor":
      ensureGlobalInit()
      await doctor(flags)
      break

    case "agent": {
      ensureGlobalInit()
      const sub = normalizedArgs[1]
      const rest = normalizedArgs.slice(2)
      switch (sub) {
        case "list":
          await agentList(rest)
          break
        case "inspect":
          await agentInspect(rest[0])
          break
        case "edit":
          await agentEdit(rest[0])
          break
        case "reset":
          await agentReset(rest[0])
          break
        default:
          console.error(`❌ Subcomando de agent desconocido: "${sub}"`)
          console.log(HELP)
          process.exit(1)
      }
      break
    }

    case "provider": {
      ensureGlobalInit()
      const sub = normalizedArgs[1]
      const rest = normalizedArgs.slice(2)
      switch (sub) {
        case "list":
          await providerList()
          break
        case "add":
          await providerAdd(rest[0])
          break
        case "remove":
          await providerRemove(rest[0])
          break
        case "edit":
          await providerEdit(rest[0])
          break
        case "set-default":
          await providerSetDefault(rest[0])
          break
        case "set-model":
          await providerSetModel(rest)
          break
        case "test":
          await providerTest(rest[0])
          break
        default:
          console.error(`❌ Subcomando de provider desconocido: "${sub}"`)
          console.log(HELP)
          process.exit(1)
      }
      break
    }

    case "upgrade":
      await upgrade()
      break

    case "exit":
      await stop()
      break

    case "free":
      ensureGlobalInit()
      await freeDispatch(normalizedArgs.slice(1))
      break

    case "login":
      ensureGlobalInit()
      await login()
      break

    case "logout":
      ensureGlobalInit()
      await logout()
      break

    case "whoami":
      ensureGlobalInit()
      await whoami()
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
