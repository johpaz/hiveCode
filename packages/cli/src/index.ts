#!/usr/bin/env bun

// ─── Hive-Code Commands (SPEC.md) ───────────────────────────────────────────
// Commands that use the new Hive-Code UI theme with @clack/core

import { plan } from "./commands-code/plan"
import { run } from "./commands-code/run"
import { narrativeShow, narrativeSearch, narrativeExport } from "./commands-code/narrative"
import { decisionList, decisionShow } from "./commands-code/decisions"
import { doctor } from "./commands-code/doctor"
import { dev } from "./commands-code/dev"
import { providerList, providerAdd, providerRemove, providerSetDefault, providerSetModel, providerTest } from "./commands-code/provider"
import { mcpList, mcpAdd, mcpRemove, mcpEnable, mcpDisable, mcpTest, mcpInspect } from "./commands-code/mcp"
import { skillList, skillEnable, skillDisable, skillAdd, skillRemove, skillInspect, skillAssign } from "./commands-code/skill"
import { agentList, agentInspect, agentEdit, agentReset } from "./commands-code/agent"
import { modeHistory, taskRollback, taskResume, upgrade, init } from "./commands-code/extras"
import { repl } from "./commands-code/repl"
import { telegramConnect, telegramDisconnect, telegramStatus } from "./commands-code/telegram"

// ─── Hive Base Commands (existing, no @clack/prompts) ────────────────────────
// These commands don't use @clack/prompts so they still work

import { start, stop, status, reload } from "./commands/gateway"
import { mode } from "./commands/mode"
import { tasks } from "./commands/tasks"
import { secrets } from "./commands/secrets"
import { notes } from "./commands/notes"
import { ace } from "./commands/ace"
import { github } from "./commands/github"
import { coordinator } from "./commands/coordinator"

import { initializeDatabase } from "@johpaz/hive-code-core/storage/sqlite"
import { seedAllData } from "@johpaz/hive-code-core/storage/seed"
import { initializeCodeDatabase, validateCodeSchema } from "@johpaz/hive-code-code/narrative"
import { seedCodeData } from "@johpaz/hive-code-code/seed"
import { logger } from "@johpaz/hive-code-core/utils/logger"

import pkg from "../../../package.json"

const VERSION = pkg.version

const HELP = `
╔══════════════════════════════════════════╗
║     hive-code — Multi-AI Coding Tool    ║
║     v${VERSION}                             ║
╚══════════════════════════════════════════╝

Usage: hive-code <command> [subcommand] [options]

Modos de operación:
  mode get|status            Mostrar modo actual
  mode set <mode>            plan|approval|auto
  mode history               Historial de cambios de modo
  mode cycle                 Ciclar al siguiente modo

Gateway:
  start [--mode <mode>]      Iniciar el gateway
  dev [--prod]               Modo desarrollo (--prod para producción-like)
  stop                       Detener el gateway
  reload                     Recargar config
  status                     Estado del sistema

Providers LLM:
  provider list              Listar providers
  provider add <name>        Añadir provider (wizard)
  provider remove <name>     Eliminar provider
  provider set-default <n>   Provider por defecto
  provider set-model <p> <m> Asignar modelo
  provider test <name>       Ping con latencia

MCP:
  mcp list                   Listar servidores MCP
  mcp add <url-or-name>      Añadir MCP server
  mcp remove <name>          Eliminar MCP
  mcp enable <name>          Habilitar MCP
  mcp disable <name>         Deshabilitar MCP
  mcp test <name>            Verificar conexión
  mcp inspect <name>         Ver detalles MCP

Skills:
  skill list                 Listar skills
  skill enable <name>        Habilitar skill
  skill disable <name>       Deshabilitar skill
  skill add <path>           Importar skill .md
  skill remove <name>        Eliminar skill
  skill inspect <name>       Ver skill
  skill assign <sk> <coord>  Asignar a coordinador

Coordinadores y Agentes:
  coordinator list           Listar coordinadores
  coordinator status <name>  Estado de un coordinador
  coordinator restart <name> Reiniciar coordinador
  coordinator pause <name>   Pausar coordinador
  coordinator resume <name>  Reanudar coordinador

  agent list                 Listar agentes/subagentes
  agent inspect <name>       Ver detalles de un agente
  agent edit <name>          Editar system prompt en $EDITOR
  agent reset <name>         Restaurar prompt por defecto

Tareas de código:
  plan "<desc>"              Modo plan: diseña sin tocar código
  run "<desc>"               Modo auto: ejecuta completo
  task list                  Listar tareas
  task status <id>           Estado de tarea
  task cancel <id>           Cancelar tarea
  task rollback <id>         Revertir archivos + git
  task resume <id>           Reanudar tarea pausada

Narrativo y decisiones:
  narrative show             Mostrar narrativo de tarea
  narrative search <query>   Buscar en narrativo
  narrative export           Exportar narrativo
  decision list              Listar ADRs
  decision show <id>         Ver ADR

GitHub:
  github connect             Conectar con GitHub (OAuth)
  github disconnect          Desconectar
  github status              Estado de integración
  github set-repo <repo>     Configurar repositorio
  github whoami              Ver usuario conectado

Telegram:
  telegram connect           Conectar bot de Telegram (wizard Rezi)
  telegram disconnect        Desconectar bot
  telegram status            Estado e info del bot

Secrets:
  secret list                Listar secrets (solo nombres)
  secret set <name>          Establecer secret
  secret delete <name>       Eliminar secret
  secret rotate <name>       Rotar secret

Notas (scratchpad):
  note list                  Listar notas
  note add <key> <val>       Añadir nota
  note get <key>             Leer nota
  note delete <key>          Eliminar nota

ACE:
  ace status                 Estado del ACE
  ace playbook list          Listar reglas del playbook
  ace playbook reset         Resetear playbook
  ace reflector run          Forzar análisis inmediato

Sistema:
  init [path]                Inicializar proyecto
  doctor                     Diagnóstico completo
  doctor --fix               Correcciones automáticas
  upgrade                    Verificar actualizaciones
  migrate                    Migrar base de datos
  onboard                    Configuración inicial

Options:
  --help, -h                 Mostrar esta ayuda
  --version, -v              Mostrar versión

Examples:
  hive-code mode set auto        Modo ejecución automática
  hive-code plan "añadir auth JWT"  Diseñar sin implementar
  hive-code run "crear API REST"    Ejecutar tarea completa
  hive-code doctor               Diagnosticar el sistema
`

let _dbInitialized = false

function ensureGlobalInit(): void {
  if (_dbInitialized) return
  try {
    initializeDatabase()
    initializeCodeDatabase()
    seedAllData()
    seedCodeData()
    validateCodeSchema()
    _dbInitialized = true
    logger.info("[cli] 🚀 Global init complete — DB, schemas, seeds, validation OK")
  } catch (err) {
    logger.error("[cli] ❌ Global init failed:", (err as Error).message)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const isDev = process.argv[1]?.endsWith(".ts")
  const args = process.argv.slice(isDev ? 2 : 1)
  const normalizedArgs = args[0]?.includes("\\") || args[0]?.includes("/") ? args.slice(1) : args
  const command = normalizedArgs[0]
  const subcommand = normalizedArgs[1]
  const flags = normalizedArgs.filter((a) => a.startsWith("--"))

  // Centralized initialization for all commands except help/version/gateway-only
  const skipInit = ["--help", "-h", "--version", "-v"].includes(command)
  if (!skipInit) {
    ensureGlobalInit()
  }

  switch (command) {
    // ─── Hive-Code UI Commands ─────────────────────────────────────────────
    case "plan":
      await plan(subcommand)
      break
    case "run":
      await run(subcommand, flags)
      break
    case "dev":
      await dev(flags)
      break
    case "doctor":
      await doctor(flags)
      break
    case "init":
      await init(subcommand)
      break
    case "upgrade":
      await upgrade()
      break

    // ─── Providers ─────────────────────────────────────────────────────────
    case "provider":
    case "providers": {
      if (subcommand === "list" || subcommand === undefined) await providerList()
      else if (subcommand === "add") await providerAdd(args[2])
      else if (subcommand === "remove") await providerRemove(args[2])
      else if (subcommand === "set-default") await providerSetDefault(args[2])
      else if (subcommand === "set-model") await providerSetModel(args.slice(2))
      else if (subcommand === "test") await providerTest(args[2])
      else {
        console.error(`❌ Subcomando desconocido: "${subcommand}"`)
        process.exit(1)
      }
      break
    }

    // ─── MCP ───────────────────────────────────────────────────────────────
    case "mcp": {
      if (subcommand === "list" || subcommand === undefined) await mcpList()
      else if (subcommand === "add") await mcpAdd(args[2])
      else if (subcommand === "remove") await mcpRemove(args[2])
      else if (subcommand === "enable") await mcpEnable(args[2])
      else if (subcommand === "disable") await mcpDisable(args[2])
      else if (subcommand === "test") await mcpTest(args[2])
      else if (subcommand === "inspect") await mcpInspect(args[2])
      else {
        console.error(`❌ Subcomando desconocido: "${subcommand}"`)
        process.exit(1)
      }
      break
    }

    // ─── Skills ────────────────────────────────────────────────────────────
    case "skill":
    case "skills": {
      if (subcommand === "list" || subcommand === undefined) await skillList()
      else if (subcommand === "enable") await skillEnable(args[2])
      else if (subcommand === "disable") await skillDisable(args[2])
      else if (subcommand === "add") await skillAdd(args[2])
      else if (subcommand === "remove") await skillRemove(args[2])
      else if (subcommand === "inspect") await skillInspect(args[2])
      else if (subcommand === "assign") await skillAssign(args.slice(2))
      else {
        console.error(`❌ Subcomando desconocido: "${subcommand}"`)
        process.exit(1)
      }
      break
    }

    // ─── Agents ────────────────────────────────────────────────────────────
    case "agent":
    case "agents": {
      if (subcommand === "list" || subcommand === undefined) await agentList(args.slice(2))
      else if (subcommand === "inspect") await agentInspect(args[2])
      else if (subcommand === "edit") await agentEdit(args[2])
      else if (subcommand === "reset") await agentReset(args[2])
      else {
        console.error(`❌ Subcomando desconocido: "${subcommand}"`)
        process.exit(1)
      }
      break
    }

    // ─── Narrative & Decisions ─────────────────────────────────────────────
    case "narrative": {
      if (subcommand === "search") {
        await narrativeSearch(args.slice(2))
      } else if (subcommand === "export") {
        await narrativeExport(flags)
      } else {
        await narrativeShow(flags)
      }
      break
    }
    case "decision":
    case "decisions": {
      if (subcommand === "list" || subcommand === undefined) {
        await decisionList()
      } else if (subcommand === "show") {
        await decisionShow(args.slice(2))
      } else {
        console.error(`❌ Subcomando desconocido: "${subcommand}"`)
        process.exit(1)
      }
      break
    }

    // ─── Hive Base Commands ────────────────────────────────────────────────
    case "mode": {
      if (subcommand === "history") {
        await modeHistory()
      } else {
        await mode(subcommand)
      }
      break
    }
    case "start":
      await start(flags)
      break
    case "stop":
      await stop()
      break
    case "reload":
      await reload()
      break
    case "status":
      await status(flags)
      break
    case "task":
    case "tasks": {
      if (subcommand === "rollback") {
        await taskRollback(args[2])
      } else if (subcommand === "resume") {
        await taskResume(args[2])
      } else {
        await tasks(subcommand, args.slice(2))
      }
      break
    }
    case "secret":
    case "secrets":
      await secrets(subcommand, args.slice(2))
      break
    case "note":
    case "notes":
      await notes(subcommand, args.slice(2))
      break
    case "ace":
      await ace(subcommand, args.slice(2))
      break
    case "github":
      await github(subcommand, args.slice(2))
      break
    case "coordinator":
      await coordinator(subcommand, args.slice(2))
      break
    // ─── Telegram ──────────────────────────────────────────────────────────
    case "telegram": {
      if (subcommand === "connect") await telegramConnect()
      else if (subcommand === "disconnect") await telegramDisconnect()
      else if (subcommand === "status") await telegramStatus()
      else {
        console.error(`❌ Subcomando desconocido: "${subcommand}"`)
        console.log("  telegram connect      Conectar bot")
        console.log("  telegram disconnect   Desconectar bot")
        console.log("  telegram status       Ver estado")
        process.exit(1)
      }
      break
    }

    case "onboard": {
      console.log("Onboarding — use the web setup UI at http://localhost:16120/setup")
      break
    }
    case "migrate": {
      console.log("Database migration — run `bun run migrate` from the project root.")
      break
    }

    // ─── Meta ──────────────────────────────────────────────────────────────
    case "--version":
    case "-v":
    case "version":
      console.log(`hive-code v${VERSION}`)
      process.exit(0)
      break
    case "--help":
    case "-h":
    case "help":
      console.log(HELP)
      break
    case undefined:
      await repl()
      break
    default:
      console.error(`❌ Comando desconocido: "${command}"\n`)
      console.log(HELP)
      process.exit(1)
  }
}

// ─── Global Error Handlers (FASE 2) ─────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error("[cli] Uncaught exception:", err)
  process.exit(1)
})
process.on("unhandledRejection", (reason, promise) => {
  logger.error(`[cli] Unhandled rejection at: ${promise}, reason: ${reason}`)
})

main().catch((error) => {
  logger.error("[cli] Fatal error:", error.message)
  process.exit(1)
})
