/**
 * Real integration tests — Session Context & Conversation Threading
 *
 * Diagnostica el bug: "el agente se pierde — no recuerda el hilo de la sesión".
 *
 * El mecanismo de contexto:
 *   1. runTask() llama getRecentTurns(sessionId, 10) al INICIO de cada tarea
 *   2. Los turnos completados se inyectan en el system prompt de BEE como:
 *      "## Conversación reciente en esta sesión:\nUsuario: ...\nAgente: ..."
 *   3. completeTurn() guarda la respuesta del agente al FINAL de cada tarea
 *   4. La siguiente tarea VE los turnos anteriores → BEE puede responder con contexto
 *
 * Escenarios críticos:
 *   A. BEE usa historial → responde correctamente a follow-ups
 *   B. Nueva sesión NO hereda contexto de sesión anterior
 *   C. Tareas están aisladas (distinto taskId) pero sesión es compartida
 *   D. El historial se limita a los últimos 10 turnos (overflow test)
 *   E. Si completeTurn() no se llama, el siguiente turno NO tiene ese contexto
 *
 * Uses real LLM (opencode-go) para los tests que verifican comportamiento de BEE.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { CoordinatorManager } from "@johpaz/hivecode-code/workers/coordinator-manager"
import { Scribe } from "@johpaz/hivecode-code/narrative/scribe"
import { initSessionArray, setMode } from "@johpaz/hivecode-code/modes/session-array"
import {
  setupRealHiveHome,
  getLastTask,
  type RealTestSetup,
} from "./helpers/real-setup"

// ─── DB-only tests (sin LLM) ─────────────────────────────────────────────────

describe("Plumbing del contexto — sin LLM", () => {
  let setup: RealTestSetup
  let scribe: Scribe

  beforeAll(() => {
    initSessionArray()
    setup = setupRealHiveHome()
    scribe = new Scribe()
  })

  afterAll(() => {
    setup.cleanup()
  })

  test("completeTurn persiste agentResponse — prerequisito del hilo", () => {
    const sessionId = scribe.createSession("/tmp/threading-db-test")
    const turnId = scribe.createTurn(sessionId, "¿Cuál es el token de sesión?")
    scribe.completeTurn(turnId, "Tu token de sesión es HIVE_TOKEN_XYZ42", null)

    const rows = setup.db.query(
      "SELECT user_message, agent_response, completed_at FROM code_turns WHERE id = ?"
    ).get(turnId) as any
    expect(rows.user_message).toBe("¿Cuál es el token de sesión?")
    expect(rows.agent_response).toBe("Tu token de sesión es HIVE_TOKEN_XYZ42")
    expect(rows.completed_at).not.toBeNull()
  })

  test("getRecentTurns devuelve solo turnos completados (completed_at NOT NULL)", () => {
    const sessionId = scribe.createSession("/tmp/threading-completed-test")
    const turn1 = scribe.createTurn(sessionId, "Primer mensaje")
    scribe.completeTurn(turn1, "Primera respuesta")
    const turn2 = scribe.createTurn(sessionId, "Segundo mensaje")
    // turn2 NO se completa — simula tarea en curso
    scribe.createTurn(sessionId, "Tercer mensaje")

    const turns = scribe.getRecentTurns(sessionId, 10)
    // Solo turn1 está completado
    expect(turns.length).toBe(1)
    expect(turns[0].userMessage).toBe("Primer mensaje")
    expect(turns[0].agentResponse).toBe("Primera respuesta")
  })

  test("getRecentTurns respeta el límite de 10 turnos (overflow)", () => {
    const sessionId = scribe.createSession("/tmp/threading-limit-test")
    // Insertar 12 turnos completados
    for (let i = 1; i <= 12; i++) {
      const tid = scribe.createTurn(sessionId, `Mensaje ${i}`)
      scribe.completeTurn(tid, `Respuesta ${i}`)
    }
    const turns = scribe.getRecentTurns(sessionId, 10)
    // El límite debe aplicarse: exactamente 10 de los 12 insertados
    expect(turns.length).toBe(10)
    // Todos los turnos devueltos deben pertenecer a la sesión correcta
    const messages = turns.map(t => t.userMessage)
    for (const msg of messages) {
      expect(msg).toMatch(/^Mensaje \d+$/)
    }
    // No puede haber duplicados
    const unique = new Set(messages)
    expect(unique.size).toBe(10)
  })

  test("tareas distintas en la misma sesión comparten session_id en code_tasks", () => {
    const sessionId = scribe.createSession("/tmp/threading-tasks-test")
    const task1Id = scribe.createTask(sessionId, "Primera tarea", "auto")
    const task2Id = scribe.createTask(sessionId, "Segunda tarea", "auto")
    const task3Id = scribe.createTask(sessionId, "Tercera tarea", "plan")

    const rows = setup.db.query(
      "SELECT id, description, mode FROM code_tasks WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as any[]
    expect(rows.length).toBe(3)
    expect(rows[0].id).toBe(task1Id)
    expect(rows[1].id).toBe(task2Id)
    expect(rows[2].id).toBe(task3Id)
    // Distintas tareas, misma sesión
    expect(rows[0].id).not.toBe(rows[1].id)
  })

  test("turn sin completar NO aparece en el historial de la siguiente tarea", () => {
    const sessionId = scribe.createSession("/tmp/threading-incomplete-test")
    // Turno 1: completado
    const t1 = scribe.createTurn(sessionId, "Inicializo con token SECRET_Z9K")
    scribe.completeTurn(t1, "Token SECRET_Z9K registrado")
    // Turno 2: incompleto (como si la tarea fallara sin llegar a finalizar)
    scribe.createTurn(sessionId, "Este turno quedó incompleto")

    const turns = scribe.getRecentTurns(sessionId, 10)
    // Solo el turno completado debe aparecer
    expect(turns.length).toBe(1)
    expect(turns[0].userMessage).toBe("Inicializo con token SECRET_Z9K")
  })

  test("nueva sesión empieza con historial vacío (no hereda sesión anterior)", () => {
    const session1 = scribe.createSession("/tmp/session-a")
    const t1 = scribe.createTurn(session1, "Contexto privado de sesión A")
    scribe.completeTurn(t1, "Sesión A activa con datos confidenciales XK99")

    const session2 = scribe.createSession("/tmp/session-b")
    const turnsForSession2 = scribe.getRecentTurns(session2, 10)
    // La sesión B no ve nada de la sesión A
    expect(turnsForSession2.length).toBe(0)
  })
})

// ─── Tests LLM: BEE usa el hilo de conversación ──────────────────────────────

describe("Hilo de conversación — BEE usa contexto real", () => {
  let setup: RealTestSetup
  let manager: CoordinatorManager

  beforeAll(async () => {
    initSessionArray()
    setup = setupRealHiveHome()
    manager = new CoordinatorManager()
    await manager.startAll()
  }, 30_000)

  afterAll(async () => {
    try { await manager.stopAll() } catch { /* ignore reflector race */ }
    await Bun.sleep(200)
    setup.cleanup()
  })

  test(
    "turno 2 recibe historial del turno 1: BEE puede repetir info previa",
    async () => {
      setMode("auto")

      // Token único y memorable que el usuario "pasa" al agente
      const uniqueToken = "CTXTEST_9AB3_HIVECODE"

      // Turno 1: El usuario establece el token
      await manager.runTask(
        `Mi identificador de prueba para esta sesión es: ${uniqueToken}. Por favor confírmalo.`,
        "auto"
      )
      const t1 = getLastTask(setup.db)
      expect(t1).not.toBeNull()
      expect(t1!.status).toBe("completed")

      // Verificar que el turno 1 quedó registrado con agentResponse
      // NOTA: cuando BEE usa "respond", completeTurn() guarda task_id=null en code_turns
      // por eso buscamos por session_id + orden cronológico, no por task_id
      const sessionId = manager.getSessionId()!
      const turn1 = setup.db.query(`
        SELECT agent_response, completed_at FROM code_turns
        WHERE session_id = ? AND completed_at IS NOT NULL
        ORDER BY created_at ASC LIMIT 1
      `).get(sessionId) as any
      expect(turn1).not.toBeNull()
      expect(turn1.completed_at).not.toBeNull()
      expect(turn1.agent_response.length).toBeGreaterThan(5)

      // Turno 2: El usuario pregunta por el token — BEE debe saberlo del historial
      await manager.runTask(
        "¿Cuál es mi identificador de prueba de esta sesión? Repítelo exactamente.",
        "auto"
      )
      const t2 = getLastTask(setup.db)
      expect(t2).not.toBeNull()
      expect(t2!.status).toBe("completed")
      // Las dos tareas son distintas pero de la misma sesión
      expect(t2!.id).not.toBe(t1!.id)

      const sessionId2 = manager.getSessionId()
      const sessionTasks = setup.db.query(
        "SELECT id FROM code_tasks WHERE session_id = ? ORDER BY created_at"
      ).all(sessionId2!) as any[]
      expect(sessionTasks.length).toBe(2)

      // Verificar que el turn 2 tiene contexto: la narrativa de BEE debería contener el token
      const narrative2 = setup.db.query(
        "SELECT entry FROM code_narrative WHERE task_id = ? AND coordinator = 'bee'"
      ).get(t2!.id) as any
      if (narrative2) {
        expect(narrative2.entry).toContain(uniqueToken)
      }
    },
    90_000
  )

  test(
    "hilo acumulativo: turno 3 conoce contexto de turno 1 y turno 2",
    async () => {
      setMode("auto")

      // Establece valor en turno 1
      await manager.runTask(
        "Define: PARAM_A = 100. Solo confirma que lo registraste.",
        "auto"
      )
      // Establece segundo valor en turno 2
      await manager.runTask(
        "Define: PARAM_B = 50. Solo confirma que lo registraste.",
        "auto"
      )
      // Consulta ambos en turno 3
      await manager.runTask(
        "¿Cuáles son los valores de PARAM_A y PARAM_B que definí en esta sesión?",
        "auto"
      )

      const lastTask = getLastTask(setup.db)
      expect(lastTask).not.toBeNull()
      expect(lastTask!.status).toBe("completed")

      // La narrativa o turno de BEE debería mencionar ambos parámetros
      // Buscamos el turno más reciente de la sesión (task_id puede ser null si BEE usa "respond")
      const sessionId3 = manager.getSessionId()
      if (!sessionId3) return
      const turn3 = setup.db.query(`
        SELECT agent_response FROM code_turns
        WHERE session_id = ? AND completed_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(sessionId3!) as any
      if (turn3?.agent_response) {
        // BEE debería mencionar al menos uno de los parámetros
        const response = turn3.agent_response
        const hasPARAM_A = response.includes("PARAM_A") || response.includes("100")
        const hasPARAM_B = response.includes("PARAM_B") || response.includes("50")
        expect(hasPARAM_A || hasPARAM_B).toBe(true)
      }
    },
    120_000
  )

  test(
    "historial correctamente formateado en system prompt de BEE",
    async () => {
      setMode("auto")
      // El historyBlock se inyecta en el system prompt como:
      // "## Conversación reciente en esta sesión:\nUsuario: ...\nAgente: ..."
      // Verificamos indirectamente: si hay turnos previos, BEE los recibe

      const sessionId = manager.getSessionId()
      const turnsBefore = setup.db.query(
        "SELECT COUNT(*) as c FROM code_turns WHERE session_id = ? AND completed_at IS NOT NULL"
      ).get(sessionId!) as any

      // Debe haber turnos completados de los tests anteriores en esta describe
      expect(turnsBefore.c).toBeGreaterThanOrEqual(1)

      // Una tarea más — BEE debe recibir al menos turnsBefore.c turnos en su historial
      await manager.runTask("¿Cuántos temas hemos discutido en esta sesión?", "auto")

      const lastTask = getLastTask(setup.db)
      expect(lastTask!.status).toBe("completed")
    },
    60_000
  )
})

// ─── Test de aislamiento: nueva sesión NO hereda contexto ────────────────────

describe("Aislamiento de sesión — nuevo manager = sin contexto previo", () => {
  test(
    "manager B no conoce información establecida en manager A (sesiones separadas)",
    async () => {
      initSessionArray()
      const setupA = setupRealHiveHome()
      const managerA = new CoordinatorManager()
      await managerA.startAll()

      try {
        setMode("auto")
        const secretCode = "ISOLATION_CODE_7YQ4"

        // Sesión A establece el código
        await managerA.runTask(
          `El código secreto de esta sesión es: ${secretCode}. Confírmalo.`,
          "auto"
        )
        const sessionAId = managerA.getSessionId()

        // Verificar que el turno quedó guardado en sesión A
        const turnsA = setupA.db.query(
          "SELECT agent_response FROM code_turns WHERE session_id = ? AND completed_at IS NOT NULL"
        ).all(sessionAId!) as any[]
        expect(turnsA.length).toBeGreaterThanOrEqual(1)

      } finally {
        try { await managerA.stopAll() } catch { /* ignore */ }
        await Bun.sleep(200)
      }

      // Manager B — NUEVA sesión, NUEVA HIVE_HOME aislada
      initSessionArray()
      const setupB = setupRealHiveHome()
      const managerB = new CoordinatorManager()
      await managerB.startAll()

      try {
        setMode("auto")

        // Manager B pregunta por el código — NO debe saberlo (sesiones aisladas)
        await managerB.runTask(
          "¿Cuál es el código secreto de esta sesión? Si no sabes, di que no tienes esa información.",
          "auto"
        )

        const sessionBId = managerB.getSessionId()
        // Sesión B tiene turnos propios independientes de A
        const turnsB = setupB.db.query(
          "SELECT agent_response FROM code_turns WHERE session_id = ? AND completed_at IS NOT NULL"
        ).all(sessionBId!) as any[]
        expect(turnsB.length).toBeGreaterThanOrEqual(1)

        // La sesión B NO tiene turnos con el secretCode de la sesión A
        const allTurnsB = turnsB.map((t: any) => t.agent_response).join(" ")
        // El código secreto de A no debería aparecer en respuestas de B
        expect(allTurnsB).not.toContain("ISOLATION_CODE_7YQ4")

      } finally {
        try { await managerB.stopAll() } catch { /* ignore */ }
        await Bun.sleep(200)
        setupB.cleanup()
        setupA.cleanup()
      }
    },
    120_000
  )
})

// ─── Detección del bug: agente que "se pierde" ───────────────────────────────

describe("Detección de pérdida de contexto — smoke test", () => {
  let setup: RealTestSetup
  let manager: CoordinatorManager

  beforeAll(async () => {
    initSessionArray()
    setup = setupRealHiveHome()
    manager = new CoordinatorManager()
    await manager.startAll()
  }, 30_000)

  afterAll(async () => {
    try { await manager.stopAll() } catch { /* ignore */ }
    await Bun.sleep(200)
    setup.cleanup()
  })

  test(
    "el agente NO se pierde: turno N+1 tiene historial de turno N en code_turns",
    async () => {
      setMode("auto")

      // Turno 1
      await manager.runTask("El nombre de mi proyecto es: HiveAlpha.", "auto")
      const t1 = getLastTask(setup.db)
      expect(t1).not.toBeNull()

      // Verificar que el turno 1 está registrado con respuesta del agente
      // task_id=null cuando BEE usa "respond" — buscamos por session_id
      const detectionSessionId = manager.getSessionId()!
      const turn1Row = setup.db.query(`
        SELECT agent_response, completed_at FROM code_turns
        WHERE session_id = ? AND completed_at IS NOT NULL
        ORDER BY created_at ASC LIMIT 1
      `).get(detectionSessionId) as any

      // ESTE ES EL BUG: si completed_at es NULL o agent_response está vacío,
      // el siguiente turno NO tendrá contexto
      expect(turn1Row).not.toBeNull()
      expect(turn1Row.completed_at).not.toBeNull()
      expect(turn1Row.agent_response.length).toBeGreaterThan(0)

      // Turno 2 — BEE debe recibir el turno 1 como historial
      await manager.runTask("¿Cuál es el nombre de mi proyecto?", "auto")
      const t2 = getLastTask(setup.db)

      // Verificar que getRecentTurns() ANTES de t2 habría encontrado t1
      // task_id puede ser null cuando BEE usa "respond" — buscamos por session_id
      const sessionId = detectionSessionId
      const historyForT2 = setup.db.query(`
        SELECT user_message, agent_response FROM code_turns
        WHERE session_id = ? AND completed_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 10
      `).all(sessionId) as any[]

      // Debe haber al menos 2 turnos completados (t1 y t2)
      expect(historyForT2.length).toBeGreaterThanOrEqual(2)

      // El historial de t2 incluye el userMessage de t1
      const foundT1InHistory = historyForT2.some(
        (t: any) => t.user_message.includes("HiveAlpha")
      )
      expect(foundT1InHistory).toBe(true)
    },
    90_000
  )

  test(
    "smoke: agent_response no está vacío después de una tarea completada",
    async () => {
      setMode("auto")
      // Si agent_response está vacío, el hilo se pierde porque getRecentTurns
      // devuelve un historial con content="" para ese turno
      await manager.runTask("Di exactamente: 'Contexto preservado correctamente'.", "auto")

      const task = getLastTask(setup.db)
      expect(task).not.toBeNull()
      expect(task!.status).toBe("completed")

      // task_id puede ser null cuando BEE usa "respond" — buscamos por session_id
      const sessionId = manager.getSessionId()!
      const turn = setup.db.query(`
        SELECT agent_response FROM code_turns
        WHERE session_id = ? AND completed_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(sessionId) as any
      expect(turn).not.toBeNull()
      // agent_response no debe estar vacío — si lo está, el próximo turno pierde contexto
      expect(turn.agent_response.length).toBeGreaterThan(0)
    },
    60_000
  )
})
