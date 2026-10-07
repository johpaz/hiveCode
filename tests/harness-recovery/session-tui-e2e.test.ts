/**
 * The real TUI binary, through the real launcher.
 *
 * `session-switch-e2e.test.ts` covers the session logic with the real parser and
 * the real manager. This covers the half nothing else did: the compiled
 * `hivetui` process, the IPC socket Bun opens, the NDJSON envelopes, and the
 * keystrokes in between. Nothing is mocked — the binary starts, deserializes
 * real frames with serde, runs its real reducer and renders through its real
 * Canvas.
 *
 * Needs `cargo build --manifest-path packages/hivetui/Cargo.toml`. It skips with
 * an explicit message when the binary is absent, so a checkout without a Rust
 * toolchain is not a red suite.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeSessionDoc } from "@johpaz/hivecode-core/storage/collections"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { parseInternalCommand, type ContextState } from "@johpaz/hivecode-code/coordinator/command-parser"
import { applySessionSwitch } from "../../packages/cli/src/commands-code/session-commands"
import { launchTui, type TuiCallbacks } from "../../packages/cli/src/commands-code/tui-launcher"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const BIN = path.join(REPO_ROOT, "packages/hivetui/target/debug/hivetui")
const PROJECT = "/tmp/mi-proyecto"

const haveBinary = existsSync(BIN)
const describeIfBinary = haveBinary ? describe : describe.skip

if (!haveBinary) {
  console.warn(`[session-tui-e2e] skipped: ${BIN} not built — cargo build --manifest-path packages/hivetui/Cargo.toml`)
}

const previousHiveDbPath = process.env.HIVE_DB_PATH

type Spawned = { pid: number; stdin?: any; stdout?: any; kill: () => void }
type Frame = { frame: number; rows: string[] }

beforeEach(() => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-tui-e2e-")), "hivedb")
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

/** Drain NDJSON frames off the binary's stdout while it runs. */
async function* readFrames(stdout: any): AsyncGenerator<Frame> {
  if (!stdout || typeof stdout === "number") return
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try { yield JSON.parse(line) as Frame } catch { /* partial line */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already closed */ }
  }
}

/** Wait for a frame whose rendered rows satisfy `predicate`. */
async function waitForFrame(
  frames: AsyncGenerator<Frame>,
  predicate: (frame: Frame) => boolean,
  timeoutMs = 15_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("timed out waiting for a matching frame")

    const step = await Promise.race([
      frames.next(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
    ])
    if (step === "timeout") throw new Error("timed out waiting for a matching frame")
    if (step.done) throw new Error("the TUI exited before the expected frame")
    if (predicate(step.value)) return step.value
  }
}

async function seedSession(message: string, title: string): Promise<string> {
  const scribe = new Scribe()
  const sessionId = scribe.createSession(PROJECT)
  const turnId = scribe.createTurn(sessionId, message)
  scribe.completeTurn(turnId, "respuesta guardada")
  await scribe.flush()
  const sessions = await col<CodeSessionDoc>("codeSessions")
  const row = await sessions.get(sessionId)
  await sessions.put(sessionId, { ...row!.doc, title }, { expectedVersion: row!.version })
  return sessionId
}

/** Boot the real binary through the real launcher, and hand back the handles. */
async function bootTui(
  sessionId: string,
  manager: CoordinatorManager,
  /** A message to push to the real TUI once it is up, e.g. a `resume_available`. */
  push: Record<string, unknown> | null = null,
  /** Stands in for the REPL's resume wiring; records what it was asked to run. */
  onTaskResume: (taskId: string) => void = () => {},
) {
  let spawned: Spawned | null = null
  const callbacks: TuiCallbacks = {
    initialMode: "approval",
    initialProvider: "",
    initialModel: "",
    projectName: "mi-proyecto",
    projectPath: PROJECT,
    sessionId,
    version: "test",
    taskCount: 0,
    tokenCount: 0,
    workers: [],
    onSubmit: async (input) => {
      const result = await parseInternalCommand(
        input,
        undefined,
        {
          sessionId: manager.getSessionId() ?? "none",
          activeProvider: "",
          activeModel: "",
          activeMode: "approval",
          activeMcp: [],
          activeSkills: [],
          projectPath: PROJECT,
        } satisfies ContextState,
      )
      if (result.switchSession) {
        await applySessionSwitch(result.switchSession, {
          manager,
          refreshSession: null,
          defaultProjectPath: PROJECT,
        })
      }
      return { output: result.output ?? "" }
    },
    onExit: () => {},
    onTaskResume: async (taskId: string) => { onTaskResume(taskId) },
    onSpawn: (proc) => { spawned = proc as Spawned },
  }

  // `tuiControl` is the mutable ref launchTui fills in; wrapping `send` lets a
  // test push a message to the real binary exactly the way Bun would.
  const tuiControl = {
    suspend: null, resume: null, showConfigModal: null, showInfoModal: null, refreshSession: null,
    send: null as ((msg: any) => void) | null,
  }

  const finished = launchTui(
    { ...callbacks, tuiControl },
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { HIVETUI_HEADLESS: "1", HIVETUI_COLS: "120", HIVETUI_ROWS: "30" },
    },
  )

  // Wait for the child, then read its frames.
  const deadline = Date.now() + 10_000
  while (!spawned && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  if (!spawned) {
    await finished.catch(() => {})
    throw new Error("the TUI binary never spawned")
  }

  const child = spawned as Spawned
  const frames = readFrames(child.stdout)

  // Let the handshake settle, then push whatever the test wants the TUI to see.
  await new Promise((r) => setTimeout(r, 500))
  if (push) tuiControl.send?.(push)

  return { child, frames, finished }
}

describeIfBinary("the real TUI binary through the real launcher", () => {
  test("boots on the real socket and renders the session's transcript", async () => {
    const sessionId = await seedSession("arregla el login con OAuth", "arregla el login OAuth")
    const manager = new CoordinatorManager()
    manager.switchSession(sessionId, PROJECT)

    const { child, frames, finished } = await bootTui(sessionId, manager)
    try {
      // `ready` → init + snapshot → history_append, all over the real socket,
      // deserialized by the real binary.
      const frame = await waitForFrame(frames, (f) => f.rows.join("\n").includes("arregla el login con OAuth"))
      expect(frame.rows.join("\n")).toContain("arregla el login con OAuth")
    } finally {
      child.kill()
      await finished.catch(() => {})
    }
  }, 40_000)

  test("typing a slash command reaches Bun and its answer comes back", async () => {
    const sessionId = await seedSession("trabajo en curso", "arregla el login OAuth")
    const manager = new CoordinatorManager()
    manager.switchSession(sessionId, PROJECT)

    const { child, frames, finished } = await bootTui(sessionId, manager)
    try {
      await waitForFrame(frames, (f) => f.frame >= 1)

      // Type `/session list` and press Enter: keystroke → binary → socket →
      // onSubmit → parser → answer rendered back on screen.
      await child.stdin.write("/session list\r")

      const frame = await waitForFrame(
        frames,
        (f) => f.rows.join("\n").includes("Sesiones recientes"),
      )
      const text = frame.rows.join("\n")
      expect(text).toContain("Sesiones recientes")
      expect(text).toContain(sessionId.slice(-8))
    } finally {
      child.kill()
      await finished.catch(() => {})
    }
  }, 40_000)

  test("the RESUME badge announces itself and asks for a second Enter", async () => {
    const sessionId = await seedSession("tarea a medias", "arregla el login OAuth")
    const manager = new CoordinatorManager()
    manager.switchSession(sessionId, PROJECT)

    // What boot-time reconciliation sends when a process died mid-task.
    const offered = {
      type: "resume_available",
      task_id: "task-interrumpida",
      checkpoint_id: "cp-1",
      reason: "Interrupted at level 2; 1 phase(s) pending.",
    }

    const { child, frames, finished } = await bootTui(sessionId, manager, offered)
    try {
      await waitForFrame(frames, (f) => f.frame >= 1)

      // The badge must name the key, or it is decoration.
      const offered_frame = await waitForFrame(frames, (f) => f.rows.join("\n").includes("RESUME"))
      expect(offered_frame.rows.join("\n")).toContain("↩ CONTINUAR")

      // One Enter only arms it — a second is required before anything is sent.
      await child.stdin.write("\r")
      const confirming = await waitForFrame(frames, (f) => f.rows.join("\n").includes("CONFIRMAR"))
      expect(confirming.rows.join("\n")).toContain("↩ CONFIRMAR")
      // Still just an offer: the task id has not been sent anywhere.
      expect(confirming.rows.join("\n")).not.toContain("Reanudando tarea")
    } finally {
      child.kill()
      await finished.catch(() => {})
    }
  }, 40_000)

  test("the second Enter actually resumes the task", async () => {
    const sessionId = await seedSession("tarea a medias", "arregla el login OAuth")
    const manager = new CoordinatorManager()
    manager.switchSession(sessionId, PROJECT)

    const resumed: string[] = []
    const offered = {
      type: "resume_available",
      task_id: "task-interrumpida",
      checkpoint_id: "cp-1",
      reason: "Interrupted at level 2",
    }

    const { child, frames, finished } = await bootTui(sessionId, manager, offered, (taskId) => resumed.push(taskId))

    try {
      await waitForFrame(frames, (f) => f.frame >= 1)
      await waitForFrame(frames, (f) => f.rows.join("\n").includes("RESUME"))
      // Arm, then confirm.
      await child.stdin.write("\r")
      await waitForFrame(frames, (f) => f.rows.join("\n").includes("CONFIRMAR"))
      await child.stdin.write("\r")
      // The badge is consumed once acted on.
      const after = await waitForFrame(frames, (f) => !f.rows.join("\n").includes("RESUME ·"))
      expect(after.rows.join("\n")).not.toContain("↩ CONFIRMAR")
      // And the task id travelled the whole way: keystroke → binary → socket →
      // launchTui → the runtime callback.
      expect(resumed).toEqual(["task-interrumpida"])
    } finally {
      child.kill()
      await finished.catch(() => {})
    }
  }, 40_000)
})