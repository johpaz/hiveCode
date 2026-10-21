import { runtimeDiagnostics, summarizeDiagnostics, type DiagnosticCheck } from "@johpaz/hivecode-core/services/diagnostics";
import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner,
} from "../cli-ui.ts"
import { preflightMigration, migrateLegacyDb } from "@johpaz/hivecode-core/storage/db-migrate"



type DoctorCheck = DiagnosticCheck

/**
 * Move a cwd-relative database to the HiveDir location. Prints the preflight
 * before asking, because the one outcome that cannot be undone is overwriting
 * the destination — and the one that cannot be diagnosed later is a database
 * that quietly went missing.
 */
async function migrateDbFlow(): Promise<void> {
  hiveIntro("hivecode · Migración de base de datos")

  const pre = preflightMigration()
  if (!pre) {
    hiveNote(`No hay base de datos antigua en ${process.cwd()}`, [])
    hiveOutro("Nada que migrar")
    return
  }

  const spinner = hiveSpinner("default")
  spinner.start("Inspeccionando...")
  spinner.stop(
    `${pre.files.length} archivos · ${(pre.bytes / 1_000_000).toFixed(1)} MB`,
  )

  console.log(`\n  origen:  ${pre.from}`)
  console.log(`  destino: ${pre.to}\n`)

  if (pre.destinationOccupied) {
    hiveNote("El destino YA tiene una base de datos. No se va a tocar.", [
      "Movela a mano si queres reemplazarla:",
      `  mv "${pre.to}" "${pre.to}.bak"`,
    ])
    hiveOutro("Cancelado — nada se movió")
    return
  }

  const result = migrateLegacyDb()
  if (!result.ok) {
    hiveNote("No se pudo migrar:", [result.error ?? "error desconocido"])
    hiveOutro("Migración fallida")
    return
  }

  hiveOutro(`Base de datos migrada a ${pre.to}`)
}

export async function doctor(flags: string[] = []): Promise<void> {

  // `--migrate-db` runs on its own: it moves the database, which is not
  // something to bury in the middle of a diagnostic run.
  if (flags.includes("--migrate-db")) {
    await migrateDbFlow()
    return
  }

  hiveIntro("hivecode · Diagnóstico")

  // The same checks `/doctor` runs inside the TUI (core/services/diagnostics): one definition of "healthy".
  const spinner = hiveSpinner("default")
  spinner.start("Comprobando el sistema...")
  const checks = await runtimeDiagnostics()
  const { pass: passCount, warn: warnCount, fail: failCount } = summarizeDiagnostics(checks)
  spinner.stop(`${checks.length} comprobaciones`, failCount ? "error" : warnCount ? "warn" : "done")

  const paint = (status: DoctorCheck["status"]) => status === "pass" ? "\x1b[38;5;114m" : status === "warn" ? "\x1b[38;5;214m" : "\x1b[38;5;203m"
  let section: string | undefined
  console.log("")
  for (const check of checks) {
    if (check.section !== section) {
      section = check.section
      process.stdout.write(`\n  \x1b[1m${section}\x1b[0m\n`)
    }
    const symbol = check.status === "pass" ? "✓" : check.status === "warn" ? "▲" : "✗"
    process.stdout.write(`  ${paint(check.status)}${symbol}\x1b[0m  ${check.name.padEnd(28)} ${check.message}\n`)
    if (check.detail) process.stdout.write(`     \x1b[2m${check.detail.split("\n").join("\n     ")}\x1b[0m\n`)
    if (check.fix) process.stdout.write(`     ${paint(check.status)}→ ${check.fix}\x1b[0m\n`)
  }
  console.log("")

  if (failCount > 0) {
    hiveOutro(`${failCount} error(es), ${warnCount} aviso(s) · Corrige lo marcado con →`, "error")
    process.exit(1)
  } else if (warnCount > 0) {
    hiveNote("Resumen", [`${passCount} comprobaciones correctas`, `${warnCount} aviso(s)`, "Funciona, pero hay cosas que revisar."])
    hiveOutro(`${warnCount} aviso(s) · El sistema funciona`)
  } else {
    hiveOutro("Todo en orden ✅")
  }
}
