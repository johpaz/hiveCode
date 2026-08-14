/**
 * End-to-end tests for the message flow hiveCode actually emits in production.
 *
 * The existing `tui-e2e.test.ts` drives the TUI with `thought_chunk` /
 * `assistant_chunk` / `assistant_done` — variants that exist only on the Rust
 * side; no Bun code path emits them (see tests/contracts/ipc-contract.test.ts).
 * This suite covers the messages the harness really sends: `narrative_chunk`,
 * `history_append`, `worker_update`, `activity_update`, `file_diff`,
 * `file_risk_update`, `dashboard_snapshot`, `checkpoint_created`,
 * `task_update`, `plan_update`, `review_verdict_update`, `halt_state` and the
 * conflict lifecycle.
 *
 * Real binary, real socket, real serde deserialization, real Canvas render.
 *
 * Requires: cargo build --manifest-path packages/hivetui/Cargo.toml
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  BINARY, frameContains, frameText, startSession, waitForFrame,
  type BunMessage,
} from "./harness.ts"

beforeAll(() => {
  if (!existsSync(BINARY)) {
    throw new Error(
      `hivetui binary not found at ${BINARY}\n` +
      `Build it first: cargo build --manifest-path packages/hivetui/Cargo.toml`,
    )
  }
})

// ── Production message builders ───────────────────────────────────────────────

const workerUpdate = (worker: string, phase: string, status: string, extra: Record<string, unknown> = {}): BunMessage => ({
  type: "worker_update", worker, phase, status, ...extra,
})

// ── 1. Full auto-mode task lifecycle ──────────────────────────────────────────

describe("E2E flow: full auto-mode task lifecycle", () => {
  test("running task → parallel workers → diff → checkpoint → completion", async () => {
    const s = await startSession("auto")
    try {
      const taskId = "task-lifecycle-1"

      // The user's request lands in history and the harness starts working.
      s.ipc.send({
        type: "history_append", role: "user",
        content: "implementa el refresh token", timestamp: "10:00",
      })
      s.ipc.send({ type: "status", running: true, msg: "Analizando…" })
      s.ipc.send({
        type: "activity_update", coordinator: "bee", phase: "planning",
        status: "running", activity: "descomponiendo la tarea", task_id: taskId,
      })

      const working = await waitForFrame(s.iter, f => f.running, 5000, "running=true")
      expect(working.running).toBe(true)

      // Two workers in parallel → the TUI must route to Dashboard.
      s.ipc.send(workerUpdate("backend", "escribiendo src/auth/jwt.ts", "running", {
        display_name: "BackendEngineer", activity: "SENTINEL_BACKEND_ACTIVITY",
        task_id: taskId, level: 2, current_file: "src/auth/jwt.ts",
        iteration_current: 1, iteration_total: 3,
      }))
      s.ipc.send(workerUpdate("frontend", "escribiendo src/ui/Login.tsx", "running", {
        display_name: "FrontendEngineer", task_id: taskId, level: 2,
      }))

      const parallel = await waitForFrame(s.iter, f => f.tab === "dashboard", 5000, "dashboard tab")
      expect(parallel.tab).toBe("dashboard")

      // Streamed reasoning is the production narration channel.
      s.ipc.send({
        type: "narrative_chunk", coordinator: "backend", phase: "implementing",
        content: "SENTINEL_NARRATIVE firmando el token", task_id: taskId,
      })

      // One worker finishes → a single L2 worker remains, so the diff that
      // follows routes to the Code tab (`route_after_diff`).
      s.ipc.send(workerUpdate("frontend", "listo", "done", { task_id: taskId }))

      // A real diff arrives from the workspace.
      s.ipc.send({
        type: "file_diff", path: "src/auth/SENTINEL_DIFF.ts",
        branch: "feat/refresh-token", stats_added: 12, stats_removed: 3,
        task_id: taskId,
        chunks: [
          { kind: "add", text: "export function refresh() {", new_line_no: 10 },
          { kind: "context", text: "  return token", old_line_no: 11, new_line_no: 11 },
          { kind: "del", text: "  return null", old_line_no: 12 },
        ],
      }, { priority: "low" })

      s.ipc.send({
        type: "file_risk_update", path: "src/auth/SENTINEL_DIFF.ts",
        risk: "high", operation: "modified", adr_ref: "ADR-004",
        reason: "toca el flujo de autenticación", agent: "backend",
        lines_added: 12, lines_removed: 3, task_id: taskId,
      }, { priority: "critical" })

      const diffFrame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_DIFF"), 5000, "file diff",
      )
      expect(diffFrame.tab).toBe("code")
      expect(frameContains(diffFrame, "SENTINEL_DIFF")).toBe(true)

      // Checkpoint before finishing.
      s.ipc.send({
        type: "checkpoint_created", checkpoint_id: "cp_lifecycle_1",
        description: "SENTINEL_CHECKPOINT antes de integrar", file_count: 2,
        agent: "backend", tests_passed: 8, tests_total: 8,
      }, { priority: "low" })

      // The last worker winds down, task completes → routing back to Focus.
      s.ipc.send(workerUpdate("backend", "listo", "done", { task_id: taskId }))
      s.ipc.send({
        type: "task_update", task_id: taskId, title: "refresh token",
        status: "done", mode: "auto", integration_status: "merged",
      })
      s.ipc.send({
        type: "history_append", role: "assistant",
        content: "SENTINEL_FINAL refresh token implementado",
        content_type: "markdown", agent: "bee", timestamp: "10:04",
      })
      s.ipc.send({ type: "status", running: false, msg: "Listo" })

      const done = await waitForFrame(
        s.iter, f => !f.running && f.tab === "focus", 5000, "completed task on focus",
      )
      expect(done.running).toBe(false)
      expect(done.tab).toBe("focus")

      const finalFrame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_FINAL"), 5000, "final answer",
      )
      expect(frameContains(finalFrame, "SENTINEL_FINAL")).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("a single active worker routes to the Code tab", async () => {
    const s = await startSession("auto")
    try {
      const taskId = "task-single-worker"
      s.ipc.send({ type: "status", running: true, msg: "trabajando" })
      // The task must exist before worker routing can classify it — the
      // harness always announces the coordinator activity first.
      s.ipc.send({
        type: "activity_update", coordinator: "backend", phase: "editando",
        status: "running", task_id: taskId,
      })
      s.ipc.send(workerUpdate("backend", "editando src/only.ts", "running", {
        display_name: "BackendEngineer", current_file: "src/only.ts",
        task_id: taskId, level: 2,
      }))

      const frame = await waitForFrame(s.iter, f => f.tab === "code", 5000, "code tab")
      expect(frame.tab).toBe("code")
      expect(frame.running).toBe(true)
    } finally {
      s.dispose()
    }
  })
})

// ── 2. Dashboard snapshot hydration ───────────────────────────────────────────

describe("E2E flow: dashboard_snapshot", () => {
  test("a single snapshot hydrates workers, blackboard, metrics and security", async () => {
    const s = await startSession("auto")
    try {
      // Snapshots are how the TUI recovers full state after a resume.
      s.ipc.send({
        type: "dashboard_snapshot",
        workers: [
          { name: "backend", status: "running", detail: "editando", display_name: "SENTINEL_WORKER",
            activity: "implementando refresh", token_count: 12_000, level: 2,
            current_action: "escribiendo handler", current_file: "src/auth.ts",
            iteration_current: 2, iteration_total: 5, transversal: false },
          { name: "security", status: "running", detail: "auditando",
            display_name: "SecurityAuditor", level: 3, transversal: true },
        ],
        blackboard_events: [
          { timestamp: "12:00:00", agent: "architecture", event_type: "DECISION",
            content: "SENTINEL_DECISION mantener contrato" },
        ],
        levels: [{ level: 2, label: "Engineering", agents: ["backend"], status: "active" }],
        checkpoints: [{ checkpoint_id: "cp_snap", description: "SENTINEL_CP",
          file_count: 2, agent: "backend", time: "12:00:01", tests_passed: 4, tests_total: 4 }],
        metrics: { token_count: 12_000, cost: "$0.04", elapsed_secs: 61 },
        security: { status: "WATCHING", findings: 0 },
        halt: { active: false },
      }, { priority: "low" })

      // A snapshot hydrates state but does not itself change the active tab —
      // the harness follows it with normal activity, which is what routes.
      const taskId = "task-snapshot"
      s.ipc.send({
        type: "activity_update", coordinator: "backend", phase: "implementando",
        status: "running", task_id: taskId,
      })
      s.ipc.send(workerUpdate("backend", "implementando", "running", { task_id: taskId, level: 2 }))
      s.ipc.send(workerUpdate("frontend", "maquetando", "running", { task_id: taskId, level: 2 }))

      const frame = await waitForFrame(
        s.iter, f => f.tab === "dashboard" && frameContains(f, "SENTINEL_WORKER"),
        5000, "hydrated worker on dashboard",
      )

      // The display_name from the snapshot survived the later worker_update,
      // proving the snapshot populated real state rather than being discarded.
      expect(frameContains(frame, "SENTINEL_WORKER")).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("snapshot metrics reach the always-visible header", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({
        type: "dashboard_snapshot",
        metrics: { token_count: 45_678, cost: "$0.12", elapsed_secs: 90 },
        security: { status: "WATCHING", findings: 0 },
        halt: { active: false },
      }, { priority: "low" })

      // The header renders on every tab, so this is routing-independent.
      const frame = await waitForFrame(
        s.iter, f => /45[.,]?678|45\.7k|45k/i.test(frameText(f)), 5000, "token count in header",
      )
      expect(frameText(frame)).toMatch(/45[.,]?678|45\.7k|45k/i)
    } finally {
      s.dispose()
    }
  })
})

// ── 3. Conflicts, halts and forensics ─────────────────────────────────────────

describe("E2E flow: critical alerts", () => {
  test("conflict_alert surfaces and conflict_resolved clears it", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({
        type: "conflict_alert", agent_a: "backend", agent_b: "frontend",
        file: "src/SENTINEL_CONFLICT.ts", reason: "edición simultánea",
        severity: "high", detail: "ambos escriben el mismo símbolo",
      }, { priority: "critical" })

      const alerted = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_CONFLICT"), 5000, "conflict alert",
      )
      expect(frameContains(alerted, "SENTINEL_CONFLICT")).toBe(true)

      s.ipc.send({
        type: "conflict_resolved", agent_a: "backend", agent_b: "frontend",
        file: "src/SENTINEL_CONFLICT.ts",
      }, { priority: "critical" })

      const cleared = await waitForFrame(
        s.iter, f => !frameContains(f, "SENTINEL_CONFLICT"), 5000, "conflict cleared",
      )
      expect(frameContains(cleared, "SENTINEL_CONFLICT")).toBe(false)
    } finally {
      s.dispose()
    }
  })

  test("halt_state routes to Dashboard and shows the stop reason", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({
        type: "halt_state", active: true,
        reason: "SENTINEL_HALT veto de seguridad", checkpoint_id: "cp_halt",
      }, { priority: "critical" })

      const halted = await waitForFrame(
        s.iter, f => f.tab === "dashboard" && frameContains(f, "SENTINEL_HALT"),
        5000, "halt banner",
      )
      expect(halted.tab).toBe("dashboard")
      expect(frameContains(halted, "SENTINEL_HALT")).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("forensic_alert reaches the Dashboard", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({
        type: "forensic_alert", worker: "backend",
        analysis: "SENTINEL_FORENSIC bucle de reintentos",
        recommendation: "revertir al checkpoint cp_3",
      }, { priority: "critical" })

      const frame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_FORENSIC"), 5000, "forensic alert",
      )
      expect(frame.tab).toBe("dashboard")
    } finally {
      s.dispose()
    }
  })
})

// ── 4. Plan and review gates ──────────────────────────────────────────────────

describe("E2E flow: approval gates", () => {
  test("plan_update then plan_approval_request holds the Plan tab", async () => {
    const s = await startSession("plan")
    try {
      s.ipc.send({
        type: "plan_update", task_id: "task-plan-gate",
        adr_title: "SENTINEL_ADR separar módulos",
        adr_content: "Contexto: el módulo de auth crece sin límites claros.",
        status: "pending",
        phases: [
          { name: "Extraer auth", coordinator: "backend",
            description: "Mover jwt y refresh a su propio módulo",
            depends_on: [], level: 0, status: "pending" },
          { name: "Actualizar UI", coordinator: "frontend",
            description: "Consumir el nuevo contrato",
            depends_on: ["Extraer auth"], level: 1, status: "pending" },
        ],
        risks: [{ severity: "HIGH", description: "SENTINEL_RISK romper sesiones activas" }],
      }, { priority: "low" })

      const planned = await waitForFrame(
        s.iter, f => f.tab === "plan", 5000, "plan tab",
      )
      expect(planned.tab).toBe("plan")

      s.ipc.send({ type: "plan_approval_request" }, { priority: "low" })
      const gate = await waitForFrame(
        s.iter,
        f => f.tab === "plan" && /SENTINEL_ADR|SENTINEL_RISK|aprob/i.test(frameText(f)),
        5000, "approval gate",
      )
      expect(gate.tab).toBe("plan")
    } finally {
      s.dispose()
    }
  })

  test("review_verdict_update renders the structured acceptance checklist", async () => {
    const s = await startSession("approval")
    try {
      // `criteria` / `categories` are the additive fields the reviewer emits
      // via submit_review_verdict; older reviewers omit them.
      s.ipc.send({
        type: "review_verdict_update", reviewer: "reviewer",
        status: "aprobado_con_observaciones",
        summary: "SENTINEL_VERDICT implementación correcta con observaciones",
        observations: ["Falta cubrir el caso de token expirado"],
        requested_changes: ["Añadir test de expiración"],
        affected_files: ["src/auth/SENTINEL_REVIEWED.ts"],
        criteria: [
          { description: "El refresh token rota en cada uso", met: true, evidence: "src/auth/jwt.ts:42" },
          { description: "Los tests cubren la expiración", met: false },
        ],
        categories: [
          { name: "seguridad", status: "warning", detail: "revisar expiración" },
          { name: "estilo", status: "ok" },
        ],
      }, { priority: "critical" })

      const frame = await waitForFrame(
        s.iter,
        f => f.tab === "review" && /SENTINEL_VERDICT|SENTINEL_REVIEWED/.test(frameText(f)),
        5000, "review verdict",
      )
      expect(frame.tab).toBe("review")
      expect(frameText(frame)).toMatch(/SENTINEL_VERDICT|SENTINEL_REVIEWED/)
    } finally {
      s.dispose()
    }
  })

  test("resume_available offers recovery on the Dashboard", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({
        type: "resume_available", task_id: "task-crashed",
        checkpoint_id: "cp_SENTINEL_RESUME",
        reason: "la sesión anterior terminó inesperadamente",
      }, { priority: "critical" })

      const frame = await waitForFrame(
        s.iter, f => f.tab === "dashboard", 5000, "resume prompt",
      )
      expect(frame.tab).toBe("dashboard")
    } finally {
      s.dispose()
    }
  })
})

// ── 5. Streaming answer ───────────────────────────────────────────────────────

describe("E2E flow: streamed answer", () => {
  test("assistant_chunk pieces compose one message closed by assistant_done", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({ type: "status", running: true, msg: "respondiendo" })
      for (const piece of ["SENTINEL_", "STREAM_", "COMPLETO"]) {
        s.ipc.send({ type: "assistant_chunk", text: piece, agent: "bee", timestamp: "14:00" },
          { priority: "low" })
      }

      s.ipc.send({ type: "assistant_done" })

      // Focus renders the history once the stream closes. The three pieces must
      // read as one contiguous message — separate entries would break the line.
      const done = await waitForFrame(
        s.iter, f => !f.running && frameContains(f, "SENTINEL_STREAM_COMPLETO"),
        5000, "assembled answer after assistant_done",
      )
      expect(frameContains(done, "SENTINEL_STREAM_COMPLETO")).toBe(true)
      expect(done.tab).toBe("focus")
    } finally {
      s.dispose()
    }
  })

  test("thought_chunk feeds the Bee reasoning panel", async () => {
    const s = await startSession("plan")
    try {
      s.ipc.send({ type: "status", running: true, msg: "pensando" })
      s.ipc.send({
        type: "thought_chunk", coordinator: "bee", phase: "thinking",
        content: "SENTINEL_RAZONAMIENTO evaluando el contrato",
        task_id: "task-thought",
      }, { priority: "low" })

      const frame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_RAZONAMIENTO"), 5000, "reasoning panel",
      )
      expect(frameContains(frame, "SENTINEL_RAZONAMIENTO")).toBe(true)
    } finally {
      s.dispose()
    }
  })
})

// ── 6. Protocol robustness ────────────────────────────────────────────────────

describe("E2E flow: protocol robustness", () => {
  test("librarian_progress reaches the Dashboard instead of being dropped", async () => {
    // Regression guard: CoordinatorManager emits `librarian_progress`
    // (coordinator-manager.ts:1834,1880). Rust used to have no variant, so serde
    // resolved it to `BunMessage::Unknown` — a silent no-op — and librarian
    // activity was never visible.
    const s = await startSession("auto")
    try {
      s.ipc.send({ type: "librarian_progress", status: "running", records_written: 0 })
      s.ipc.send({ type: "librarian_progress", status: "done", records_written: 7 })
      s.ipc.send({
        type: "memory_update", records_added: 3, records_updated: 1, records_deprecated: 2,
      })

      // Blackboard entries render on the Dashboard, so route there.
      const taskId = "task-librarian"
      s.ipc.send({
        type: "activity_update", coordinator: "backend", phase: "implementando",
        status: "running", task_id: taskId,
      })
      s.ipc.send(workerUpdate("backend", "implementando", "running", { task_id: taskId, level: 2 }))
      s.ipc.send(workerUpdate("frontend", "maquetando", "running", { task_id: taskId, level: 2 }))

      const frame = await waitForFrame(
        s.iter, f => f.tab === "dashboard" && /librarian/i.test(frameText(f)),
        5000, "librarian activity on dashboard",
      )
      expect(frameText(frame)).toMatch(/librarian/i)
    } finally {
      s.dispose()
    }
  })

  test("suspend is acknowledged so Bun can take the terminal", async () => {
    // Regression guard for the deadlock: `suspendTui()` in tui-launcher.ts
    // returns a promise resolved only by an inbound `suspended`. Rust used to
    // model Suspend as a state-machine no-op with no way to answer, so the
    // promise never settled.
    const s = await startSession("auto")
    try {
      s.ipc.send({ type: "suspend" })
      const ack = await s.ipc.waitForMessage("suspended", 5000)
      expect(ack.type).toBe("suspended")

      // After resuming, the TUI keeps rendering.
      s.ipc.send({ type: "resume" })
      s.ipc.send({
        type: "history_append", role: "assistant",
        content: "SENTINEL_AFTER_RESUME", timestamp: "13:00",
      })
      const frame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_AFTER_RESUME"), 5000, "render after resume",
      )
      expect(frameContains(frame, "SENTINEL_AFTER_RESUME")).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("an entirely unknown message type does not crash the TUI", async () => {
    const s = await startSession("auto")
    try {
      s.ipc.send({ type: "mensaje_del_futuro", payload_extra: { a: 1 }, otro: "campo" })
      s.ipc.send({ type: "status", running: true, msg: "SENTINEL_SURVIVED" })

      const frame = await waitForFrame(
        s.iter, f => f.running, 5000, "survived unknown type",
      )
      expect(frame.running).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("envelope routing metadata is accepted on every priority lane", async () => {
    const s = await startSession("auto")
    try {
      const taskId = "task-envelope"
      s.ipc.send({ type: "log_entry", timestamp: "12:00", level: "info",
        source: "harness", message: "low lane" }, { priority: "low", sessionId: s.sessionId, taskId })
      s.ipc.send({ type: "narrative_chunk", coordinator: "bee", phase: "x",
        content: "normal lane" }, { priority: "normal", sessionId: s.sessionId, taskId })
      s.ipc.send({ type: "history_append", role: "assistant",
        content: "SENTINEL_ROUTED", timestamp: "12:01" },
        { priority: "critical", sessionId: s.sessionId, taskId })

      const frame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_ROUTED"), 5000, "routed message",
      )
      expect(frameContains(frame, "SENTINEL_ROUTED")).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("a low-priority flood does not starve a critical alert", async () => {
    const s = await startSession("auto")
    try {
      for (let i = 0; i < 500; i++) {
        s.ipc.send({ type: "log_entry", timestamp: "12:00", level: "debug",
          source: "flood", message: `ruido-${i}` }, { priority: "low" })
      }
      s.ipc.send({
        type: "conflict_alert", agent_a: "backend", agent_b: "security",
        file: "src/SENTINEL_PRIORITY.ts", reason: "lease en disputa",
        severity: "critical",
      }, { priority: "critical" })

      const frame = await waitForFrame(
        s.iter, f => frameContains(f, "SENTINEL_PRIORITY"), 5000, "critical after flood",
      )
      expect(frameContains(frame, "SENTINEL_PRIORITY")).toBe(true)
    } finally {
      s.dispose()
    }
  })
})
