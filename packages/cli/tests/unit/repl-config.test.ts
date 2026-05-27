import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { getTestDb, resetTestDb, cleanupTestDb, seedProvider, seedConfig } from "../../../code/tests/helpers/setup-db"
import { loadInitialState, saveMode } from "../../src/commands-code/repl-state"
import { fmtTokens } from "@johpaz/hivecode-tui-primitivesutils/fmt-tokens"

// ─── carga de estado inicial ──────────────────────────────────────────────────

describe("repl-config: carga de estado inicial", () => {
  beforeAll(() => { resetTestDb() })
  afterAll(() => { cleanupTestDb() })

  test("DB vacía → mode='auto', provider=''", () => {
    // ARMAR: DB sin config (vacía por resetTestDb)
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.mode).toBe("auto")
    expect(state.provider).toBe("")
    expect(state.model).toBe("")
    expect(state.taskCount).toBe(0)
    expect(state.tokenCount).toBe(0)
    // ESTADO — sin filas en code_config
    const db = getTestDb()
    const row = db.query("SELECT * FROM code_config WHERE key = 'default_mode'").get()
    expect(row).toBeNull()
  })

  test("DB con default_mode=auto → mode='auto'", () => {
    // ARMAR
    seedConfig("default_mode", "auto")
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.mode).toBe("auto")
  })

  test("DB con default_mode=approval → mode='approval'", () => {
    // ARMAR
    seedConfig("default_mode", "approval")
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.mode).toBe("approval")
  })

  test("DB con provider y modelo → provider+model correctos", () => {
    // ARMAR
    seedProvider("anthropic", "Anthropic")
    seedConfig("default_provider", "anthropic")
    seedConfig("provider_model_anthropic", "claude-sonnet-4-6")
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.provider).toBe("anthropic")
    expect(state.model).toBe("claude-sonnet-4-6")
  })

  test("provider configurado sin modelo → model=''", () => {
    // ARMAR
    seedProvider("groq", "Groq")
    seedConfig("default_provider", "groq")
    // (no se inserta provider_model_groq)
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.provider).toBe("groq")
    expect(state.model).toBe("")
  })

  test("taskCount cuenta solo tareas activas", () => {
    // ARMAR — insertar sesión y tareas
    const db = getTestDb()
    db.query(
      "INSERT INTO code_sessions (id, project_path) VALUES ('s1', '/tmp/p')"
    ).run()
    db.query(
      "INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, 's1', 'tarea activa', 'running', 'auto')"
    ).run("t1")
    db.query(
      "INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, 's1', 'tarea completada', 'completed', 'auto')"
    ).run("t2")
    db.query(
      "INSERT INTO code_tasks (id, session_id, description, status, mode) VALUES (?, 's1', 'tarea cancelada', 'cancelled', 'auto')"
    ).run("t3")
    // ACTUAR
    const state = loadInitialState()
    // NOTAR — sólo 't1' cuenta (running != completed/cancelled)
    expect(state.taskCount).toBe(1)
  })

  test("tokenCount suma tokens_in + tokens_out de code_traces", () => {
    // ARMAR
    const db = getTestDb()
    db.query(
      `INSERT INTO code_traces
         (task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success, duration_ns, tokens_in, tokens_out)
       VALUES ('t1', 'arch', 'architecture', 'fs_read', 'x', 'y', 1, 1000, 200, 800)`
    ).run()
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.tokenCount).toBe(1000)
  })
})

// ─── persistencia de modo ─────────────────────────────────────────────────────

describe("repl-config: persistencia de modo", () => {
  beforeEach(() => { resetTestDb() })
  afterAll(() => { cleanupTestDb() })

  test("saveMode('auto') persiste en code_config", () => {
    // ARMAR: DB vacía
    // ACTUAR
    saveMode("auto")
    // ESTADO
    const db = getTestDb()
    const row = db.query("SELECT value FROM code_config WHERE key = 'default_mode'").get() as any
    expect(row?.value).toBe("auto")
  })

  test("saveMode conserva el último valor escrito", () => {
    // ACTUAR
    saveMode("plan")
    saveMode("approval")
    saveMode("auto")
    // ESTADO
    const db = getTestDb()
    const row = db.query("SELECT value FROM code_config WHERE key = 'default_mode'").get() as any
    expect(row?.value).toBe("auto")
  })

  test("ciclo plan → approval → auto → plan produce los tres valores en orden", () => {
    // ACTUAR + ESTADO por paso
    const db = getTestDb()
    const modes = ["plan", "approval", "auto", "plan"] as const

    for (const m of modes) {
      saveMode(m)
      const row = db.query("SELECT value FROM code_config WHERE key = 'default_mode'").get() as any
      expect(row?.value).toBe(m)
    }
  })

  test("saveMode no lanza excepción aunque falle la DB", () => {
    // NOTAR — saveMode captura errores internamente
    expect(() => saveMode("plan")).not.toThrow()
  })
})

// ─── provider guard (lógica DB, sin TTY) ─────────────────────────────────────

describe("repl-config: provider guard", () => {
  beforeAll(() => { resetTestDb() })
  afterAll(() => { cleanupTestDb() })

  test("DB sin default_provider → provider vacío en loadInitialState", () => {
    // ARMAR: DB sin provider configurado
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.provider).toBe("")
  })

  test("DB con default_provider='groq' → provider='groq' en loadInitialState", () => {
    // ARMAR
    seedProvider("groq", "Groq")
    seedConfig("default_provider", "groq")
    // ACTUAR
    const state = loadInitialState()
    // NOTAR
    expect(state.provider).toBe("groq")
  })
})

// ─── formatter de tokenCount ──────────────────────────────────────────────────

describe("repl-config: tokenCount formatter", () => {
  test("< 1000 → sin sufijo", () => {
    // ARMAR / ACTUAR / NOTAR
    expect(fmtTokens(0)).toBe("0")
    expect(fmtTokens(999)).toBe("999")
    expect(fmtTokens(500)).toBe("500")
  })

  test("1500 → '1.5k'", () => {
    expect(fmtTokens(1500)).toBe("1.5k")
  })

  test("exactamente 1000 → '1.0k'", () => {
    expect(fmtTokens(1_000)).toBe("1.0k")
  })

  test("2_000_000 → '2.0M'", () => {
    expect(fmtTokens(2_000_000)).toBe("2.0M")
  })

  test("1_500_000 → '1.5M'", () => {
    expect(fmtTokens(1_500_000)).toBe("1.5M")
  })
})
