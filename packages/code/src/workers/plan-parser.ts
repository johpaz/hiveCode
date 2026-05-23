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
}

const VALID_PHASES: PhaseName[] = ["backend", "frontend", "security", "test", "devops", "dba", "integration", "reviewer"]

/** Extract JSON from text (handles markdown code blocks) */
function extractJson(text: string): string | null {
  // Try markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim()
    if (inner.startsWith("{")) return inner
  }

  // Try raw JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/)
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
 */
export function parsePlan(text: string): ParsedPlan {
  const jsonStr = extractJson(text)

  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr)

      const phases = ((parsed.phases || []) as any[])
        .map(normalizePhase)
        .filter((p): p is ParsedPhase => p !== null)

      return {
        adr: {
          title: String(parsed.adr?.title || "Untitled ADR"),
          context: String(parsed.adr?.context || ""),
          options: typeof parsed.adr?.options === "object" ? JSON.stringify(parsed.adr.options) : String(parsed.adr?.options || ""),
          decision: String(parsed.adr?.decision || ""),
          consequences: String(parsed.adr?.consequences || ""),
        },
        phases: sortPhases(phases),
        risks: (parsed.risks || []).map((r: any) => ({
          severity: ["HIGH", "MEDIUM", "LOW"].includes(r?.severity) ? r.severity : "MEDIUM",
          description: String(r?.description || ""),
        })),
        interfaces: Array.isArray(parsed.interfaces) ? JSON.stringify(parsed.interfaces) : (parsed.interfaces ? String(parsed.interfaces) : undefined),
      }
    } catch (err) {
      console.warn(`[plan-parser] JSON parse failed: ${(err as Error).message}`)
    }
  }

  // Fallback: return a default plan with all phases
  console.warn("[plan-parser] Failed to parse plan JSON — using default phase order")
  return {
    adr: {
      title: "Auto-generated ADR",
      context: text.slice(0, 500),
      options: "{}",
      decision: "Proceed with implementation",
      consequences: "See narrative for details",
    },
    phases: sortPhases([
      { name: "backend", coordinator: "backend", description: "Implement backend", dependsOn: [] },
      { name: "frontend", coordinator: "frontend", description: "Implement frontend", dependsOn: ["backend"] },
      { name: "security", coordinator: "security", description: "Security audit", dependsOn: ["backend", "frontend"] },
      { name: "test", coordinator: "test", description: "Generate and run tests", dependsOn: ["backend", "frontend"] },
      { name: "devops", coordinator: "devops", description: "Prepare deployment", dependsOn: ["security", "test"] },
    ]),
    risks: [{ severity: "MEDIUM", description: "Plan could not be parsed from JSON" }],
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
    { name: "backend", coordinator: "backend", description: "Implement backend", dependsOn: [] },
    { name: "frontend", coordinator: "frontend", description: "Implement frontend", dependsOn: ["backend"] },
    { name: "security", coordinator: "security", description: "Security audit", dependsOn: ["backend", "frontend"] },
    { name: "test", coordinator: "test", description: "Generate and run tests", dependsOn: ["backend", "frontend"] },
    { name: "devops", coordinator: "devops", description: "Prepare deployment", dependsOn: ["security", "test"] },
  ]
}
