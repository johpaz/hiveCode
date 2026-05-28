/**
 * E2E tests — spawna el binario hivetui REAL en modo headless,
 * actúa como servidor IPC real (Unix socket), envía mensajes y
 * verifica los frames renderizados del canvas.
 *
 * Sin mocks. Sin stubs. El binario compilado corre de verdad.
 *
 * Cómo correr:
 *   cargo build --manifest-path packages/hivetui/Cargo.toml
 *   bun test packages/hivetui/tests/e2e/tui-e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, type AddressInfo, type Server } from "node:net"
import { unlinkSync, existsSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// ── Paths ─────────────────────────────────────────────────────────────────────

const BINARY = path.resolve(
  import.meta.dir,
  "../../target/debug/hivetui",
)

// ── Tipos de IPC ──────────────────────────────────────────────────────────────

type BunMessage = Record<string, unknown> & { type: string }
type SendOptions = {
  priority?: "critical" | "normal" | "low"
  sessionId?: string
  taskId?: string
}
type FrameSnapshot = {
  frame: number
  tab: string
  mode: string
  running: boolean
  rows: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Crea un Unix socket server que acepta una conexión y la expone como stream. */
async function createIpcServer(socketPath: string): Promise<{
  server: Server
  waitForConnection: () => Promise<{ send: (msg: BunMessage, options?: SendOptions) => void; close: () => void }>
}> {
  if (existsSync(socketPath)) unlinkSync(socketPath)

  const server = createServer()

  // Esperar a que el socket esté realmente enlazado antes de retornar.
  // server.listen() es async en Node.js — sin este await el binario puede
  // intentar conectarse antes de que el archivo de socket exista.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
    server.listen(socketPath)
  })

  const waitForConnection = () =>
    new Promise<{ send: (msg: BunMessage, options?: SendOptions) => void; close: () => void }>((resolve) => {
      server.once("connection", (socket) => {
        const send = (msg: BunMessage, options: SendOptions = {}) => {
          // El protocolo del IPC usa envelopes: {"priority":"normal","seq":N,"type":"...","payload":{...}}
          const { type, ...payload } = msg
          const envelope = JSON.stringify({
            protocol_version: 1,
            priority: options.priority ?? "normal",
            seq: Date.now(),
            ...(options.sessionId ? { session_id: options.sessionId } : {}),
            ...(options.taskId ? { task_id: options.taskId } : {}),
            type,
            payload,
          })
          socket.write(envelope + "\n")
        }
        const close = () => socket.destroy()
        resolve({ send, close })
      })
    })

  return { server, waitForConnection }
}

/** Crea un servidor TCP local para validar el transporte usado en Windows. */
async function createTcpIpcServer(): Promise<{
  endpoint: string
  server: Server
  waitForConnection: () => Promise<{ send: (msg: BunMessage, options?: SendOptions) => void; close: () => void }>
}> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
    server.listen(0, "127.0.0.1")
  })
  const address = server.address() as AddressInfo

  const waitForConnection = () =>
    new Promise<{ send: (msg: BunMessage, options?: SendOptions) => void; close: () => void }>((resolve) => {
      server.once("connection", (socket) => {
        const send = (msg: BunMessage, options: SendOptions = {}) => {
          const { type, ...payload } = msg
          socket.write(JSON.stringify({
            protocol_version: 1,
            priority: options.priority ?? "normal",
            seq: Date.now(),
            ...(options.sessionId ? { session_id: options.sessionId } : {}),
            ...(options.taskId ? { task_id: options.taskId } : {}),
            type,
            payload,
          }) + "\n")
        }
        resolve({ send, close: () => socket.destroy() })
      })
    })

  return {
    endpoint: `tcp://127.0.0.1:${address.port}`,
    server,
    waitForConnection,
  }
}

/** Spawna hivetui en modo headless y devuelve un iterador de frames. */
async function spawnTui(endpoint: string): Promise<{
  frames: () => AsyncGenerator<FrameSnapshot>
  kill: () => void
}> {
  const proc = Bun.spawn({
    cmd: [BINARY],
    stdout: "pipe",
    stderr: "inherit",  // muestra stderr del binario directamente en el test runner
    env: {
      ...process.env,
      HIVETUI_HEADLESS: "1",
      HIVECODE_IPC: endpoint,
      HIVETUI_COLS: "120",
      HIVETUI_ROWS: "30",
    },
  })

  async function* frames(): AsyncGenerator<FrameSnapshot> {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            yield JSON.parse(line) as FrameSnapshot
          } catch {
            // ignore malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  return { frames, kill: () => proc.kill() }
}

/** Devuelve el siguiente frame que satisface el predicado (timeout real con Promise.race). */
async function waitForFrame(
  iter: AsyncGenerator<FrameSnapshot>,
  predicate: (f: FrameSnapshot) => boolean,
  timeoutMs = 5000,
): Promise<FrameSnapshot> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("waitForFrame: timeout — ningún frame satisface el predicado")),
      timeoutMs,
    )
  })

  try {
    while (true) {
      const result = await Promise.race([
        iter.next(),
        timeoutPromise,
      ])
      if (result.done) break
      if (predicate(result.value)) return result.value
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
  throw new Error("waitForFrame: generador agotado sin frame coincidente")
}

/** True si alguna fila del frame contiene la cadena buscada. */
function frameContains(frame: FrameSnapshot, text: string): boolean {
  return frame.rows.some((row) => row.includes(text))
}

// ── Setup/Teardown ────────────────────────────────────────────────────────────

beforeAll(() => {
  if (!existsSync(BINARY)) {
    throw new Error(
      `Binary not found: ${BINARY}\n` +
      `Run: cargo build --manifest-path packages/hivetui/Cargo.toml`,
    )
  }
})

// ── Mensaje base de Init ──────────────────────────────────────────────────────

const BASE_INIT = (mode: string): BunMessage => ({
  type: "init",
  session_id: `e2e-sess-${mode}-${Date.now()}`,
  workers: ["bee", "backend", "frontend", "security", "test", "devops"],
  mode,
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  project_name: "hiveCode",
  project_path: "/tmp/hiveCode",
  version: "1.0.0",
  task_count: 0,
  token_count: 0,
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
    const { endpoint, server, waitForConnection } = await createTcpIpcServer()
    const { frames, kill } = await spawnTui(endpoint)
    const iter = frames()

    try {
      const ipc = await waitForConnection()
      await iter.next()

      ipc.send(BASE_INIT("auto"))
      await waitForFrame(iter, (f) => f.mode === "auto")

      for (let i = 0; i < 700; i++) {
        ipc.send({
          type: "log_entry",
          timestamp: new Date().toISOString(),
          level: "debug",
          source: "flood",
          message: `low-priority-noise-${i}`,
        }, { priority: "low" })
      }

      ipc.send({
        type: "conflict_alert",
        agent_a: "backend",
        agent_b: "security",
        file: "src/critical-route.ts",
        reason: "CRITICAL_SENTINEL_LEASE",
        severity: "critical",
        detail: "priority must win",
      }, { priority: "critical" })

      const frame = await waitForFrame(
        iter,
        (f) => frameContains(f, "CRITICAL_SENTINEL_LEASE") || frameContains(f, "critical-route"),
        3000,
      )
      expect(frameContains(frame, "CRITICAL_SENTINEL_LEASE") || frameContains(frame, "critical-route")).toBe(true)

      ipc.close()
    } finally {
      kill()
      server.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MODO PLAN — Bee analiza, stream de pensamiento visible en Plan tab
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: modo PLAN", () => {
  test("permanece en Focus hasta recibir un plan estructurado y entonces muestra scroll", async () => {
    const { endpoint, server, waitForConnection } = await createTcpIpcServer()
    const { frames, kill } = await spawnTui(endpoint)
    const iter = frames()

    try {
      const ipc = await waitForConnection()

      // 1. Primer frame: TUI arranca en welcome (state vacío)
      await iter.next() // frame 0

      // 2. Enviar Init en modo PLAN — la TUI siempre arranca en Focus
      ipc.send(BASE_INIT("plan"))
      const afterInit = await waitForFrame(iter, (f) => f.mode === "plan")
      expect(afterInit.tab).toBe("focus")   // Init siempre → Focus
      expect(afterInit.mode).toBe("plan")

      // 3. StateUpdate mantiene Focus hasta que exista un plan aprobable.
      ipc.send({ type: "state_update", new_mode: "plan" })
      const waitingForPlan = await waitForFrame(iter, (f) => f.mode === "plan" && f.tab === "focus")
      expect(waitingForPlan.tab).toBe("focus")

      // 4. Bee empieza a razonar sin sacar la UI de Focus.
      ipc.send({ type: "history_append", role: "user", content: "Revisar el layout de PLAN" })
      ipc.send({ type: "status", running: true, msg: "generando plan" })
      await waitForFrame(iter, (f) => f.running && f.tab === "focus")
      ipc.send({
        type: "thought_chunk",
        coordinator: "bee",
        phase: "planning",
        content: "Analizando arquitectura del sistema",
      })
      const withThought = await waitForFrame(iter, (f) =>
        frameContains(f, "Anali") || frameContains(f, "RAZON")
      )
      expect(withThought.tab).toBe("focus")

      // 5. Solo un plan estructurado habilita PLAN; el cuerpo largo exige scrollbar.
      ipc.send(STRUCTURED_PLAN())
      const withPlan = await waitForFrame(iter, (f) =>
        f.tab === "plan" && frameContains(f, "Separacion")
      )
      expect(withPlan.mode).toBe("plan")
      expect(frameContains(withPlan, "PgUp/PgDn")).toBe(true)
      expect(frameContains(withPlan, "█")).toBe(true)

      // 6. Tras generar un plan válido, se mantiene visible para aprobarlo.
      ipc.send({ type: "assistant_done" })
      const done = await waitForFrame(iter, (f) => f.tab === "plan" && !f.running)
      expect(done.tab).toBe("plan")

      ipc.close()
    } finally {
      kill()
      server.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MODO AUTO — Workers en paralelo, Code tab mientras corren, Focus al terminar
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: modo AUTO", () => {
  test("Init(auto) → workers corriendo → Code tab → AssistantDone → Focus tab", async () => {
    const socketPath = path.join(os.tmpdir(), `hivetui-e2e-auto-${Date.now()}.sock`)
    const { server, waitForConnection } = await createIpcServer(socketPath)
    const { frames, kill } = await spawnTui(socketPath)
    const iter = frames()

    try {
      const ipc = await waitForConnection()
      await iter.next() // frame 0

      // 1. Init en modo AUTO
      ipc.send(BASE_INIT("auto"))
      await waitForFrame(iter, (f) => f.mode === "auto")

      // 2. Status running=true
      ipc.send({ type: "status", running: true, msg: "procesando tarea…" })
      await waitForFrame(iter, (f) => f.running)

      // 3. ActivityUpdate → TUI debe ir a Code tab
      ipc.send({
        type: "activity_update",
        coordinator: "backend",
        phase: "escribiendo archivos",
        status: "running",
      })
      const inCode = await waitForFrame(iter, (f) => f.tab === "code")
      expect(inCode.tab).toBe("code")
      expect(inCode.running).toBe(true)

      // 4. 3 Workers activos simultáneos (Bee puede llamar hasta 6)
      for (const [worker, phase] of [
        ["backend",  "src/auth/jwt.ts"],
        ["frontend", "src/components/Login.tsx"],
        ["security", "auditando middleware"],
      ] as const) {
        ipc.send({ type: "worker_update", worker, phase, status: "running" })
      }
      const with3Workers = await waitForFrame(iter, (f) => f.tab === "code")
      // Con 3+ workers el split es 40/60 — ambos paneles deben tener contenido
      expect(frameContains(with3Workers, "⬡") || frameContains(with3Workers, "WORKERS")).toBe(true)

      // 5. Archivo modificado con riesgo HIGH
      ipc.send({
        type: "file_risk_update",
        path: "src/auth/jwt.ts",
        risk: "high",
        operation: "create",
        agent: "backend",
      })
      await waitForFrame(iter, (f) => frameContains(f, "jwt") || frameContains(f, "auth"))

      // 6. Respuesta streaming
      ipc.send({ type: "assistant_chunk", text: "He implementado el sistema JWT." })
      ipc.send({ type: "assistant_done" })

      // 7. Tarea terminada → debe volver a Focus
      const done = await waitForFrame(iter, (f) => f.tab === "focus" && !f.running)
      expect(done.tab).toBe("focus")
      expect(done.running).toBe(false)
      // La respuesta debe aparecer en Focus
      expect(frameContains(done, "JWT") || frameContains(done, "implement")).toBe(true)

      ipc.close()
    } finally {
      kill()
      server.close()
      if (existsSync(socketPath)) unlinkSync(socketPath)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MODO APPROVAL — Dev decide aprobar o rechazar el plan de Bee
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: modo APPROVAL", () => {
  test("StateUpdate(approval) → Review tab con archivos y hints /approve /reject", async () => {
    const socketPath = path.join(os.tmpdir(), `hivetui-e2e-approval-${Date.now()}.sock`)
    const { server, waitForConnection } = await createIpcServer(socketPath)
    const { frames, kill } = await spawnTui(socketPath)
    const iter = frames()

    try {
      const ipc = await waitForConnection()
      await iter.next() // frame 0

      // 1. Init en AUTO, luego el modo cambia a APPROVAL
      ipc.send(BASE_INIT("auto"))
      await waitForFrame(iter, (f) => f.mode === "auto")

      // 2. Bee cambia el modo a APPROVAL (cuando termina el plan y pide decisión)
      ipc.send({ type: "state_update", new_mode: "approval" })
      const inReview = await waitForFrame(iter, (f) => f.tab === "review")
      expect(inReview.tab).toBe("review")
      expect(inReview.mode).toBe("approval")

      // 3. Archivos pendientes de aprobación con distintos niveles de riesgo
      for (const [p, risk] of [
        ["src/auth/jwt.ts",        "high"],
        ["src/auth/middleware.ts", "medium"],
        ["tests/auth.test.ts",     "low"],
      ] as const) {
        ipc.send({ type: "file_risk_update", path: p, risk, operation: "create", agent: "backend" })
      }
      const withFiles = await waitForFrame(iter, (f) =>
        frameContains(f, "jwt") || frameContains(f, "auth")
      )
      expect(withFiles.tab).toBe("review")

      // 4. El strip de aprobación debe mostrar los hints de acción
      const hasApproveHint = frameContains(withFiles, "approve") || frameContains(withFiles, "APROBAR")
      const hasRejectHint  = frameContains(withFiles, "reject")  || frameContains(withFiles, "RECHAZAR")
      expect(hasApproveHint).toBe(true)
      expect(hasRejectHint).toBe(true)

      // 5. Dev aprueba → modo vuelve a AUTO → AssistantDone → Focus
      ipc.send({ type: "state_update", new_mode: "auto" })
      ipc.send({ type: "assistant_done" })
      const afterApproval = await waitForFrame(iter, (f) => f.tab === "focus")
      expect(afterApproval.tab).toBe("focus")

      ipc.close()
    } finally {
      kill()
      server.close()
      if (existsSync(socketPath)) unlinkSync(socketPath)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FLUJO COMPLETO: PLAN → APPROVAL → AUTO (ciclo completo de una tarea)
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E: ciclo completo PLAN → APPROVAL → AUTO", () => {
  test("simula el flujo real de una tarea compleja con todos los modos", async () => {
    const socketPath = path.join(os.tmpdir(), `hivetui-e2e-full-${Date.now()}.sock`)
    const { server, waitForConnection } = await createIpcServer(socketPath)
    const { frames, kill } = await spawnTui(socketPath)
    const iter = frames()

    try {
      const ipc = await waitForConnection()
      await iter.next()

      // ── FASE 1: PLAN mode ─────────────────────────────────────────────────
      // Init y state_update mantienen Focus mientras el plan aun no existe.
      ipc.send(BASE_INIT("plan"))
      await waitForFrame(iter, (f) => f.tab === "focus" && f.mode === "plan")

      ipc.send({ type: "state_update", new_mode: "plan" })
      await waitForFrame(iter, (f) => f.tab === "focus" && f.mode === "plan")

      // Bee piensa en el plan mientras el usuario permanece en Focus.
      ipc.send({ type: "status", running: true, msg: "generando plan" })
      await waitForFrame(iter, (f) => f.running && f.tab === "focus")
      for (const content of [
        "Analizando el contexto del proyecto",
        "Identificando dependencias",
        "Diseñando la arquitectura de módulos",
      ]) {
        ipc.send({ type: "thought_chunk", coordinator: "bee", phase: "planning", content })
      }
      const focusFrame = await waitForFrame(iter, (f) => f.tab === "focus")
      expect(focusFrame.mode).toBe("plan")

      // Architecture genera ADR, fases y riesgos listos para aprobar.
      ipc.send(STRUCTURED_PLAN())
      const planFrame = await waitForFrame(iter, (f) => f.tab === "plan" && frameContains(f, "Separacion"))
      expect(planFrame.mode).toBe("plan")
      expect(frameContains(planFrame, "PgUp/PgDn")).toBe(true)

      // ── FASE 2: APPROVAL mode ─────────────────────────────────────────────
      ipc.send({ type: "state_update", new_mode: "approval" })
      const approvalFrame = await waitForFrame(iter, (f) => f.tab === "review")
      expect(approvalFrame.tab).toBe("review")

      ipc.send({ type: "file_risk_update", path: "src/core/module.ts", risk: "high", operation: "create", agent: "backend" })
      ipc.send({ type: "file_risk_update", path: "src/core/types.ts",  risk: "low",  operation: "create", agent: "backend" })
      await waitForFrame(iter, (f) => frameContains(f, "module") || frameContains(f, "types"))

      // ── FASE 3: AUTO mode — workers en paralelo ───────────────────────────
      ipc.send({ type: "state_update", new_mode: "auto" })
      ipc.send({ type: "status", running: true, msg: "ejecutando workers…" })
      ipc.send({ type: "activity_update", coordinator: "backend", phase: "codificando", status: "running" })

      const codeFrame = await waitForFrame(iter, (f) => f.tab === "code")
      expect(codeFrame.tab).toBe("code")
      expect(codeFrame.running).toBe(true)

      // Workers en paralelo
      ipc.send({ type: "worker_update", worker: "backend",  phase: "module.ts", status: "running" })
      ipc.send({ type: "worker_update", worker: "test",     phase: "module.test.ts", status: "running" })
      ipc.send({ type: "worker_update", worker: "devops",   phase: "Dockerfile", status: "running" })

      // Checkpoint de progreso
      ipc.send({
        type: "checkpoint_created",
        checkpoint_id: "cp-001",
        description: "Módulos core implementados",
        file_count: 4,
        agent: "backend",
      })

      // Workers terminan
      for (const worker of ["backend", "test", "devops"]) {
        ipc.send({ type: "worker_update", worker, phase: "completado", status: "done" })
      }

      // Respuesta final
      ipc.send({ type: "assistant_chunk", text: "He implementado todos los módulos según el plan." })
      ipc.send({ type: "assistant_done" })

      // ── VERIFICACIÓN FINAL ────────────────────────────────────────────────
      const finalFrame = await waitForFrame(iter, (f) => f.tab === "focus" && !f.running)
      expect(finalFrame.tab).toBe("focus")
      expect(finalFrame.running).toBe(false)
      expect(finalFrame.mode).toBe("auto")

      // La respuesta final debe aparecer en Focus
      expect(
        frameContains(finalFrame, "módulos") || frameContains(finalFrame, "implement")
      ).toBe(true)

      ipc.close()
    } finally {
      kill()
      server.close()
      if (existsSync(socketPath)) unlinkSync(socketPath)
    }
  })
})
