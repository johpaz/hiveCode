import { describe, test, expect } from "bun:test"
import { parsePlan, groupPhasesByLevel, getDefaultPhases } from "../../src/workers/plan-parser"

describe("parsePlan", () => {
	const validPlan = JSON.stringify({
		adr: {
			title: "Use Bun for runtime",
			context: "Need fast local-first runtime",
			options: '{"options":["Bun","Node.js","Deno"]}',
			decision: "Bun",
			consequences: "Bun-specific APIs available",
		},
		phases: [
			{ name: "Backend API", coordinator: "backend", description: "Build REST API", dependsOn: [] },
			{ name: "React UI", coordinator: "frontend", description: "Build frontend", dependsOn: ["backend"] },
			{ name: "Security audit", coordinator: "security", description: "Audit code", dependsOn: ["backend", "frontend"] },
			{ name: "Test suite", coordinator: "test", description: "Write tests", dependsOn: ["backend", "frontend"] },
			{ name: "Deploy", coordinator: "devops", description: "CI/CD pipeline", dependsOn: ["security", "test"] },
		],
		risks: [
			{ severity: "HIGH", description: "Bun API compatibility" },
			{ severity: "LOW", description: "Minor style differences" },
		],
	})

	test("parses valid JSON plan", () => {
		const result = parsePlan(validPlan)
		expect(result.adr.title).toBe("Use Bun for runtime")
		expect(result.phases.length).toBe(5)
		expect(result.risks.length).toBe(2)
	})

	test("topological sort orders phases by dependency", () => {
		const result = parsePlan(validPlan)
		const coords = result.phases.map(p => p.coordinator)

		const backendIdx = coords.indexOf("backend")
		const frontendIdx = coords.indexOf("frontend")
		const securityIdx = coords.indexOf("security")
		const testIdx = coords.indexOf("test")
		const devopsIdx = coords.indexOf("devops")

		expect(backendIdx).toBeLessThan(frontendIdx)
		expect(frontendIdx).toBeLessThan(securityIdx)
		expect(frontendIdx).toBeLessThan(testIdx)
		expect(securityIdx).toBeLessThan(devopsIdx)
		expect(testIdx).toBeLessThan(devopsIdx)
	})

	test("parses JSON wrapped in markdown code block", () => {
		const wrapped = "Here's the plan:\n```json\n" + validPlan + "\n```\nLet me know if you have questions."
		const result = parsePlan(wrapped)
		expect(result.adr.title).toBe("Use Bun for runtime")
		expect(result.phases.length).toBe(5)
	})

	test("parses JSON in code block without language hint", () => {
		const wrapped = "```\n" + validPlan + "\n```"
		const result = parsePlan(wrapped)
		expect(result.adr.title).toBe("Use Bun for runtime")
	})

	test("filters out invalid coordinator names", () => {
		const planWithInvalid = JSON.stringify({
			adr: { title: "Test", context: "", options: "", decision: "", consequences: "" },
			phases: [
				{ coordinator: "backend", description: "Backend", dependsOn: [] },
				{ coordinator: "invalid_coord", description: "Invalid", dependsOn: [] },
			],
			risks: [],
		})
		const result = parsePlan(planWithInvalid)
		expect(result.phases.length).toBe(1)
		expect(result.phases[0].coordinator).toBe("backend")
	})

	test("filters invalid dependsOn references", () => {
		const planWithBadDeps = JSON.stringify({
			adr: { title: "Test", context: "", options: "", decision: "", consequences: "" },
			phases: [
				{ coordinator: "backend", description: "Backend", dependsOn: [] },
				{ coordinator: "frontend", description: "Frontend", dependsOn: ["backend", "nonexistent"] },
			],
			risks: [],
		})
		const result = parsePlan(planWithBadDeps)
		const frontend = result.phases.find(p => p.coordinator === "frontend")
		expect(frontend?.dependsOn).toEqual(["backend"])
	})

	test("normalizes invalid risk severity to MEDIUM", () => {
		const plan = JSON.stringify({
			adr: { title: "T", context: "", options: "", decision: "", consequences: "" },
			phases: [{ coordinator: "backend", description: "", dependsOn: [] }],
			risks: [
				{ severity: "CRITICAL", description: "Bad severity" },
				{ severity: "HIGH", description: "Valid severity" },
			],
		})
		const result = parsePlan(plan)
		expect(result.risks[0].severity).toBe("MEDIUM")
		expect(result.risks[1].severity).toBe("HIGH")
	})

	test("falls back to default plan on invalid JSON", () => {
		const result = parsePlan("This is not JSON at all")
		expect(result.adr.title).toBe("Auto-generated ADR")
		expect(result.phases.length).toBe(getDefaultPhases().length)
		expect(result.risks[0].severity).toBe("MEDIUM")
		expect(result.parseError).toContain("JSON estructurado valido")
	})

	test("falls back on malformed JSON", () => {
		const result = parsePlan("{ invalid json }}}")
		expect(result.adr.title).toBe("Auto-generated ADR")
		expect(result.parseError).toBeDefined()
	})

	test("handles missing adr gracefully", () => {
		const noAdr = JSON.stringify({
			phases: [{ coordinator: "backend", description: "Backend", dependsOn: [] }],
			risks: [],
		})
		const result = parsePlan(noAdr)
		expect(result.adr.title).toBe("Untitled ADR")
	})

	test("handles adr.options as object by serializing", () => {
		const objOptions = JSON.stringify({
			adr: {
				title: "T", context: "c",
				options: { A: "option A", B: "option B" },
				decision: "d", consequences: "c",
			},
			phases: [{ coordinator: "backend", description: "", dependsOn: [] }],
			risks: [],
		})
		const result = parsePlan(objOptions)
		expect(result.adr.options).toContain("option A")
	})

	test("preserves interfaces field when present", () => {
		const withInterfaces = JSON.stringify({
			adr: { title: "T", context: "", options: "", decision: "", consequences: "" },
			phases: [{ coordinator: "backend", description: "", dependsOn: [] }],
			risks: [],
			interfaces: "API: POST /api/v1/tasks",
		})
		const result = parsePlan(withInterfaces)
		expect(result.interfaces).toBe("API: POST /api/v1/tasks")
	})

	test("interfaces is undefined when absent", () => {
		const noInterfaces = JSON.stringify({
			adr: { title: "T", context: "", options: "", decision: "", consequences: "" },
			phases: [{ coordinator: "backend", description: "", dependsOn: [] }],
			risks: [],
		})
		const result = parsePlan(noInterfaces)
		expect(result.interfaces).toBeUndefined()
	})
})

describe("groupPhasesByLevel", () => {
	test("groups linear dependency chain into levels", () => {
		const phases = [
			{ name: "b", coordinator: "backend" as const, description: "", dependsOn: [] },
			{ name: "f", coordinator: "frontend" as const, description: "", dependsOn: ["backend"] },
			{ name: "d", coordinator: "devops" as const, description: "", dependsOn: ["frontend"] },
		]
		const levels = groupPhasesByLevel(phases)
		expect(levels.length).toBe(3)
		expect(levels[0].map(p => p.coordinator)).toEqual(["backend"])
		expect(levels[1].map(p => p.coordinator)).toEqual(["frontend"])
		expect(levels[2].map(p => p.coordinator)).toEqual(["devops"])
	})

	test("groups parallel phases at same level", () => {
		const phases = [
			{ name: "b", coordinator: "backend" as const, description: "", dependsOn: [] },
			{ name: "f", coordinator: "frontend" as const, description: "", dependsOn: ["backend"] },
			{ name: "s", coordinator: "security" as const, description: "", dependsOn: ["backend", "frontend"] },
			{ name: "t", coordinator: "test" as const, description: "", dependsOn: ["backend", "frontend"] },
			{ name: "d", coordinator: "devops" as const, description: "", dependsOn: ["security", "test"] },
		]
		const levels = groupPhasesByLevel(phases)

		expect(levels.length).toBe(4)
		expect(levels[0].map(p => p.coordinator)).toEqual(["backend"])
		expect(levels[1].map(p => p.coordinator)).toEqual(["frontend"])
		expect(new Set(levels[2].map(p => p.coordinator))).toEqual(new Set(["security", "test"]))
		expect(levels[3].map(p => p.coordinator)).toEqual(["devops"])
	})

	test("handles single phase", () => {
		const phases = [
			{ name: "b", coordinator: "backend" as const, description: "", dependsOn: [] },
		]
		const levels = groupPhasesByLevel(phases)
		expect(levels.length).toBe(1)
		expect(levels[0].length).toBe(1)
	})

	test("handles all independent phases (no deps)", () => {
		const phases = [
			{ name: "b", coordinator: "backend" as const, description: "", dependsOn: [] },
			{ name: "f", coordinator: "frontend" as const, description: "", dependsOn: [] },
		]
		const levels = groupPhasesByLevel(phases)
		expect(levels.length).toBe(1)
		expect(levels[0].length).toBe(2)
	})
})

describe("getDefaultPhases", () => {
	test("returns 6 phases in standard v4 order", () => {
		const phases = getDefaultPhases()
		expect(phases.length).toBe(6)
		expect(phases.map(p => p.coordinator)).toEqual(["backend", "frontend", "security", "test", "devops", "reviewer"])
	})

	test("default phases have proper dependencies (v4 parallel engineers)", () => {
		const phases = getDefaultPhases()
		// backend and frontend run in parallel (level 0)
		expect(phases[0].dependsOn).toEqual([])  // backend
		expect(phases[1].dependsOn).toEqual([])  // frontend — parallel with backend
		// security and test wait for both engineers (level 1)
		expect(phases[2].dependsOn).toEqual(["backend", "frontend"])  // security
		expect(phases[3].dependsOn).toEqual(["backend", "frontend"])  // test
		// devops waits for security + test (level 2)
		expect(phases[4].dependsOn).toEqual(["security", "test"])
		// reviewer is the final gate (level 3)
		expect(phases[5].dependsOn).toEqual(["devops"])
	})
})
