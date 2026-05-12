import { describe, test, expect } from "bun:test"
import {
	COORDINATOR_TOOLS,
	toolToLLMToolDef,
	getToolsForCoordinator,
	executeToolByName,
	isToolAllowed,
} from "../../src/workers/tool-bridge"
import type { Tool } from "@johpaz/hive-code-core/tools"
import type { PhaseName, SessionMode } from "../../src/workers/types"

describe("COORDINATOR_TOOLS mapping", () => {
	const phases: PhaseName[] = ["architecture", "backend", "frontend", "security", "test", "devops"]

	test("all 6 coordinators have tool lists", () => {
		for (const phase of phases) {
			expect(COORDINATOR_TOOLS[phase]).toBeDefined()
			expect(COORDINATOR_TOOLS[phase].length).toBeGreaterThan(0)
		}
	})

	test("architecture has only read-only tools", () => {
		const archTools = COORDINATOR_TOOLS.architecture
		const writeTools = ["fs_write", "fs_edit", "fs_delete", "git_commit", "shell_executor"]
		for (const wt of writeTools) {
			expect(archTools).not.toContain(wt)
		}
	})

	test("security has only read-only tools", () => {
		const secTools = COORDINATOR_TOOLS.security
		const writeTools = ["fs_write", "fs_edit", "fs_delete", "git_commit", "shell_executor"]
		for (const wt of writeTools) {
			expect(secTools).not.toContain(wt)
		}
	})

	test("backend has write tools", () => {
		const beTools = COORDINATOR_TOOLS.backend
		expect(beTools).toContain("fs_write")
		expect(beTools).toContain("fs_edit")
		expect(beTools).toContain("shell_executor")
	})

	test("devops has rollback and PR tools", () => {
		const doTools = COORDINATOR_TOOLS.devops
		expect(doTools).toContain("git_rollback")
		expect(doTools).toContain("git_create_pr")
	})

	test("all coordinators have read_narrative", () => {
		for (const phase of phases) {
			expect(COORDINATOR_TOOLS[phase]).toContain("read_narrative")
		}
	})
})

describe("toolToLLMToolDef", () => {
	test("converts Tool to LLMToolDef format", () => {
		const mockTool: Tool = {
			name: "test_tool",
			description: "A test tool",
			parameters: { type: "object", properties: { x: { type: "string" } } },
		} as any

		const def = toolToLLMToolDef(mockTool)
		expect(def.type).toBe("function")
		expect(def.function.name).toBe("test_tool")
		expect(def.function.description).toBe("A test tool")
		expect(def.function.parameters).toEqual({ type: "object", properties: { x: { type: "string" } } })
	})
})

describe("getToolsForCoordinator", () => {
	const mockTools: Tool[] = [
		{ name: "fs_read", description: "Read file", parameters: {} } as any,
		{ name: "fs_write", description: "Write file", parameters: {} } as any,
		{ name: "fs_edit", description: "Edit file", parameters: {} } as any,
		{ name: "parse_ast", description: "Parse AST", parameters: {} } as any,
		{ name: "code_search", description: "Search code", parameters: {} } as any,
		{ name: "git_commit", description: "Git commit", parameters: {} } as any,
	]

	test("returns only allowed tools for architecture", () => {
		const defs = getToolsForCoordinator("architecture", mockTools)
		const names = defs.map(d => d.function.name)
		expect(names).toContain("fs_read")
		expect(names).toContain("parse_ast")
		expect(names).not.toContain("fs_write")
		expect(names).not.toContain("git_commit")
	})

	test("returns write tools for backend", () => {
		const defs = getToolsForCoordinator("backend", mockTools)
		const names = defs.map(d => d.function.name)
		expect(names).toContain("fs_write")
		expect(names).toContain("fs_edit")
	})

	test("excludes tools not in the registry", () => {
		const defs = getToolsForCoordinator("security", mockTools)
		const names = defs.map(d => d.function.name)
		expect(names).not.toContain("fs_write")
		expect(names).not.toContain("git_commit")
	})
})

describe("executeToolByName", () => {
	const mockTools: Tool[] = [
		{
			name: "echo",
			description: "Echo input",
			parameters: {},
			execute: async (args: any) => ({ ok: true, echoed: args.msg }),
		} as any,
		{
			name: "failing_tool",
			description: "Always fails",
			parameters: {},
			execute: async () => { throw new Error("Tool error") },
		} as any,
	]

	test("executes tool and returns result", async () => {
		const result = await executeToolByName(mockTools, "echo", { msg: "hello" })
		expect((result as any).ok).toBe(true)
		expect((result as any).echoed).toBe("hello")
	})

	test("returns error for missing tool", async () => {
		const result = await executeToolByName(mockTools, "nonexistent", {}) as any
		expect(result.ok).toBe(false)
		expect(result.error).toContain("not found")
	})

	test("returns error for tool without execute", async () => {
		const toolsWithoutExec: Tool[] = [
			{ name: "no_exec", description: "No exec", parameters: {} } as any,
		]
		const result = await executeToolByName(toolsWithoutExec, "no_exec", {}) as any
		expect(result.ok).toBe(false)
		expect(result.error).toContain("not found or not executable")
	})

	test("catches tool execution errors", async () => {
		const result = await executeToolByName(mockTools, "failing_tool", {}) as any
		expect(result.ok).toBe(false)
		expect(result.error).toBe("Tool error")
		expect(result.tool).toBe("failing_tool")
	})
})

describe("isToolAllowed", () => {
	test("allows read tools in plan mode", () => {
		expect(isToolAllowed("fs_read", "architecture", "plan")).toBe(true)
		expect(isToolAllowed("fs_list", "backend", "plan")).toBe(true)
		expect(isToolAllowed("code_search", "backend", "plan")).toBe(true)
	})

	test("blocks write tools in plan mode", () => {
		expect(isToolAllowed("fs_write", "backend", "plan")).toBe(false)
		expect(isToolAllowed("fs_edit", "frontend", "plan")).toBe(false)
		expect(isToolAllowed("fs_delete", "backend", "plan")).toBe(false)
		expect(isToolAllowed("git_commit", "backend", "plan")).toBe(false)
		expect(isToolAllowed("git_branch", "devops", "plan")).toBe(false)
		expect(isToolAllowed("append_narrative", "test", "plan")).toBe(false)
	})

	test("allows write tools in approval mode", () => {
		expect(isToolAllowed("fs_write", "backend", "approval")).toBe(true)
		expect(isToolAllowed("git_commit", "backend", "approval")).toBe(true)
	})

	test("allows write tools in auto mode", () => {
		expect(isToolAllowed("fs_write", "backend", "auto")).toBe(true)
		expect(isToolAllowed("shell_executor", "test", "auto")).toBe(true)
	})

	test("blocks tool not in coordinator's list regardless of mode", () => {
		expect(isToolAllowed("fs_write", "architecture", "auto")).toBe(false)
		expect(isToolAllowed("git_create_pr", "security", "approval")).toBe(false)
		expect(isToolAllowed("shell_executor", "architecture", "auto")).toBe(false)
	})
})
