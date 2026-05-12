import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { SCHEMA, PROJECTS_SCHEMA, CONTEXT_ENGINE_SCHEMA, MEETING_SCHEMA } from "@johpaz/hive-code-core/storage/schema"
import { CODE_SCHEMA } from "../../src/narrative/schema"

let db: Database
let tmpDir: string

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-schema-test-"))
	const dbPath = path.join(tmpDir, "schema-test.db")
	db = new Database(dbPath, { create: true })
	db.run("PRAGMA foreign_keys = ON")
	db.run(SCHEMA)
	db.run(PROJECTS_SCHEMA)
	db.run(CONTEXT_ENGINE_SCHEMA)
	db.run(MEETING_SCHEMA)
	db.run(CODE_SCHEMA)
})

afterAll(() => {
	db.close()
	if (tmpDir && fs.existsSync(tmpDir)) {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	}
})

describe("Schema validation", () => {
	const requiredCoreTables = [
		"users", "providers", "models", "agents", "channels",
		"mcp_servers", "skills", "tools", "ethics", "code_bridge",
		"cron_jobs", "task_runs", "conversations", "summaries",
		"scratchpad", "traces", "playbook", "tool_cache",
	]

	const requiredCodeTables = [
		"code_sessions", "code_session_modes", "code_tasks", "code_task_phases",
		"code_narrative", "code_decisions", "code_file_snapshots", "code_traces",
		"code_playbook", "code_reflections", "code_config", "code_context_cache",
	]

	test("all core tables exist", () => {
		for (const table of requiredCoreTables) {
			const row = db.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
			).get(table) as { name: string } | undefined
			expect(row).toBeDefined()
		}
	})

	test("all code_* tables exist", () => {
		for (const table of requiredCodeTables) {
			const row = db.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
			).get(table) as { name: string } | undefined
			expect(row).toBeDefined()
		}
	})

	test("FTS5 virtual tables exist", () => {
		const ftsTables = [
			"playbook_fts", "tools_fts", "skills_fts", "mcp_tools_fts",
			"code_narrative_fts", "code_playbook_fts",
		]
		for (const table of ftsTables) {
			const row = db.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
			).get(table) as { name: string } | undefined
			expect(row).toBeDefined()
		}
	})

	test("code_sessions has correct columns", () => {
		const info = db.query("PRAGMA table_info(code_sessions)").all() as any[]
		const cols = info.map(c => c.name)
		expect(cols).toContain("id")
		expect(cols).toContain("project_path")
		expect(cols).toContain("created_at")
		expect(cols).toContain("last_active")
	})

	test("code_tasks has CHECK constraints on status and mode", () => {
		const sql = db.query(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name = 'code_tasks'"
		).get() as { sql: string } | undefined
		expect(sql?.sql).toContain("CHECK(status IN")
		expect(sql?.sql).toContain("CHECK(mode IN")
	})

	test("code_narrative references both session and task", () => {
		const sql = db.query(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name = 'code_narrative'"
		).get() as { sql: string } | undefined
		expect(sql?.sql).toContain("REFERENCES code_tasks")
		expect(sql?.sql).toContain("REFERENCES code_sessions")
	})

	test("code_traces has analyzed column defaulting to 0", () => {
		const info = db.query("PRAGMA table_info(code_traces)").all() as any[]
		const analyzed = info.find(c => c.name === "analyzed")
		expect(analyzed).toBeDefined()
		expect(analyzed.dflt_value).toContain("0")
	})

	test("can insert and query a full code workflow", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/test/project")

		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'running', 'auto')").run(taskId, sessionId, "Build feature X")

		db.query("INSERT INTO code_narrative (task_id, session_id, coordinator, entry) VALUES (?, ?, 'backend', 'Created API')").run(taskId, sessionId)

		db.query("INSERT INTO code_traces (task_id, agent_id, coordinator, tool_name, success) VALUES (?, 'agent-1', 'backend', 'fs_write', 1)").run(taskId)

		const narrative = db.query("SELECT * FROM code_narrative WHERE task_id = ?").all(taskId) as any[]
		expect(narrative.length).toBe(1)
		expect(narrative[0].entry).toBe("Created API")

		const traces = db.query("SELECT * FROM code_traces WHERE task_id = ?").all(taskId) as any[]
		expect(traces.length).toBe(1)
		expect(traces[0].tool_name).toBe("fs_write")
		expect(traces[0].success).toBe(1)
	})
})
