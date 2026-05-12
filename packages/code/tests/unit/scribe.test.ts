import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { SCHEMA, PROJECTS_SCHEMA, CONTEXT_ENGINE_SCHEMA, MEETING_SCHEMA } from "@johpaz/hive-code-core/storage/schema"
import { CODE_SCHEMA } from "../../src/narrative/schema"
import type { NarrativeEntry, ADR } from "../../src/workers/types"

let db: Database
let tmpDir: string

function mapEntry(r: any): NarrativeEntry {
	return {
		id: r.id, taskId: r.task_id, sessionId: r.session_id,
		coordinator: r.coordinator, phase: r.phase, entry: r.entry,
		isDraft: r.is_draft === 1, isOverride: r.is_override === 1,
		createdAt: r.created_at,
	}
}

function mapADR(r: any): ADR {
	return {
		id: r.id, taskId: r.task_id, title: r.title,
		context: r.context, options: r.options, decision: r.decision,
		consequences: r.consequences, status: r.status, createdAt: r.created_at,
	}
}

function mapSnapshot(r: any) {
	return {
		id: r.id, taskId: r.task_id, filePath: r.file_path,
		content: r.content, hash: r.hash, snapshotAt: r.snapshot_at,
	}
}

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivecode-scribe-test-"))
	const dbPath = path.join(tmpDir, "scribe-test.db")
	db = new Database(dbPath, { create: true })
	db.run("PRAGMA journal_mode = WAL")
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

describe("Scribe (direct DB)", () => {
	test("createSession inserts into code_sessions", () => {
		const id = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(id, "/tmp/test-project")

		const row = db.query("SELECT * FROM code_sessions WHERE id = ?").get(id) as any
		expect(row).toBeDefined()
		expect(row.project_path).toBe("/tmp/test-project")
	})

	test("createTask inserts task with pending status", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Build API endpoint")

		const row = db.query("SELECT * FROM code_tasks WHERE id = ?").get(taskId) as any
		expect(row).toBeDefined()
		expect(row.session_id).toBe(sessionId)
		expect(row.description).toBe("Build API endpoint")
		expect(row.status).toBe("pending")
		expect(row.mode).toBe("auto")
	})

	test("updateTaskStatus transitions correctly", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("UPDATE code_tasks SET status = ? WHERE id = ?").run("running", taskId)
		let row = db.query("SELECT * FROM code_tasks WHERE id = ?").get(taskId) as any
		expect(row.status).toBe("running")

		db.query(`UPDATE code_tasks SET status = ?, completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END, branch_name = ?, pr_url = ? WHERE id = ?`).run("completed", "completed", "feat/test", "https://github.com/test/pr/1", taskId)
		row = db.query("SELECT * FROM code_tasks WHERE id = ?").get(taskId) as any
		expect(row.status).toBe("completed")
		expect(row.completed_at).toBeTruthy()
		expect(row.branch_name).toBe("feat/test")
		expect(row.pr_url).toBe("https://github.com/test/pr/1")
	})

	test("createPhase inserts phase with pending status", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		const result = db.query("INSERT INTO code_task_phases (task_id, phase_name, coordinator, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(taskId, "backend", "backend") as { id: number }
		expect(result.id).toBeDefined()

		const row = db.query("SELECT * FROM code_task_phases WHERE id = ?").get(result.id) as any
		expect(row.task_id).toBe(taskId)
		expect(row.phase_name).toBe("backend")
		expect(row.coordinator).toBe("backend")
		expect(row.status).toBe("pending")
	})

	test("updatePhaseStatus sets timestamps", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")
		const { id: phaseId } = db.query("INSERT INTO code_task_phases (task_id, phase_name, coordinator, status) VALUES (?, ?, ?, 'pending') RETURNING id").get(taskId, "backend", "backend") as { id: number }

		db.query("UPDATE code_task_phases SET status = ?, started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run("running", phaseId)
		let row = db.query("SELECT * FROM code_task_phases WHERE id = ?").get(phaseId) as any
		expect(row.status).toBe("running")
		expect(row.started_at).toBeTruthy()

		db.query("UPDATE code_task_phases SET status = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), result_summary = ? WHERE id = ?").run("completed", "All tests pass", phaseId)
		row = db.query("SELECT * FROM code_task_phases WHERE id = ?").get(phaseId) as any
		expect(row.status).toBe("completed")
		expect(row.completed_at).toBeTruthy()
		expect(row.result_summary).toBe("All tests pass")
	})

	test("appendNarrative inserts and readNarrative retrieves in order", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry, is_draft, is_override) VALUES (?, ?, ?, ?, ?, 0, 0)").run(taskId, sessionId, "backend", "backend", "Created API route")
		db.query("INSERT INTO code_narrative (task_id, session_id, coordinator, phase, entry, is_draft, is_override) VALUES (?, ?, ?, ?, ?, 0, 0)").run(taskId, sessionId, "frontend", "frontend", "Built React component")

		const rows = db.query("SELECT * FROM code_narrative WHERE task_id = ? ORDER BY id ASC").all(taskId) as any[]
		const narrative = rows.map(mapEntry)
		expect(narrative.length).toBe(2)
		expect(narrative[0].entry).toBe("Created API route")
		expect(narrative[1].entry).toBe("Built React component")
	})

	test("narrative with isDraft and isOverride flags", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("INSERT INTO code_narrative (task_id, session_id, coordinator, entry, is_draft, is_override) VALUES (?, ?, ?, ?, 1, 0)").run(taskId, sessionId, "backend", "Draft entry")
		db.query("INSERT INTO code_narrative (task_id, session_id, coordinator, entry, is_draft, is_override) VALUES (?, ?, ?, ?, 0, 1)").run(taskId, sessionId, "backend", "Override entry")

		const rows = db.query("SELECT * FROM code_narrative WHERE task_id = ? ORDER BY id").all(taskId) as any[]
		const narrative = rows.map(mapEntry)
		expect(narrative.find(n => n.entry === "Draft entry")?.isDraft).toBe(true)
		expect(narrative.find(n => n.entry === "Override entry")?.isOverride).toBe(true)
	})

	test("writeDecision and readDecisions round-trip", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		const adrId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_decisions (id, task_id, title, context, options, decision, consequences, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			adrId, taskId, "Use SQLite over PostgreSQL", "Local-first constraint",
			'{"options":["SQLite","PostgreSQL"]}', "SQLite", "No external DB dependency", "active"
		)

		const rows = db.query("SELECT * FROM code_decisions WHERE status = ? ORDER BY created_at DESC").all("active") as any[]
		const decisions = rows.map(mapADR)
		expect(decisions.length).toBeGreaterThanOrEqual(1)
		const found = decisions.find(d => d.taskId === taskId)
		expect(found).toBeDefined()
		expect(found!.title).toBe("Use SQLite over PostgreSQL")
		expect(found!.decision).toBe("SQLite")
	})

	test("saveSnapshot and getSnapshots round-trip", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)").run(taskId, "/src/index.ts", "original content", "abc123")
		db.query("INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)").run(taskId, "/src/utils.ts", "utils content", "def456")

		const rows = db.query("SELECT * FROM code_file_snapshots WHERE task_id = ? ORDER BY id").all(taskId) as any[]
		const snapshots = rows.map(mapSnapshot)
		expect(snapshots.length).toBe(2)
		expect(snapshots[0].filePath).toBe("/src/index.ts")
		expect(snapshots[0].hash).toBe("abc123")
		expect(snapshots[1].filePath).toBe("/src/utils.ts")
	})

	test("deleteSnapshots removes all snapshots for a task", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)").run(taskId, "/src/index.ts", "content", "hash1")
		db.query("DELETE FROM code_file_snapshots WHERE task_id = ?").run(taskId)

		const rows = db.query("SELECT * FROM code_file_snapshots WHERE task_id = ?").all(taskId) as any[]
		expect(rows.length).toBe(0)
	})

	test("writeTrace inserts execution trace", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query(`INSERT INTO code_traces (task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success, duration_ns, tokens_in, tokens_out, analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
			taskId, "backend-0", "backend", "fs_write",
			"Write /src/api.ts", "File written successfully",
			1, 1500000, 120, 45
		)

		const row = db.query("SELECT * FROM code_traces WHERE task_id = ?").get(taskId) as any
		expect(row).toBeDefined()
		expect(row.tool_name).toBe("fs_write")
		expect(row.success).toBe(1)
		expect(row.duration_ns).toBe(1500000)
		expect(row.tokens_in).toBe(120)
		expect(row.tokens_out).toBe(45)
		expect(row.analyzed).toBe(0)
	})

	test("writeTrace with failure records success=0", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query(`INSERT INTO code_traces (task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success, duration_ns, analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
			taskId, "backend-0", "backend", "shell_executor",
			"npm run build", "Build failed: type error", 0, 5000000000
		)

		const row = db.query("SELECT * FROM code_traces WHERE task_id = ? AND tool_name = 'shell_executor'").get(taskId) as any
		expect(row).toBeDefined()
		expect(row.success).toBe(0)
	})

	test("logModeChange inserts session mode record", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("INSERT INTO code_session_modes (session_id, task_id, mode, phase_at_change, triggered_by) VALUES (?, ?, ?, ?, 'cli')").run(sessionId, taskId, "approval", "architecture")

		const row = db.query("SELECT * FROM code_session_modes WHERE session_id = ?").get(sessionId) as any
		expect(row).toBeDefined()
		expect(row.mode).toBe("approval")
		expect(row.task_id).toBe(taskId)
		expect(row.phase_at_change).toBe("architecture")
		expect(row.triggered_by).toBe("cli")
	})

	test("getTaskContext returns narrative, decisions, and files", () => {
		const sessionId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_sessions (id, project_path) VALUES (?, ?)").run(sessionId, "/tmp/test")
		const taskId = Bun.randomUUIDv7()
		db.query("INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, ?, ?, 'pending', 'auto')").run(taskId, sessionId, "Test task")

		db.query("INSERT INTO code_narrative (task_id, session_id, coordinator, entry, is_draft, is_override) VALUES (?, ?, ?, ?, 0, 0)").run(taskId, sessionId, "architecture", "Planned architecture")
		db.query("INSERT INTO code_decisions (id, task_id, title, context, options, decision, consequences, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			Bun.randomUUIDv7(), taskId, "ADR 1", "c", "o", "d", "con", "active"
		)
		db.query("INSERT INTO code_file_snapshots (task_id, file_path, content, hash) VALUES (?, ?, ?, ?)").run(taskId, "/src/app.ts", "content", "hash")

		const narrativeRows = db.query("SELECT * FROM code_narrative WHERE task_id = ? ORDER BY id ASC LIMIT 50").all(taskId) as any[]
		const decisionRows = db.query("SELECT * FROM code_decisions ORDER BY created_at DESC").all() as any[]
		const snapshotRows = db.query("SELECT * FROM code_file_snapshots WHERE task_id = ? ORDER BY id").all(taskId) as any[]

		expect(narrativeRows.length).toBe(1)
		expect(decisionRows.filter(d => d.task_id === taskId).length).toBe(1)
		expect(snapshotRows.length).toBe(1)
	})
})
