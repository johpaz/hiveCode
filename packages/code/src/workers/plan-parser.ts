/**
 * Plan Parser — extracts structured ADR + phase plan from Architecture Coordinator output.
 *
 * The Architecture Coordinator is instructed to output JSON.
 * This parser handles:
 *   - Raw JSON
 *   - JSON wrapped in markdown code blocks
 *   - Fallback to regex extraction if JSON is malformed
 */

import type { PhaseName } from "./types"

export interface ParsedPhase {
  name: string
  coordinator: PhaseName
  description: string
  dependsOn: string[]
}

export interface ParsedPlan {
  adr: {
    title: string
    context: string
    options: string
    decision: string
    consequences: string
  }
  phases: ParsedPhase[]
  risks: Array<{ severity: "HIGH" | "MEDIUM" | "LOW"; description: string }>
  interfaces?: string
  parseError?: string
}

const VALID_PHASES: PhaseName[] = [
  "product_manager", "backend", "frontend", "mobile", "data_scientist",
  "security", "test", "devops", "dba", "integration", "reviewer",
]

/** Extract JSON from text (handles markdown code blocks) */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

function extractJson(text: string): string | null {
  const clean = stripThinkBlocks(text)

  // Try markdown code block first
  const codeBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim()
    if (inner.startsWith("{")) return inner
  }

  // Try raw JSON
  const jsonMatch = clean.match(/\{[\s\S]*\}/)
  if (jsonMatch) return jsonMatch[0]

  return null
}

/** Validate and normalize a phase */
function normalizePhase(p: any): ParsedPhase | null {
  const coordinator = p.coordinator as string
  if (!VALID_PHASES.includes(coordinator as PhaseName)) {
    console.warn(`[plan-parser] Invalid phase coordinator: ${coordinator}`)
    return null
  }
  return {
    name: String(p.name || coordinator),
    coordinator: coordinator as PhaseName,
    description: String(p.description || ""),
    dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn.filter((d: string) => VALID_PHASES.includes(d as PhaseName)) : [],
  }
}

/** Topological sort of phases based on dependsOn */
function sortPhases(phases: ParsedPhase[]): ParsedPhase[] {
  const visited = new Set<string>()
  const result: ParsedPhase[] = []

  function visit(phase: ParsedPhase) {
    if (visited.has(phase.coordinator)) return
    visited.add(phase.coordinator)
    for (const dep of phase.dependsOn) {
      const depPhase = phases.find(p => p.coordinator === dep)
      if (depPhase) visit(depPhase)
    }
    result.push(phase)
  }

  for (const phase of phases) {
    visit(phase)
  }

  return result
}

/**
 * Parse Architecture Coordinator output into structured plan.
 * Accepts either a pre-parsed object (from native tool call) or raw text (legacy fallback).
 */
export function parsePlan(input: string | Record<string, unknown>): ParsedPlan {
  let parsed: Record<string, unknown> | null = null

  if (typeof input === "object" && input !== null) {
    parsed = input
  } else if (typeof input === "string") {
    const jsonStr = extractJson(input)
    if (jsonStr) {
      try {
        parsed = JSON.parse(jsonStr)
      } catch (err) {
        console.warn(`[plan-parser] JSON parse failed: ${(err as Error).message}`)
      }
    }
    if (!parsed) {
      console.warn("[plan-parser] Failed to parse plan JSON — using default phase order")
      const title = input.match(/#+\s*(.+)/)?.[1]?.trim() || "Plan de implementación"
      return {
        adr: {
          title,
          context: input.slice(0, 800),
          options: "{}",
          decision: "Proceder con la implementación según el análisis de Architecture.",
          consequences: "Ver narrativa completa en FOCUS para detalles.",
        },
        phases: sortPhases(getDefaultPhases()),
        risks: [{ severity: "MEDIUM", description: "El plan fue generado con fases por defecto porque el JSON estaba incompleto." }],
      }
    }
  }

  if (!parsed) {
    return {
      adr: { title: "Plan de implementación", context: "", options: "{}", decision: "", consequences: "" },
      phases: sortPhases(getDefaultPhases()),
      risks: [{ severity: "MEDIUM", description: "No se pudo parsear el plan." }],
    }
  }

  const parsedAny = parsed as any
  const phases = ((parsedAny.phases || []) as any[])
    .map(normalizePhase)
    .filter((p): p is ParsedPhase => p !== null)

  return {
    adr: {
      title: String(parsedAny.adr?.title || "Untitled ADR"),
      context: String(parsedAny.adr?.context || ""),
      options: typeof parsedAny.adr?.options === "object" ? JSON.stringify(parsedAny.adr.options) : String(parsedAny.adr?.options || ""),
      decision: String(parsedAny.adr?.decision || ""),
      consequences: String(parsedAny.adr?.consequences || ""),
    },
    phases: sortPhases(phases),
    risks: (parsedAny.risks || []).map((r: any) => ({
      severity: ["HIGH", "MEDIUM", "LOW"].includes(r?.severity) ? r.severity : "MEDIUM",
      description: String(r?.description || ""),
    })),
    interfaces: Array.isArray(parsedAny.interfaces) ? JSON.stringify(parsedAny.interfaces) : (parsedAny.interfaces ? String(parsedAny.interfaces) : undefined),
  }
}

/**
 * Group phases by dependency level for parallel execution.
 * Phases in the same level have no dependencies between them and can run in parallel.
 *
 * Example:
 *   Level 0: [backend]
 *   Level 1: [frontend]
 *   Level 2: [security, test]  ← parallel
 *   Level 3: [devops]
 */
export function groupPhasesByLevel(phases: ParsedPhase[]): ParsedPhase[][] {
  const levels = new Map<string, number>()

  function getLevel(phase: ParsedPhase): number {
    if (levels.has(phase.coordinator)) return levels.get(phase.coordinator)!

    if (phase.dependsOn.length === 0) {
      levels.set(phase.coordinator, 0)
      return 0
    }

    const depLevels = phase.dependsOn
      .map(dep => phases.find(p => p.coordinator === dep))
      .filter((p): p is ParsedPhase => p !== undefined)
      .map(getLevel)

    const level = Math.max(...depLevels) + 1
    levels.set(phase.coordinator, level)
    return level
  }

  // Compute levels for all phases
  for (const phase of phases) {
    getLevel(phase)
  }

  // Group by level
  const maxLevel = Math.max(...Array.from(levels.values()), -1)
  const result: ParsedPhase[][] = []

  for (let i = 0; i <= maxLevel; i++) {
    const levelPhases = phases.filter(p => levels.get(p.coordinator) === i)
    if (levelPhases.length > 0) {
      result.push(levelPhases)
    }
  }

  return result
}

/**
 * Build default phase order when architecture phase fails or returns no plan.
 */
export function getDefaultPhases(): ParsedPhase[] {
  return [
    { name: "backend",  coordinator: "backend",  description: "Implement backend logic and APIs", dependsOn: [] },
    { name: "frontend", coordinator: "frontend",  description: "Implement frontend UI",            dependsOn: [] },
    { name: "security", coordinator: "security",  description: "Security audit",                   dependsOn: ["backend", "frontend"] },
    { name: "test",     coordinator: "test",      description: "Generate and run tests",            dependsOn: ["backend", "frontend"] },
    { name: "devops",   coordinator: "devops",    description: "Prepare deployment pipeline",       dependsOn: ["security", "test"] },
    { name: "reviewer", coordinator: "reviewer",  description: "Final quality gate",                dependsOn: ["devops"] },
  ]
}
