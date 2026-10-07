import { describe, it, expect } from "bun:test"
import { CORE_AGENT_TYPES, CORE_AGENT_DEFINITIONS } from "@johpaz/hivecode-core/agent/agent-profiles"
import { agentAlias, isKnownRole } from "@johpaz/hivecode-core/agent/agent-identity"

// ─── El gate de calidad es uno, no dos ─────────────────────────────────────────
//
// `verifier` y `reviewer` eran el mismo chequeo en dos momentos: ninguno
// escribía código, y ambos ejecutaban evidencia determinística
// antes de juzgar. En pantalla se leían como dos expertos distintos.
//
// Estos tests fallan si alguien los vuelve a separar, que es la forma más
// probable de que esta fusión se deshaga sin querer.

describe("quality gate fusion", () => {
  it("the two old roles are gone from the core profiles", () => {
    expect(CORE_AGENT_TYPES).not.toContain("reviewer" as never)
    expect(Object.keys(CORE_AGENT_DEFINITIONS)).not.toContain("reviewer")
    expect(CORE_AGENT_TYPES).toContain("verifier")
  })

  it("the surviving profile does both halves of the job", () => {
    const gate = CORE_AGENT_DEFINITIONS.verifier
    // Reproducir criterios exige ejecución determinística.
    expect(gate.tools).toContain("shell_executor")
    expect(gate.tools).toContain("code_test")
    expect(gate.tools).toContain("code_build")
    // Revisar el código exige poder leerlo y buscar en él.
    expect(gate.tools).toContain("check_types")
    // Y las dos mitades deben decirse en el prompt, no solo en el nombre.
    const prompt = gate.systemPrompt.toLowerCase()
    expect(prompt).toMatch(/criterio/)
    expect(prompt).toMatch(/revisa|revisar|diff/)
  })

  it("neither half lost its skills", () => {
    const skills = CORE_AGENT_DEFINITIONS.verifier.skills
    // Del verifier: reproducir en navegador y entender el código.
    expect(skills).toContain("browser_automate")
    expect(skills).toContain("code_analysis")
    // Del reviewer: juzgar calidad y seguridad.
    expect(skills).toContain("code_review")
    expect(skills).toContain("code_security_audit")
  })

  it("neither half lost its speckit reads", () => {
    // `speckit_converge` era solo del reviewer; `speckit_validate` de ambos.
    const gate = CORE_AGENT_DEFINITIONS.verifier
    expect(gate.tools).toContain("speckit_validate")
    expect(gate.tools).toContain("speckit_converge")
  })

  it("the gate is still read-only for the workspace", () => {
    // Ni el verifier ni el reviewer escribían. La fusión no puede abrir la
    // puerta a que el gate "arregle" lo que rechaza.
    const forbidden = ["fs_write", "fs_edit", "fs_delete", "git_commit"]
    for (const tool of forbidden) {
      expect(CORE_AGENT_DEFINITIONS.verifier.tools).not.toContain(tool)
    }
  })

  it("it is described as one gate, in Spanish", () => {
    const gate = CORE_AGENT_DEFINITIONS.verifier
    expect(gate.name).toBe("Quality Gate")
    expect(gate.description.toLowerCase()).toMatch(/verifica|revierve|revisa/)
    // El alias visible es el del roster, no un nombre en inglés.
    expect(agentAlias("verifier")).toBe("Puma")
    expect(agentAlias("quality")).toBe("Puma")
  })
})

describe("the fused role is recognized everywhere", () => {
  it("the identity table knows quality as the gate", () => {
    expect(isKnownRole("quality")).toBe(true)
    expect(isKnownRole("verifier")).toBe(true) // el perfil canónico conserva el id
    // Los nombres viejos caen a Title Case legible, no a vacío ni a crash.
    expect(agentAlias("reviewer")).toBe("Reviewer")
  })

  it("every remaining coordinator still has an identity", () => {
    const coordinators = [
      "bee", "product_manager", "architecture", "backend", "frontend",
      "data_scientist", "security", "test", "devops", "quality",
      "forensic", "librarian",
    ]
    for (const role of coordinators) {
      expect(isKnownRole(role)).toBe(true)
      expect(agentAlias(role).length).toBeGreaterThan(0)
    }
  })
})