/**
 * E2E tests — mode routing and IPC priority against the real hivetui binary.
 *
 * Sin mocks. Sin stubs. El binario compilado corre de verdad: harness.ts lo
 * spawnea en modo headless, actúa como el lado Bun del contrato IPC y expone
 * los frames del canvas.
 *
 * Cobertura complementaria a tui-flow-e2e.test.ts: aquí van las transiciones de
 * modo (PLAN → APPROVAL → AUTO) y la prioridad del canal; allá el flujo de
 * mensajes de producción.
 *
 * Cómo correr:
 *   cargo build --manifest-path packages/hivetui/Cargo.toml
 *   bun test packages/hivetui/tests/e2e/tui-e2e.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  BINARY, frameContains, startSession, waitForFrame,
  type BunMessage,
} from "./harness.ts"

beforeAll(() => {
  if (!existsSync(BINARY)) {
    throw new Error(
      `Binary not found: ${BINARY}\n` +
      `Run: cargo build --manifest-path packages/hivetui/Cargo.toml`,
    )
  }
})

const STRUCTURED_PLAN = (): BunMessage => ({
  type: "plan_update",
  task_id: `e2e-plan-${Date.now()}`,
  adr_title: "Separacion de modulos por responsabilidad",
  adr_content: Array.from(
    { length: 12 },
    (_, index) => `Contexto ${index + 1}: se revisan limites del layout, dependencias y aprobacion antes de ejecutar cambios.`,
  ).join("\n\n"),
  status: "pending",
  phases: [
    {
      name: "Ajustar layout PLAN",
      coordinator: "frontend",
      description: "Mantener todo el contenido dentro del panel y permitir su revision completa.",
      depends_on: [],
      level: 0,
      status: "pending",
    },
  ],
  risks: [
    {
      severity: "HIGH",
      description: "Una linea sin recorte puede invadir el mapa de archivos.",
    },
  ],
})

// ─────────────────────────────────────────────────────────────────────────────
// IPC PRIORITY — actividad low no debe bloquear alertas críticas
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: prioridad IPC", () => {
  test("una alerta crítica permanece visible después de un flood low-priority", async () => {
    const s = await startSession("auto")
    try {
      for (let i = 0; i < 700; i++) {
        s.ipc.send({
          type: "log_entry",
          timestamp: new Date().toISOString(),
          level: "debug",
          source: "flood",
          message: `low-priority-noise-${i}`,
        }, { priority: "low" })
      }

      s.ipc.send({
        type: "conflict_alert",
        agent_a: "backend",
        agent_b: "security",
        file: "src/critical-route.ts",
        reason: "CRITICAL_SENTINEL_LEASE",
        severity: "critical",
        detail: "priority must win",
      }, { priority: "critical" })

      const frame = await waitForFrame(
        s.iter,
        (f) => frameContains(f, "CRITICAL_SENTINEL_LEASE") || frameContains(f, "critical-route"),
        3000,
        "critical alert after flood",
      )
      expect(frameContains(frame, "CRITICAL_SENTINEL_LEASE") || frameContains(frame, "critical-route")).toBe(true)
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MODO PLAN — Bee analiza, stream de pensamiento visible en Plan tab
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: modo PLAN", () => {
  test("permanece en Focus hasta recibir un plan estructurado y entonces muestra scroll", async () => {
    const s = await startSession("plan")
    try {
      // 1. Init siempre arranca en Focus, aunque el modo sea PLAN.
      expect(s.initFrame.tab).toBe("focus")
      expect(s.initFrame.mode).toBe("plan")

      // 2. StateUpdate mantiene Focus hasta que exista un plan aprobable.
      s.ipc.send({ type: "state_update", new_mode: "plan" })
      const waitingForPlan = await waitForFrame(
        s.iter, (f) => f.mode === "plan" && f.tab === "focus", 5000, "waiting for plan",
      )
      expect(waitingForPlan.tab).toBe("focus")

      // 3. Bee empieza a razonar sin sacar la UI de Focus.
      s.ipc.send({ type: "history_append", role: "user", content: "Revisar el layout de PLAN" })
      s.ipc.send({ type: "status", running: true, msg: "generando plan" })
      await waitForFrame(s.iter, (f) => f.running && f.tab === "focus", 5000, "running on focus")
      s.ipc.send({
        type: "thought_chunk",
        coordinator: "bee",
        phase: "planning",
        content: "Analizando arquitectura del sistema",
      })
      const withThought = await waitForFrame(
        s.iter,
        (f) => frameContains(f, "Anali") || frameContains(f, "RAZON"),
        5000, "thought stream",
      )
      expect(withThought.tab).toBe("focus")

      // 4. Solo un plan estructurado habilita PLAN; el cuerpo largo exige scrollbar.
      s.ipc.send(STRUCTURED_PLAN())
      const withPlan = await waitForFrame(
        s.iter, (f) => f.tab === "plan" && frameContains(f, "Separacion"), 5000, "structured plan",
      )
      expect(withPlan.mode).toBe("plan")
      expect(frameContains(withPlan, "PgUp/PgDn")).toBe(true)
      expect(frameContains(withPlan, "█")).toBe(true)

      // 5. Tras generar un plan válido, se mantiene visible para aprobarlo.
      s.ipc.send({ type: "assistant_done" })
      const done = await waitForFrame(
        s.iter, (f) => f.tab === "plan" && !f.running, 5000, "plan held for approval",
      )
      expect(done.tab).toBe("plan")
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MODO AUTO — Workers en paralelo, Code tab mientras corren, Focus al terminar
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: modo AUTO", () => {
  test("Init(auto) → workers corriendo → Code tab → AssistantDone → Focus tab", async () => {
    // Unix socket: el transporte real en Linux/macOS.
    const s = await startSession("auto", { transport: "unix" })
    try {
      // 1. Status running=true
      s.ipc.send({ type: "status", running: true, msg: "procesando tarea…" })
      await waitForFrame(s.iter, (f) => f.running, 5000, "running")

      // 2. ActivityUpdate → TUI debe ir a Code tab
      s.ipc.send({
        type: "activity_update",
        task_id: "task-auto-1",
        coordinator: "backend",
        phase: "escribiendo archivos",
        status: "running",
      })
      const inCode = await waitForFrame(s.iter, (f) => f.tab === "code", 5000, "code tab")
      expect(inCode.tab).toBe("code")
      expect(inCode.running).toBe(true)

      // 3. 3 Workers activos simultáneos (Bee puede llamar hasta 6)
      for (const [worker, phase] of [
        ["backend",  "src/auth/jwt.ts"],
        ["frontend", "src/components/Login.tsx"],
        ["security", "auditando middleware"],
      ] as const) {
        s.ipc.send({ type: "worker_update", task_id: "task-auto-1", worker, phase, status: "running" })
      }
      const with3Workers = await waitForFrame(s.iter, (f) => f.tab === "dashboard", 5000, "dashboard tab")
      // Dos workers productivos del mismo nivel abren Dashboard.
      expect(frameContains(with3Workers, "⬡") || frameContains(with3Workers, "WORKERS")).toBe(true)

      // 4. Archivo modificado con riesgo HIGH
      s.ipc.send({
        type: "file_risk_update",
        path: "src/auth/jwt.ts",
        risk: "high",
        operation: "create",
        agent: "backend",
      })
      await waitForFrame(
        s.iter, (f) => frameContains(f, "jwt") || frameContains(f, "auth"), 5000, "risky file",
      )

      // 5. Respuesta streaming
      s.ipc.send({ type: "assistant_chunk", text: "He implementado el sistema JWT." })
      s.ipc.send({ type: "assistant_done" })

      // 6. Tarea terminada → debe volver a Focus
      const done = await waitForFrame(
        s.iter, (f) => f.tab === "focus" && !f.running, 5000, "back to focus",
      )
      expect(done.tab).toBe("focus")
      expect(done.running).toBe(false)
      // La respuesta debe aparecer en Focus
      expect(frameContains(done, "JWT") || frameContains(done, "implement")).toBe(true)
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MODO APPROVAL — Dev decide aprobar o rechazar el plan de Bee
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: modo APPROVAL", () => {
  test("StateUpdate(approval) → Review tab con archivos y hints /approve /reject", async () => {
    const s = await startSession("auto", { transport: "unix" })
    try {
      // 1. Bee cambia el modo a APPROVAL (cuando termina el plan y pide decisión)
      s.ipc.send({ type: "state_update", new_mode: "approval" })
      s.ipc.send({
        type: "review_verdict_update",
        reviewer: "reviewer",
        status: "approval",
        summary: "Listo para aprobación",
        observations: [],
        requested_changes: [],
        affected_files: ["src/auth/jwt.ts"],
      })
      const inReview = await waitForFrame(s.iter, (f) => f.tab === "review", 5000, "review tab")
      expect(inReview.tab).toBe("review")
      expect(inReview.mode).toBe("approval")

      // 2. Archivos pendientes de aprobación con distintos niveles de riesgo
      for (const [p, risk] of [
        ["src/auth/jwt.ts",        "high"],
        ["src/auth/middleware.ts", "medium"],
        ["tests/auth.test.ts",     "low"],
      ] as const) {
        s.ipc.send({ type: "file_risk_update", path: p, risk, operation: "create", agent: "backend" })
      }
      const withFiles = await waitForFrame(
        s.iter, (f) => frameContains(f, "jwt") || frameContains(f, "auth"), 5000, "pending files",
      )
      expect(withFiles.tab).toBe("review")

      // 3. El strip de aprobación debe mostrar los hints de acción
      const hasApproveHint = frameContains(withFiles, "approve") || frameContains(withFiles, "APROBAR")
      const hasRejectHint  = frameContains(withFiles, "reject")  || frameContains(withFiles, "RECHAZAR")
      expect(hasApproveHint).toBe(true)
      expect(hasRejectHint).toBe(true)

      // 4. Dev aprueba → modo vuelve a AUTO → AssistantDone → Focus
      s.ipc.send({ type: "state_update", new_mode: "auto" })
      s.ipc.send({ type: "assistant_done" })
      const afterApproval = await waitForFrame(s.iter, (f) => f.tab === "focus", 5000, "focus after approval")
      expect(afterApproval.tab).toBe("focus")
    } finally {
      s.dispose()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO COMPLETO: PLAN → APPROVAL → AUTO (ciclo completo de una tarea)
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: ciclo completo PLAN → APPROVAL → AUTO", () => {
  test("simula el flujo real de una tarea compleja con todos los modos", async () => {
    const s = await startSession("plan", { transport: "unix" })
    try {
      // ── FASE 1: PLAN mode ─────────────────────────────────────────────────
      // Init y state_update mantienen Focus mientras el plan aun no existe.
      expect(s.initFrame.tab).toBe("focus")
      expect(s.initFrame.mode).toBe("plan")

      s.ipc.send({ type: "state_update", new_mode: "plan" })
      await waitForFrame(s.iter, (f) => f.tab === "focus" && f.mode === "plan", 5000, "focus in plan mode")

      // Bee piensa en el plan mientras el usuario permanece en Focus.
      s.ipc.send({ type: "status", running: true, msg: "generando plan" })
      await waitForFrame(s.iter, (f) => f.running && f.tab === "focus", 5000, "thinking on focus")
      for (const content of [
        "Analizando el contexto del proyecto",
        "Identificando dependencias",
        "Diseñando la arquitectura de módulos",
      ]) {
        s.ipc.send({ type: "thought_chunk", coordinator: "bee", phase: "planning", content })
      }
      const focusFrame = await waitForFrame(s.iter, (f) => f.tab === "focus", 5000, "focus with thoughts")
      expect(focusFrame.mode).toBe("plan")

      // Architecture genera ADR, fases y riesgos listos para aprobar.
      s.ipc.send(STRUCTURED_PLAN())
      const planFrame = await waitForFrame(
        s.iter, (f) => f.tab === "plan" && frameContains(f, "Separacion"), 5000, "plan tab",
      )
      expect(planFrame.mode).toBe("plan")
      expect(frameContains(planFrame, "PgUp/PgDn")).toBe(true)

      // ── FASE 2: APPROVAL mode ─────────────────────────────────────────────
      s.ipc.send({ type: "state_update", new_mode: "approval" })
      s.ipc.send({
        type: "review_verdict_update",
        reviewer: "reviewer",
        status: "approval",
        summary: "Plan revisado",
        observations: [],
        requested_changes: [],
        affected_files: ["src/core/module.ts"],
      })
      const approvalFrame = await waitForFrame(s.iter, (f) => f.tab === "review", 5000, "review tab")
      expect(approvalFrame.tab).toBe("review")

      s.ipc.send({ type: "file_risk_update", path: "src/core/module.ts", risk: "high", operation: "create", agent: "backend" })
      s.ipc.send({ type: "file_risk_update", path: "src/core/types.ts",  risk: "low",  operation: "create", agent: "backend" })
      await waitForFrame(
        s.iter, (f) => frameContains(f, "module") || frameContains(f, "types"), 5000, "review files",
      )

      // ── FASE 3: AUTO mode — workers en paralelo ───────────────────────────
      s.ipc.send({ type: "state_update", new_mode: "auto" })
      s.ipc.send({ type: "status", running: true, msg: "ejecutando workers…" })
      s.ipc.send({ type: "activity_update", task_id: "task-full-1", coordinator: "backend", phase: "codificando", status: "running" })

      const codeFrame = await waitForFrame(s.iter, (f) => f.tab === "code", 5000, "code tab")
      expect(codeFrame.tab).toBe("code")
      expect(codeFrame.running).toBe(true)

      // Workers en paralelo
      s.ipc.send({ type: "worker_update", task_id: "task-full-1", worker: "backend",  phase: "module.ts", status: "running" })
      s.ipc.send({ type: "worker_update", task_id: "task-full-1", worker: "test",     phase: "module.test.ts", status: "running" })
      s.ipc.send({ type: "worker_update", task_id: "task-full-1", worker: "devops",   phase: "Dockerfile", status: "running" })

      // Checkpoint de progreso
      s.ipc.send({
        type: "checkpoint_created",
        checkpoint_id: "cp-001",
        description: "Módulos core implementados",
        file_count: 4,
        agent: "backend",
      })

      // Workers terminan
      for (const worker of ["backend", "test", "devops"]) {
        s.ipc.send({ type: "worker_update", task_id: "task-full-1", worker, phase: "completado", status: "done" })
      }

      // Respuesta final
      s.ipc.send({ type: "assistant_chunk", text: "He implementado todos los módulos según el plan." })
      s.ipc.send({ type: "assistant_done" })

      // ── VERIFICACIÓN FINAL ────────────────────────────────────────────────
      const finalFrame = await waitForFrame(
        s.iter, (f) => f.tab === "focus" && !f.running, 5000, "final focus frame",
      )
      expect(finalFrame.tab).toBe("focus")
      expect(finalFrame.running).toBe(false)
      expect(finalFrame.mode).toBe("auto")

      // La respuesta final debe aparecer en Focus
      expect(
        frameContains(finalFrame, "módulos") || frameContains(finalFrame, "implement")
      ).toBe(true)
    } finally {
      s.dispose()
    }
  })
})
