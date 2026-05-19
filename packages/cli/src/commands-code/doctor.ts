import {
  hiveIntro, hiveOutro, hivePhaseComplete,
  hiveNote, hiveSpinner,
} from "@johpaz/hivecode-tui-primitives"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"

interface DoctorCheck {
  name: string
  status: "pass" | "warn" | "fail"
  message: string
  detail?: string
}

export async function doctor(flags: string[] = []): Promise<void> {

  const fixMode = flags.includes("--fix")

  hiveIntro("hivecode · Diagnóstico")

  const checks: DoctorCheck[] = []

  // Check 1: Bun version
  const bunVersion = Bun.version
  const bunOk = bunVersion >= "1.3.10"
  checks.push({
    name: "Bun runtime",
    status: bunOk ? "pass" : "warn",
    message: bunOk ? `v${bunVersion}` : `v${bunVersion} (recomendado >= 1.3.10)`,
  })

  // Check 2: SQLite integrity
  const dbCheckSpinner = hiveSpinner("default")
  dbCheckSpinner.start("Verificando SQLite...")
  try {
    const db = getDb()
    const journalMode = db.query("PRAGMA journal_mode").get() as any
    const walEnabled = journalMode?.journal_mode === "wal"

    dbCheckSpinner.stop(`SQLite ${walEnabled ? "WAL activo" : "WAL no activo"}`, walEnabled ? "done" : "error")
    checks.push({
      name: "SQLite",
      status: walEnabled ? "pass" : "warn",
      message: walEnabled ? "WAL activo" : "WAL no activo",
    })
  } catch (err) {
    dbCheckSpinner.stop("SQLite no accesible", "error")
    checks.push({
      name: "SQLite",
      status: "fail",
      message: "No se pudo conectar a la base de datos",
      detail: (err as Error).message,
    })
  }

  // Check 3: Providers
  const providerSpinner = hiveSpinner("default")
  providerSpinner.start("Verificando providers...")
  try {
    const db = getDb()
    const providers = db.query("SELECT id, name, enabled FROM providers WHERE enabled = 1").all() as any[]
    const providerNames = providers.map(p => p.name || p.id).join(", ")

    providerSpinner.stop(`${providers.length} provider(s) activo(s)`)
    checks.push({
      name: "Providers LLM",
      status: providers.length > 0 ? "pass" : "warn",
      message: providers.length > 0 ? providerNames : "Ningún provider configurado",
    })
  } catch (err) {
    providerSpinner.stop("Error verificando providers", "error")
    checks.push({
      name: "Providers LLM",
      status: "fail",
      message: "No se pudieron verificar providers",
    })
  }

  // Check 4: Workers / Coordinators
  const workerSpinner = hiveSpinner("default")
  workerSpinner.start("Verificando coordinadores...")
  try {
    const db = getDb()
    const coordCount = (db.query(
      "SELECT COUNT(*) as c FROM agents WHERE role = 'coordinator' AND enabled = 1"
    ).get() as any)?.c ?? 0
    const workerCount = (db.query(
      "SELECT COUNT(*) as c FROM agents WHERE role = 'worker'"
    ).get() as any)?.c ?? 0

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
    const db = getDb()
    const skills = db.query("SELECT COUNT(*) as count FROM skills").get() as any
    const count = skills?.count ?? 0

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
    const secrets = loadSecrets()
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
