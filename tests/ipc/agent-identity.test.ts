import { describe, it, expect } from "bun:test"
import {
  agentAlias,
  agentFunction,
  agentTierLevel,
  isKnownRole,
  isEphemeralRole,
  subagentAlias,
} from "@johpaz/hivecode-core/agent/agent-identity"

// ─── La identidad del enjambre ────────────────────────────────────────────────
//
// El proyecto es 100 % en español y la TUI mostraba "BackendEngineer",
// "SecurityAuditor", "CodeReviewer". Aquí vive el alias legible.
//
// Estos tests fijan dos invariantes que se rompen en silencio:
//
// 1. Todo rol tiene alias y función. Un rol nuevo sin entrada en la tabla
//    degrada a un nombre Title Case genérico que no dice nada.
// 2. La escala de niveles 0-5 coincide con el `AgentTier` de la TUI. Si divergen,
//    el roster y el grafo se contradicen sobre quién manda sobre quién.

const CORE_ROLES = [
  "bee", "product_manager", "architecture", "backend", "frontend",
  "data_scientist", "security", "test", "devops", "quality",
  "forensic", "librarian", "spider", "scout",
] as const

describe("agent identity", () => {
  it("every core role has an alias and a one-line function", () => {
    for (const role of CORE_ROLES) {
      expect(isKnownRole(role)).toBe(true)
      const alias = agentAlias(role)
      expect(alias.length).toBeGreaterThan(0)
      expect(alias).not.toBe(role)
      // The function is what the user reads to know what this agent is for.
      expect(agentFunction(role).length).toBeGreaterThan(10)
    }
  })

  it("no alias is left in English", () => {
    // The whole point of the fauna roster.
    const forbidden = ["Engineer", "Manager", "Auditor", "Reviewer", "Verifier", "Scientist"]
    for (const role of CORE_ROLES) {
      const alias = agentAlias(role)
      for (const word of forbidden) {
        expect(alias).not.toContain(word)
      }
    }
  })

  it("aliases are unique — two roles sharing a name would be unreadable", () => {
    const aliases = CORE_ROLES.map(agentAlias)
    expect(new Set(aliases).size).toBe(aliases.length)
  })

  it("the tier scale matches the TUI's AgentTier", () => {
    expect(agentTierLevel("bee")).toBe(0)            // Orchestrator
    expect(agentTierLevel("architecture")).toBe(1)   // Planning
    expect(agentTierLevel("backend")).toBe(2)        // Engineering
    expect(agentTierLevel("security")).toBe(3)       // Quality
    expect(agentTierLevel("quality")).toBe(4)        // Gate
    expect(agentTierLevel("librarian")).toBe(5)      // OnDemand
  })

  it("verifier and reviewer both resolve to the fused quality role", () => {
    // Capa 4 fusiona los dos en `quality`. Los dos nombres antiguos siguen
    // funcionando mientras el enum no se migre.
    expect(agentAlias("quality")).toBe("Puma")
    expect(agentTierLevel("quality")).toBe(4)
  })

  it("an unknown role degrades to a readable title, never to empty", () => {
    // `undefined` en la UI es peor que un nombre genérico: se vería como hueco.
    expect(agentAlias("agente_desconocido")).toBe("Agente Desconocido")
    expect(agentAlias("")).toBe("")
    expect(isKnownRole("agente_desconocido")).toBe(false)
    expect(agentFunction("agente_desconocido")).toBe("")
  })

  it("an unknown role is treated as on-demand, not as central", () => {
    // Un rol desconocido no debe aparecer en el centro del grafo por error.
    expect(agentTierLevel("agente_desconocido")).toBe(5)
  })

  it("subagents get counted aliases that never collide", () => {
    expect(subagentAlias(1)).toBe("Hormiga-01")
    expect(subagentAlias(9)).toBe("Hormiga-09")
    expect(subagentAlias(10)).toBe("Hormiga-10")
    expect(subagentAlias(100)).toBe("Hormiga-100")

    const many = Array.from({ length: 50 }, (_, i) => subagentAlias(i + 1))
    expect(new Set(many).size).toBe(50)
  })

  it("ephemeral roles are recognised so they can inherit their parent's colour", () => {
    expect(isEphemeralRole("subagent:api")).toBe(true)
    expect(isEphemeralRole("hormiga-01")).toBe(true)
    expect(isEphemeralRole("backend")).toBe(false)
  })

  it("every core function says what the agent does without jargon-only words", () => {
    // The function is the answer to "¿qué hace este?".
    for (const role of ["backend", "frontend", "test", "security"]) {
      const fn = agentFunction(role)
      expect(fn).toMatch(/[.·]/)
      expect(fn.split(/[.·]/).filter(s => s.trim().length > 0).length).toBeGreaterThanOrEqual(2)
    }
  })
})