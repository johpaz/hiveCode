import { runtimeDiagnostics, type DiagnosticCheck } from "@johpaz/hivecode-core/services/diagnostics";
import { SUPPORTED_LLM_PROVIDERS, providerCredentialName } from "@johpaz/hivecode-core/services/provider-capabilities"
import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner,
} from "../cli-ui.ts"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { getHiveDbPath, findLegacyHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { preflightMigration, migrateLegacyDb } from "@johpaz/hivecode-core/storage/db-migrate"
import type { AgentDoc, LearningProposalDoc, ProviderDoc, SkillDoc } from "@johpaz/hivecode-core/storage/collections"



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

  const fixMode = flags.includes("--fix")

  // `--migrate-db` runs on its own: it moves the database, which is not
  // something to bury in the middle of a diagnostic run.
  if (flags.includes("--migrate-db")) {
    await migrateDbFlow()
    return
  }

  hiveIntro("hivecode · Diagnóstico")

  const checks: DoctorCheck[] = await runtimeDiagnostics()

  // A legacy database in the cwd means the user has state the current process
  // cannot see. Surfacing it is the whole point: silently starting empty would
  // look like data loss with no explanation.
  const legacy = findLegacyHiveDb()
  if (legacy) {
    const pre = preflightMigration()
    checks.push({
      name: "HiveDB",
      status: "warn",
      message: "Base de datos antigua en este directorio, no se está usando",
      detail: pre
        ? `${pre.from} → ${pre.to} · ${(pre.bytes / 1_000_000).toFixed(1)} MB en ${pre.files.length} archivos. `
          + `Migrá con: hivecode doctor --migrate-db`
        : legacy,
    })
  }

  // Check 4: Workers / Coordinators
  const workerSpinner = hiveSpinner("default")
  workerSpinner.start("Verificando coordinadores...")
  try {
    const agents = (await (await col<AgentDoc>("agents")).scan()).map((entry) => entry.doc)
    const coordCount = agents.filter((agent) => agent.role === "coordinator" && agent.enabled).length
    const workerCount = agents.filter((agent) => agent.role === "worker").length

    const ok = coordCount >= 6
    workerSpinner.stop(
      ok ? `${coordCount} coordinadores · ${workerCount} workers` : `Solo ${coordCount}/6 coordinadores`,
      ok ? "done" : "error",
    )
    checks.push({
      name: "Workers (Coordinators)",
      status: ok ? "pass" : "warn",
      message: ok
        ? `${coordCount} coordinadores registrados · ${workerCount} workers activos`
        : `Solo ${coordCount}/6 coordinadores — ejecuta: hivecode doctor --fix`,
    })
  } catch (err) {
    workerSpinner.stop("Error verificando coordinadores", "error")
    checks.push({
      name: "Workers (Coordinators)",
      status: "fail",
      message: "No se pudo verificar agentes en DB",
      detail: (err as Error).message,
    })
  }

  // Check 5: Skills
  const skillsSpinner = hiveSpinner("default")
  skillsSpinner.start("Verificando skills...")
  try {
    const count = (await (await col<SkillDoc>("skills")).scan()).length

    skillsSpinner.stop(`${count} skill(s) registrada(s)`)
    checks.push({
      name: "Skills",
      status: count > 0 ? "pass" : "warn",
      message: count > 0 ? `${count} skills cargadas` : "Ninguna skill registrada",
    })
  } catch (err) {
    skillsSpinner.stop("Error verificando skills", "error")
    checks.push({
      name: "Skills",
      status: "fail",
      message: "No se pudieron verificar skills",
    })
  }

  // Check 6: Secrets
  const secretsSpinner = hiveSpinner("default")
  secretsSpinner.start("Verificando secrets...")
  try {
    const { loadSecrets } = await import("@johpaz/hivecode-code/workers/secrets")
    const secrets = await loadSecrets()
    const hasKeys = Object.keys(secrets).length > 0
    const keyNames = Object.keys(secrets).join(", ")

    secretsSpinner.stop(hasKeys ? `${Object.keys(secrets).length} secret(s) encontrado(s)` : "Ningún secret configurado")
    checks.push({
      name: "Secrets",
      status: hasKeys ? "pass" : "warn",
      message: hasKeys ? keyNames : "Ninguna API key configurada",
    })
  } catch (err) {
    secretsSpinner.stop("Error verificando secrets", "error")
    checks.push({
      name: "Secrets",
      status: "fail",
      message: "No se pudieron verificar secrets",
    })
  }

  // Check 7: Bun.WebView
  const webviewSpinner = hiveSpinner("default")
  webviewSpinner.start("Verificando Bun.WebView...")
  const hasWebView = typeof (Bun as any).WebView === "function"
  webviewSpinner.stop(hasWebView ? "Disponible" : "No disponible en esta plataforma")
  checks.push({
    name: "Bun.WebView",
    status: hasWebView ? "pass" : "warn",
    message: hasWebView ? "Disponible" : "No disponible (Linux/headless)",
  })

  // Check 8: Disk space
  const diskSpinner = hiveSpinner("default")
  diskSpinner.start("Verificando espacio en disco...")
  try {
    const stats = await Bun.file(".").stat()
    // Bun doesn't have a direct disk space API, so we check if we can write
    const testFile = `/tmp/hive-doctor-test-${Date.now()}`
    await Bun.write(testFile, "test")
    await Bun.file(testFile).delete()

    diskSpinner.stop("Espacio disponible")
    checks.push({
      name: "Disco",
      status: "pass",
      message: "Espacio en disco disponible",
    })
  } catch (err) {
    diskSpinner.stop("Error verificando disco", "error")
    checks.push({
      name: "Disco",
      status: "warn",
      message: "No se pudo verificar espacio en disco",
    })
  }

  // Check 9: Learning proposals pending
  const learningSpinner = hiveSpinner("default")
  learningSpinner.start("Verificando propuestas de aprendizaje...")
  try {
    const pending = (await (await col<LearningProposalDoc>("learningProposals")).findBy("status", "pending"))
      .map((entry) => entry.doc)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    learningSpinner.stop(
      pending.length > 0
        ? `${pending.length} propuesta(s) pendiente(s) de revisión`
        : "Sin propuestas pendientes",
      pending.length > 0 ? "warn" : "done",
    )
    checks.push({
      name: "Learning Proposals",
      status: pending.length > 0 ? "warn" : "pass",
      message: pending.length > 0
        ? `${pending.length} propuesta(s) pendiente(s) — revisa con: hivecode narrative show`
        : "Sin propuestas pendientes",
      detail: pending.length > 0
        ? pending.slice(0, 3).map(p => `[${p.id}] ${p.source_agent}/${p.proposal_type}: ${String(p.description).slice(0, 70)}...`).join("\n     ")
        : undefined,
    })
  } catch {
    learningSpinner.stop("Colección learningProposals no disponible", "warn")
    checks.push({
      name: "Learning Proposals",
      status: "warn",
      message: "Tablas de aprendizaje no inicializadas (ejecuta una tarea primero)",
    })
  }

  // Render results
  console.log("")
  const passCount = checks.filter(c => c.status === "pass").length
  const warnCount = checks.filter(c => c.status === "warn").length
  const failCount = checks.filter(c => c.status === "fail").length

  for (const check of checks) {
    const symbol = check.status === "pass" ? "✓" : check.status === "warn" ? "▲" : "✗"
    const color = check.status === "pass" ? "\x1b[38;5;114m" : check.status === "warn" ? "\x1b[38;5;214m" : "\x1b[38;5;203m"
    process.stdout.write(`  ${color}${symbol}${"\x1b[0m"}  ${check.name.padEnd(24)} ${check.message}\n`)
    if (check.detail) {
      process.stdout.write(`     ${"\x1b[2m"}${check.detail}${"\x1b[0m"}\n`)
    }
  }

  console.log("")

  // Summary
  if (failCount > 0) {
    hiveOutro(`${failCount} error(es), ${warnCount} warning(s) · Revisa los problemas arriba`, "error")
    process.exit(1)
  } else if (warnCount > 0) {
    hiveNote("Resumen", [
      `${passCount} checks pasaron ✅`,
      `${warnCount} warning(s) ⚠️`,
      "El sistema funciona pero podría no estar optimizado.",
    ])
    hiveOutro(`${warnCount} warning(s) · El sistema funciona`)
  } else {
    hiveOutro(`Todos los checks pasaron ✅`)
  }
}
