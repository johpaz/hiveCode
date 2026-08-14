import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { Tool } from "../types.ts"
import { resolveInWorkspace, getWorkspace } from "../filesystem/workspace-guard.ts"
import { col } from "../../storage/hive.ts"
import type { JobDoc } from "../../storage/collections.ts"

const ARTIFACTS = {
  constitution: ".specify/memory/constitution.md",
  spec: "spec.md",
  plan: "plan.md",
  tasks: "tasks.md",
  analysis: "analysis.md",
  convergence: "convergence.md",
} as const

type ArtifactName = keyof typeof ARTIFACTS

const REQUIRED_SECTIONS: Record<Exclude<ArtifactName, "constitution" | "analysis" | "convergence">, string[]> = {
  spec: ["User Scenarios", "Requirements", "Success Criteria"],
  plan: ["Technical Context", "Constitution Check", "Project Structure"],
  tasks: ["Tasks"],
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
  if (!slug) throw new Error("feature_id/objective must contain letters or numbers")
  return slug
}

function workspaceFrom(config?: any): string {
  const workspace = getWorkspace(config)
  if (!workspace) throw new Error("Spec Kit requires a configured workspace")
  return workspace
}

function resolveFeatureDir(featureDir: string, workspace: string): string {
  const normalized = featureDir.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized.startsWith("specs/")) {
    throw new Error("feature_dir must be inside specs/")
  }
  return resolveInWorkspace(normalized, workspace)
}

function artifactPath(featureDir: string, artifact: ArtifactName, workspace: string): string {
  if (artifact === "constitution") return resolveInWorkspace(ARTIFACTS.constitution, workspace)
  return path.join(resolveFeatureDir(featureDir, workspace), ARTIFACTS[artifact])
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${Bun.randomUUIDv7()}.tmp`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, target)
}

async function nextFeatureId(specsDir: string, slug: string): Promise<string> {
  let entries: string[] = []
  try {
    entries = await readdir(specsDir)
  } catch {
    // First feature in the workspace.
  }
  const highest = entries.reduce((max, entry) => {
    const match = /^(\d{3})-/.exec(entry)
    return Math.max(max, match ? Number(match[1]) : 0)
  }, 0)
  return `${String(highest + 1).padStart(3, "0")}-${slug}`
}

function specTemplate(objective: string): string {
  return `# Feature Specification: ${objective}

## User Scenarios & Testing

<!-- Prioritized, independently testable user journeys. -->

## Requirements

<!-- Functional requirements with stable identifiers (FR-001, ...). -->

## Success Criteria

<!-- Measurable, technology-agnostic outcomes (SC-001, ...). -->
`
}

function planTemplate(objective: string): string {
  return `# Implementation Plan: ${objective}

## Technical Context

<!-- Runtime, dependencies, constraints, unknowns. -->

## Constitution Check

<!-- Explain compliance or explicitly justify each exception. -->

## Project Structure

<!-- Concrete files/modules and ownership boundaries. -->
`
}

const constitutionTemplate = `# Hive Constitution

## Core Principles

1. Evidence before claims: validation must be reproducible.
2. Smallest capable team: BEE activates Scout, Builder, Verifier, or Reviewer only when needed.
3. Durable execution: every long task must be resumable from persisted artifacts and checkpoints.
4. Bounded autonomy: permissions, token budgets, retries, and repair cycles are explicit.
5. Spec-driven complexity: complex work requires spec, plan, task DAG, validation, and convergence.

## Quality Gates

- Approval gate 1 accepts specification and architecture before mutation.
- Verifier checks acceptance criteria against the real system.
- Reviewer independently checks diff, contracts, safety, and specification alignment.
- Approval gate 2 accepts convergence before integration.
`

export const specKitInitTool: Tool = {
  name: "speckit_init",
  description: "Initialize native Spec Kit artifacts for a complex Hive task.",
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", description: "Feature or architecture objective" },
      feature_id: { type: "string", description: "Optional stable feature slug" },
    },
    required: ["objective"],
  },
  async execute(params, config) {
    try {
      const workspace = workspaceFrom(config)
      const objective = String(params.objective ?? "").trim()
      if (!objective) throw new Error("objective is required")
      const specsDir = resolveInWorkspace("specs", workspace)
      await mkdir(specsDir, { recursive: true })
      const featureId = params.feature_id
        ? safeSlug(String(params.feature_id))
        : await nextFeatureId(specsDir, safeSlug(objective))
      const featureDir = `specs/${featureId}`
      const absoluteFeatureDir = resolveFeatureDir(featureDir, workspace)
      await mkdir(absoluteFeatureDir, { recursive: true })

      const constitution = artifactPath(featureDir, "constitution", workspace)
      if (!(await Bun.file(constitution).exists())) await atomicWrite(constitution, constitutionTemplate)
      const spec = artifactPath(featureDir, "spec", workspace)
      const plan = artifactPath(featureDir, "plan", workspace)
      const tasks = artifactPath(featureDir, "tasks", workspace)
      if (!(await Bun.file(spec).exists())) await atomicWrite(spec, specTemplate(objective))
      if (!(await Bun.file(plan).exists())) await atomicWrite(plan, planTemplate(objective))
      if (!(await Bun.file(tasks).exists())) await atomicWrite(tasks, "# Tasks\n\n<!-- - [ ] T001 [builder] Task description (depends: T000) -->\n")

      return { ok: true, feature_id: featureId, feature_dir: featureDir, artifacts: ARTIFACTS }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  },
}

export const specKitArtifactReadTool: Tool = {
  name: "speckit_artifact_read",
  description: "Read one native Spec Kit artifact from the workspace.",
  parameters: {
    type: "object",
    properties: {
      feature_dir: { type: "string", description: "Feature directory under specs/" },
      artifact: { type: "string", enum: Object.keys(ARTIFACTS), description: "Artifact name" },
    },
    required: ["feature_dir", "artifact"],
  },
  async execute(params, config) {
    try {
      const artifact = String(params.artifact) as ArtifactName
      if (!(artifact in ARTIFACTS)) throw new Error(`Unknown artifact: ${artifact}`)
      const target = artifactPath(String(params.feature_dir), artifact, workspaceFrom(config))
      return { ok: true, artifact, path: target, content: await readFile(target, "utf8") }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  },
}

export const specKitArtifactWriteTool: Tool = {
  name: "speckit_artifact_write",
  description: "Atomically write a native Spec Kit artifact inside the active feature.",
  parameters: {
    type: "object",
    properties: {
      feature_dir: { type: "string", description: "Feature directory under specs/" },
      artifact: { type: "string", enum: Object.keys(ARTIFACTS), description: "Artifact name" },
      content: { type: "string", description: "Complete Markdown artifact content" },
    },
    required: ["feature_dir", "artifact", "content"],
  },
  async execute(params, config) {
    try {
      const artifact = String(params.artifact) as ArtifactName
      if (!(artifact in ARTIFACTS)) throw new Error(`Unknown artifact: ${artifact}`)
      const target = artifactPath(String(params.feature_dir), artifact, workspaceFrom(config))
      const content = String(params.content ?? "")
      if (!content.trim()) throw new Error("content cannot be empty")
      await atomicWrite(target, content)
      return { ok: true, artifact, path: target, bytes: Buffer.byteLength(content) }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  },
}

async function validateArtifact(featureDir: string, artifact: ArtifactName, workspace: string) {
  const target = artifactPath(featureDir, artifact, workspace)
  const errors: string[] = []
  let content = ""
  try {
    content = await readFile(target, "utf8")
  } catch {
    errors.push(`${artifact}: missing artifact`)
    return { artifact, valid: false, errors }
  }
  if (!content.trim()) errors.push(`${artifact}: empty artifact`)
  if (artifact in REQUIRED_SECTIONS) {
    for (const section of REQUIRED_SECTIONS[artifact as keyof typeof REQUIRED_SECTIONS]) {
      if (!new RegExp(`^##\\s+.*${section}`, "im").test(content)) {
        errors.push(`${artifact}: missing section "${section}"`)
      }
    }
  }
  if (/<!--[\s\S]*?-->/m.test(content)) errors.push(`${artifact}: unresolved template comments`)
  return { artifact, valid: errors.length === 0, errors }
}

export const specKitValidateTool: Tool = {
  name: "speckit_validate",
  description: "Validate required Spec Kit artifacts and report actionable gaps.",
  parameters: {
    type: "object",
    properties: {
      feature_dir: { type: "string", description: "Feature directory under specs/" },
      stage: { type: "string", enum: ["spec", "plan", "tasks", "analyze", "all"], description: "Validation stage" },
    },
    required: ["feature_dir", "stage"],
  },
  async execute(params, config) {
    try {
      const stage = String(params.stage)
      const artifacts: ArtifactName[] = stage === "all" || stage === "analyze"
        ? ["constitution", "spec", "plan", "tasks"]
        : stage === "spec"
          ? ["constitution", "spec"]
          : stage === "plan"
            ? ["constitution", "spec", "plan"]
            : ["constitution", "spec", "plan", "tasks"]
      const workspace = workspaceFrom(config)
      const results = await Promise.all(artifacts.map(item => validateArtifact(String(params.feature_dir), item, workspace)))
      const errors = results.flatMap(result => result.errors)
      return { ok: errors.length === 0, valid: errors.length === 0, stage, results, errors }
    } catch (error) {
      return { ok: false, valid: false, error: (error as Error).message }
    }
  },
}

interface ParsedTask {
  id: string
  completed: boolean
  lane: string
  description: string
  dependsOn: string[]
}

function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = []
  for (const line of markdown.split("\n")) {
    const match = /^\s*-\s*\[([ xX])\]\s+(T\d+)\s+(?:\[(\w+)\]\s+)?(.+)$/.exec(line)
    if (!match) continue
    const dependencyMatch = /\(depends:\s*([^)]+)\)\s*$/i.exec(match[4])
    const dependsOn = dependencyMatch
      ? dependencyMatch[1].split(",").map(item => item.trim()).filter(Boolean)
      : []
    tasks.push({
      id: match[2],
      completed: match[1].toLowerCase() === "x",
      lane: match[3] || "builder",
      description: match[4].replace(/\s*\(depends:[^)]+\)\s*$/i, "").trim(),
      dependsOn,
    })
  }
  return tasks
}

export const specKitTasksSyncTool: Tool = {
  name: "speckit_tasks_sync",
  description: "Parse tasks.md into a durable dependency-aware Hive job queue.",
  parameters: {
    type: "object",
    properties: {
      feature_dir: { type: "string", description: "Feature directory under specs/" },
      run_id: { type: "string", description: "Durable parent run ID" },
    },
    required: ["feature_dir", "run_id"],
  },
  async execute(params, config) {
    try {
      const featureDir = String(params.feature_dir)
      const runId = String(params.run_id)
      const markdown = await readFile(artifactPath(featureDir, "tasks", workspaceFrom(config)), "utf8")
      const tasks = parseTasks(markdown)
      if (tasks.length === 0) throw new Error("tasks.md contains no parseable checkbox tasks")
      const known = new Set(tasks.map(task => task.id))
      const invalidDependencies = tasks.flatMap(task => task.dependsOn.filter(dep => !known.has(dep)).map(dep => `${task.id}->${dep}`))
      if (invalidDependencies.length) throw new Error(`Unknown task dependencies: ${invalidDependencies.join(", ")}`)

      const jobs = await col<JobDoc>("jobQueue")
      const now = Math.floor(Date.now() / 1000)
      for (const task of tasks) {
        const id = `${runId}:${task.id}`
        const existing = await jobs.get(id)
        const doc: JobDoc = {
          id,
          type: task.lane,
          lane: task.lane,
          status: task.completed ? "completed" : existing?.doc.status ?? "pending",
          payload_json: JSON.stringify({ ...task, feature_dir: featureDir }),
          run_id: runId,
          priority: existing?.doc.priority ?? 0,
          attempts: existing?.doc.attempts ?? 0,
          max_attempts: 3,
          lease_owner: existing?.doc.lease_owner ?? "",
          lease_expires_at: existing?.doc.lease_expires_at ?? 0,
          error: existing?.doc.error ?? null,
          created_at: existing?.doc.created_at ?? now,
          updated_at: now,
          completed_at: task.completed ? now : existing?.doc.completed_at ?? null,
        }
        await jobs.put(id, doc, { expectedVersion: existing?.version ?? 0 })
      }
      return { ok: true, run_id: runId, count: tasks.length, tasks }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  },
}

export const specKitConvergeTool: Tool = {
  name: "speckit_converge",
  description: "Write the final convergence record from verification and review evidence.",
  parameters: {
    type: "object",
    properties: {
      feature_dir: { type: "string", description: "Feature directory under specs/" },
      verification: { type: "string", description: "Verifier evidence and acceptance results" },
      review: { type: "string", description: "Reviewer verdict and findings" },
      gaps: { type: "string", description: "JSON array of remaining gaps" },
    },
    required: ["feature_dir", "verification", "review"],
  },
  async execute(params, config) {
    try {
      let gaps: unknown[] = []
      if (params.gaps) {
        const parsed = JSON.parse(String(params.gaps))
        if (!Array.isArray(parsed)) throw new Error("gaps must be a JSON array")
        gaps = parsed
      }
      const featureDir = String(params.feature_dir)
      const workspace = workspaceFrom(config)
      const validation = await Promise.all(
        (["constitution", "spec", "plan", "tasks"] as ArtifactName[])
          .map(item => validateArtifact(featureDir, item, workspace))
      )
      const artifactErrors = validation.flatMap(result => result.errors)
      const converged = gaps.length === 0 && artifactErrors.length === 0
      const content = `# Convergence Report

## Status

${converged ? "CONVERGED" : "NOT CONVERGED"}

## Verification Evidence

${String(params.verification)}

## Independent Review

${String(params.review)}

## Remaining Gaps

${gaps.length ? gaps.map(gap => `- ${String(gap)}`).join("\n") : "- None"}

## Artifact Validation

${artifactErrors.length ? artifactErrors.map(error => `- ${error}`).join("\n") : "- All required artifacts valid"}
`
      const target = artifactPath(featureDir, "convergence", workspace)
      await atomicWrite(target, content)
      return { ok: converged, converged, path: target, gaps, artifact_errors: artifactErrors }
    } catch (error) {
      return { ok: false, converged: false, error: (error as Error).message }
    }
  },
}

export function createTools(): Tool[] {
  return [
    specKitInitTool,
    specKitArtifactReadTool,
    specKitArtifactWriteTool,
    specKitValidateTool,
    specKitTasksSyncTool,
    specKitConvergeTool,
  ]
}
