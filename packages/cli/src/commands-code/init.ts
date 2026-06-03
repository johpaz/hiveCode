/**
 * hive-code init — Project initialization (TDD §22)
 *
 * 6-step flow:
 *   1. Detect stack (package.json, Cargo.toml, go.mod, etc.)
 *   2. Index codebase into code_graph
 *   3. Read existing context (git log, README, existing narrative)
 *   4. Write first narrative entry
 *   5. Ask user ONE question
 *   6. Done
 */

import * as path from "node:path"

import { hiveIntro, hiveOutro, hiveNote, hiveSpinner, hiveText, isCancel } from "../cli-ui.ts"
import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const log = logger.child("init")

interface StackInfo {
  name: string
  detected: boolean
  details?: string
}

async function detectStack(cwd: string): Promise<StackInfo[]> {
  const stacks: StackInfo[] = []

  const pkgPath = path.join(cwd, "package.json")
  if (await Bun.file(pkgPath).exists()) {
    try {
      const pkg = JSON.parse(await Bun.file(pkgPath).text())
      const frameworks: string[] = []
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (deps["next"]) frameworks.push("Next.js")
      if (deps["react"]) frameworks.push("React")
      if (deps["vue"]) frameworks.push("Vue")
      if (deps["svelte"]) frameworks.push("Svelte")
      if (deps["express"]) frameworks.push("Express")
      if (deps["fastify"]) frameworks.push("Fastify")
      if (deps["bun"]) frameworks.push("Bun")
      const runtime = pkg.type === "module" ? "ESM" : "CJS"
      stacks.push({ name: "Node/Bun", detected: true, details: [runtime, ...frameworks].join(" · ") || pkg.name })
    } catch {
      stacks.push({ name: "Node/Bun", detected: true })
    }
  }

  if (await Bun.file(path.join(cwd, "Cargo.toml")).exists()) stacks.push({ name: "Rust", detected: true })
  if (await Bun.file(path.join(cwd, "go.mod")).exists()) stacks.push({ name: "Go", detected: true })
  if (await Bun.file(path.join(cwd, "requirements.txt")).exists() || await Bun.file(path.join(cwd, "pyproject.toml")).exists()) {
    stacks.push({ name: "Python", detected: true })
  }
  if (await Bun.file(path.join(cwd, "pom.xml")).exists() || await Bun.file(path.join(cwd, "build.gradle")).exists()) {
    stacks.push({ name: "JVM", detected: true })
  }
  if (stacks.length === 0) stacks.push({ name: "Desconocido", detected: false })

  return stacks
}

function readRecentGitLog(cwd: string): string {
  try {
    const result = Bun.spawnSync(
      ["git", "log", "--oneline", "-10"],
      { cwd, stdout: "pipe", stderr: "pipe" }
    )
    if (result.exitCode === 0) {
      return new TextDecoder().decode(result.stdout).trim()
    }
  } catch { /* no git */ }
  return ""
}

async function readReadme(cwd: string): Promise<string> {
  const candidates = ["README.md", "README.txt", "README"]
  for (const f of candidates) {
    const p = path.join(cwd, f)
    if (await Bun.file(p).exists()) {
      const content = await Bun.file(p).text()
      return content.slice(0, 1500)
    }
  }
  return ""
}

export async function init(pathArg?: string): Promise<void> {
  const cwd = process.cwd()
  const projectName = path.basename(cwd)

  hiveIntro(`hivecode · Inicializando ${projectName}`)

  // ── Step 1: Detect stack ─────────────────────────────────────────────────
  const stackSpinner = hiveSpinner("default")
  stackSpinner.start("Detectando stack...")

  const stacks = await detectStack(cwd)
  const stackStr = stacks.filter(s => s.detected).map(s => s.details ? `${s.name} (${s.details})` : s.name).join(", ")
  stackSpinner.stop(`Stack: ${stackStr || "desconocido"}`)

  // ── Step 2: Index codebase into code_graph ──────────────────────────────
  const indexSpinner = hiveSpinner("default")
  indexSpinner.start("Indexando codebase...")

  let indexResult = { indexed: 0, skipped: 0, durationMs: 0 }
  try {
    const db = getDb()

    // Ensure code schema is applied
    const { CODE_SCHEMA } = await import("@johpaz/hivecode-code/narrative")
    db.run(CODE_SCHEMA)

    // Create or reuse a session for this init
    const existingSession = db.query<any, [string]>(
      "SELECT id FROM code_sessions WHERE project_path = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get(cwd)

    const sessionId = existingSession?.id ?? (() => {
      const id = Bun.randomUUIDv7()
      db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(id, cwd)
      return id
    })()

    const { buildFullIndex } = await import("@johpaz/hivecode-code/agent/code-indexer" as any)
    indexResult = await buildFullIndex(sessionId, cwd)

    indexSpinner.stop(`Indexados ${indexResult.indexed} archivos (${indexResult.skipped} omitidos) en ${indexResult.durationMs}ms`)
  } catch (err) {
    indexSpinner.stop(`Indexación parcial: ${(err as Error).message}`, "error")
    log.warn("[init] Code indexer failed:", (err as Error).message)
  }

  // ── Step 3: Read existing context ────────────────────────────────────────
  const ctxSpinner = hiveSpinner("default")
  ctxSpinner.start("Leyendo contexto existente...")

  const gitLog = readRecentGitLog(cwd)
  const readme = await readReadme(cwd)

  const contextSummary: string[] = []
  if (gitLog) contextSummary.push(`Últimos commits: ${gitLog.split("\n").length} encontrados`)
  if (readme) contextSummary.push(`README: ${readme.split("\n").length} líneas`)
  if (indexResult.indexed > 0) contextSummary.push(`${indexResult.indexed} archivos de código indexados`)

  ctxSpinner.stop(contextSummary.join(" · ") || "Sin contexto previo")

  // ── Step 4: Write first narrative entry ──────────────────────────────────
  try {
    const db = getDb()
    const sessionId = (db.query<any, [string]>(
      "SELECT id FROM code_sessions WHERE project_path = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get(cwd))?.id

    if (sessionId) {
      const entry = [
        `## Inicialización — ${projectName}`,
        `Stack detectado: ${stackStr}`,
        `Archivos indexados: ${indexResult.indexed}`,
        gitLog ? `\n### Historial reciente\n${gitLog.slice(0, 500)}` : "",
        readme ? `\n### README\n${readme.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n")

      db.query(`
        INSERT INTO code_narrative (session_id, coordinator, phase, entry, is_draft, is_override)
        VALUES (?, 'system', 'init', ?, 0, 0)
      `).run(sessionId, entry)
    }
  } catch (err) {
    log.warn("[init] Failed to write narrative entry:", (err as Error).message)
  }

  // ── Step 5: Ask user ONE question ────────────────────────────────────────
  hiveNote("Proyecto inicializado", [
    `Stack: ${stackStr}`,
    `Archivos indexados: ${indexResult.indexed}`,
    "",
    "Hivecode está listo para trabajar en este proyecto.",
  ])

  const focus = await hiveText({
    message: "¿En qué área quieres que Hivecode se enfoque primero?",
    placeholder: "ej: autenticación, API REST, tests de integración...",
    validate: (v) => v.length === 0 ? undefined : undefined, // optional
  })

  if (!isCancel(focus) && focus && typeof focus === "string") {
    // Store the focus area as context in narrative
    try {
      const db = getDb()
      const sessionId = (db.query<any, [string]>(
        "SELECT id FROM code_sessions WHERE project_path = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).get(cwd))?.id

      if (sessionId) {
        db.query(`
          INSERT INTO code_narrative (session_id, coordinator, phase, entry, is_draft, is_override)
          VALUES (?, 'user', 'focus', ?, 0, 0)
        `).run(sessionId, `Área de enfoque inicial: ${focus}`)
      }
    } catch { /* optional */ }
  }

  // ── Step 6: Done ─────────────────────────────────────────────────────────
  hiveOutro("Hivecode listo · Ejecuta: hivecode repl")
}
