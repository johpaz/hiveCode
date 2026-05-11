#!/usr/bin/env bun

// ─── Hive-Code Commands (SPEC.md) ───────────────────────────────────────────
// Commands that use the new Hive-Code UI theme with @clack/core

import { plan } from "./commands-code/plan"
import { run } from "./commands-code/run"
import { narrativeShow, narrativeSearch, narrativeExport } from "./commands-code/narrative"
import { decisionList, decisionShow } from "./commands-code/decisions"
import { doctor } from "./commands-code/doctor"
import { dev } from "./commands-code/dev"

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
  mode cycle                 Ciclar al siguiente modo

Gateway:
  start [--mode <mode>]      Iniciar el gateway
  dev                        Modo desarrollo (usa ~/.hive-dev)
  stop                       Detener el gateway
  reload                     Recargar config
  status                     Estado del sistema

Coordinadores multi-IA:
  coordinator list           Listar coordinadores
  coordinator status <name>  Estado de un coordinador
  coordinator restart <name> Reiniciar coordinador
  coordinator pause <name>   Pausar coordinador
  coordinator resume <name>  Reanudar coordinador

  agent list                 Listar agentes/subagentes
  agent inspect <name>       Ver detalles de un agente
  agent edit <name>          Editar system prompt
  agent reset <name>         Restaurar prompt por defecto

Tareas de código:
  plan "<desc>"              Modo plan: diseña sin tocar código
  run "<desc>"               Modo auto: ejecuta completo
  task list                  Listar tareas
  task status <id>           Estado de tarea
  task cancel <id>           Cancelar tarea
  task rollback <id>         Revertir archivos + git
  task resume <id>           Reanudar tarea

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
  doctor                     Diagnóstico completo
  doctor --fix               Correcciones automáticas
  update                     Actualizar hive-code
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

async function main(): Promise<void> {
  const isDev = process.argv[1]?.endsWith(".ts")
  const args = process.argv.slice(isDev ? 2 : 1)
  const normalizedArgs = args[0]?.includes("\\") || args[0]?.includes("/") ? args.slice(1) : args
  const command = normalizedArgs[0]
  const subcommand = normalizedArgs[1]
  const flags = normalizedArgs.filter((a) => a.startsWith("--"))

  switch (command) {
    // ─── Hive-Code UI Commands ─────────────────────────────────────────────
    case "plan":
      await plan(subcommand)
      break
    case "run":
      await run(subcommand, flags)
      break
    case "dev":
      await dev()
      break
    case "doctor":
      await doctor(flags)
      break

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
    case "mode":
      await mode(subcommand)
      break
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
    case "tasks":
      await tasks(subcommand, args.slice(2))
      break
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
    case "agent":
    case "agents": {
      // Stub for agent command — was in commands/agents.ts which used @clack/prompts
      console.log("Agent management — use the web UI or API directly.")
      break
    }
    case "onboard": {
      // Stub for onboard command
      console.log("Onboarding — use the web setup UI at http://localhost:18790/setup")
      break
    }
    case "migrate": {
      // Stub for migrate command
      console.log("Database migration — run `bun run migrate` from the project root.")
      break
    }
    case "update": {
      // Stub for update command
      console.log("Update — download the latest release from GitHub.")
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
    case undefined:
      console.log(HELP)
      break
    default:
      console.error(`❌ Comando desconocido: "${command}"\n`)
      console.log(HELP)
      process.exit(1)
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message)
  process.exit(1)
})
