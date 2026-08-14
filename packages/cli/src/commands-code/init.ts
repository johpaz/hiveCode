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
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeNarrativeDoc, CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const log = logger.child("init")

function nowIso(): string {
  return new Date().toISOString()
}

async function getOrCreateSession(cwd: string): Promise<string> {
  const sessions = await col<CodeSessionDoc>("codeSessions")
  const existing = (await sessions.findBy("project_path", cwd))
    .map((entry) => entry.doc)
    .filter((session) => session.status === "active")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (existing) return existing.id

  const id = Bun.randomUUIDv7()
  await sessions.put(id, {
    id,
    project_path: cwd,
    status: "active",
    created_at: nowIso(),
    last_active: nowIso(),
  }, { expectedVersion: 0 })
  return id
}

async function appendInitNarrative(sessionId: string, coordinator: string, phase: string, entry: string): Promise<void> {
  const id = Bun.randomUUIDv7()
  await (await col<CodeNarrativeDoc>("codeNarrative")).put(id, {
    id,
    task_id: null,
    session_id: sessionId,
    coordinator,
    phase,
    entry,
    is_draft: false,
    is_override: false,
    created_at: nowIso(),
  }, { expectedVersion: 0 })
}

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
  let sessionId: string | null = null
  try {
    sessionId = await getOrCreateSession(cwd)

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
    sessionId = sessionId ?? await getOrCreateSession(cwd)
    if (sessionId) {
      const entry = [
        `## Inicialización — ${projectName}`,
        `Stack detectado: ${stackStr}`,
        `Archivos indexados: ${indexResult.indexed}`,
        gitLog ? `\n### Historial reciente\n${gitLog.slice(0, 500)}` : "",
        readme ? `\n### README\n${readme.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n")

      await appendInitNarrative(sessionId, "system", "init", entry)
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
      sessionId = sessionId ?? await getOrCreateSession(cwd)
      if (sessionId) {
        await appendInitNarrative(sessionId, "user", "focus", `Área de enfoque inicial: ${focus}`)
      }
    } catch { /* optional */ }
  }

  // ── Step 6: Done ─────────────────────────────────────────────────────────
  hiveOutro("Hivecode listo · Ejecuta: hivecode repl")
}
