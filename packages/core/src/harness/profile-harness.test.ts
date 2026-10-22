import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeHiveDb } from "../storage/hivedb.ts"
import { col } from "../storage/hive.ts"
import { ensureHiveDb } from "../storage/bootstrap.ts"
import type { AgentDoc } from "../storage/collections.ts"
import { HIVEAGENTS_MODEL_ID } from "../agent/llm-providers/hiveagents.ts"
import { DEFAULT_MAX_HARNESS_STEPS, ProfileHarness, SCOPED_REASONING, type ProfileRunner } from "./profile-harness.ts"

const previousHiveDbPath = process.env.HIVE_DB_PATH

beforeEach(async () => {
  closeHiveDb()
  process.env.HIVE_DB_PATH = path.join(
    mkdtempSync(path.join(tmpdir(), "hivecode-profile-harness-")),
    "hivedb",
  )
  await ensureHiveDb()
})

afterAll(() => {
  closeHiveDb()
  if (previousHiveDbPath === undefined) delete process.env.HIVE_DB_PATH
  else process.env.HIVE_DB_PATH = previousHiveDbPath
})

describe("profile harness task routing", () => {
  test("uses the provider selected for the task and forwards live steps", async () => {
    const events: Array<{
      type: string
      agent?: string
      phase?: string
      toolName?: string
      message: string
    }> = []
    const runner: ProfileRunner = async options => {
      expect(options.maxSteps).toBe(DEFAULT_MAX_HARNESS_STEPS)
      await options.onStep?.({
        type: "tool_call",
        toolName: "web_search",
        message: "Executing: `web_search`",
      })
      return "respuesta lista"
    }

    const result = await new ProfileHarness(runner).run({
      objective: "hola",
      sessionId: "session-test",
      workspace: "/workspace/test",
      provider: "hiveagents",
      model: HIVEAGENTS_MODEL_ID,
      onEvent: event => events.push(event),
    })

    expect(result.response).toBe("respuesta lista")
    expect(events).toContainEqual({
      type: "agent_progress",
      agent: "bee",
      phase: "tool_call",
      toolName: "web_search",
      message: "Executing: `web_search`",
    })

    const bee = (await (await col<AgentDoc>("agents")).get("bee"))?.doc
    expect(bee?.provider_id).toBe("hiveagents")
    expect(bee?.model_id).toBe(HIVEAGENTS_MODEL_ID)
  })
})

describe("approval gate", () => {
  // "migración" dispara complexity=complex → pasa por planning y llega al gate.
  const COMPLEX_OBJECTIVE = "planifica la migración de arquitectura del módulo de auth"
  const planningRunner: ProfileRunner = async () => "Plan listo.\nFEATURE_DIR: specs/001-auth"

  test("waits for the user instead of cancelling when no approver is wired", async () => {
    // El recovery scheduler reencola con manager.runTask(task, mode) sin approver.
    // Tratar 'nadie puede responder' como 'rechazado' descartaba el trabajo en silencio.
    const result = await new ProfileHarness(planningRunner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-approval",
      workspace: "/workspace/test",
      policy: "approval",
    })

    expect(result.status).toBe("waiting_user")
  })

  test("cancels when the user actually rejects", async () => {
    const result = await new ProfileHarness(planningRunner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-approval-reject",
      workspace: "/workspace/test",
      policy: "approval",
      approve: async () => "cancel",
    })

    expect(result.status).toBe("cancelled")
  })
})

describe("BEE-led execution", () => {
  const COMPLEX_OBJECTIVE = "planifica la migración de arquitectura del módulo de auth"

  function scripted(outputs: string[]) {
    const calls: Array<{ agentId: string; task: string; approvedExecution?: boolean }> = []
    const runner: ProfileRunner = async options => {
      calls.push({ agentId: options.agentId, task: options.taskDescription, approvedExecution: options.approvedExecution })
      return outputs[calls.length - 1] ?? "ok"
    }
    return { calls, runner }
  }

  test("plans through the planner, executes under BEE with approval, converges", async () => {
    const { calls, runner } = scripted([
      "Plan listo.\nFEATURE_DIR: specs/001-auth",
      "Hecho en paralelo.\nVERDICT: PASS",
      "Convergido.",
    ])
    const result = await new ProfileHarness(runner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-bee-led",
      workspace: "/workspace/test",
      policy: "auto",
    })

    expect(result).toMatchObject({ status: "completed", featureDir: "specs/001-auth", repairCycles: 0 })
    // Only BEE is invoked by the harness: workers are BEE's to delegate to.
    expect(calls.map(call => call.agentId)).toEqual(["bee", "bee", "bee"])
    expect(calls[0]!.task).toContain('worker_id="planner"')
    expect(calls[1]!.task).toContain("EN EL MISMO PASO")
    expect(calls[1]!.approvedExecution).toBe(true)
  })

  test("sends a failed quality gate back through a repair cycle", async () => {
    const { calls, runner } = scripted([
      "FEATURE_DIR: specs/002-auth",
      "Falló.\nVERDICT: FAIL",
      "Reparado.\nVERDICT: PASS",
      "Convergido.",
    ])
    const result = await new ProfileHarness(runner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-repair",
      workspace: "/workspace/test",
      policy: "auto",
    })

    expect(result).toMatchObject({ status: "completed", repairCycles: 1 })
    expect(calls[2]!.task).toContain("Ciclo de reparación 1/")
    expect(calls[2]!.task).toContain("VERDICT: FAIL")
  })

  test("fails when the quality gate never converges", async () => {
    const { runner } = scripted(["FEATURE_DIR: specs/003-auth", ...Array(6).fill("VERDICT: FAIL")])
    await expect(new ProfileHarness(runner).run({
      objective: COMPLEX_OBJECTIVE,
      sessionId: "session-no-converge",
      workspace: "/workspace/test",
      policy: "auto",
    })).rejects.toThrow("did not converge")
  })

  test("a small change is done directly by BEE, without Spec Kit or a mandatory delegation", async () => {
    const { calls, runner } = scripted(["Cambio aplicado."])
    const result = await new ProfileHarness(runner).run({
      objective: "corrige el typo en el README",
      sessionId: "session-simple",
      workspace: "/workspace/test",
    })
    expect(result.complexity).toBe("simple_change")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentId).toBe("bee")
    expect(calls[0]!.task).toContain("Hazlo tú directamente")
    expect(calls[0]!.task).not.toContain("en el PRIMER paso")
    expect(calls[0]!.task).toContain("no inicies Spec Kit")
  })

  test("the harness decides how hard a scoped change thinks: low, not the TUI effort", async () => {
    const { calls, runner } = scripted(["listo"])
    const seen: unknown[] = []
    const spy: ProfileRunner = async options => { seen.push(options.reasoning); return runner(options) }
    await new ProfileHarness(spy).run({ objective: "corrige el typo en el README", sessionId: "session-reasoning", workspace: "/workspace/test" })
    expect(calls).toHaveLength(1)
    expect(seen[0]).toEqual(SCOPED_REASONING)
    expect(SCOPED_REASONING).toEqual({ base: "low", onFailure: "medium" })
  })

  test("a request to review and plan reaches BEE with the order of work: bounded scouts, then the planner", async () => {
    const { calls, runner } = scripted(["ok"])
    await new ProfileHarness(runner).run({ objective: "Hola revisa el proyecto y planea meejoras que encuentres", sessionId: "session-plan", workspace: "/workspace/test" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.task).toContain("tantos scouts como módulos")
    expect(calls[0]!.task).toContain('delega en el worker "planner"')
    expect(calls[0]!.task).toContain("Lee con el índice de HiveDB") // and still reads through the index
  })

  test("a conversation leaves the policy to the profile", async () => {
    const seen: unknown[] = []
    const runner: ProfileRunner = async options => { seen.push(options.reasoning); return "hola" }
    await new ProfileHarness(runner).run({ objective: "hola", sessionId: "session-conv", workspace: "/workspace/test" })
    expect(seen[0]).toBeUndefined()
  })

  test("the scoped prompt carries the project facts, so BEE does not spend turns finding them out", async () => {
    const { mkdtempSync: mk, writeFileSync: write } = await import("node:fs")
    const ws = mk(path.join(tmpdir(), "hive-facts-"))
    write(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    write(path.join(ws, "bun.lock"), "")
    const { calls, runner } = scripted(["listo"])
    await new ProfileHarness(runner).run({ objective: "corrige el typo en el README", sessionId: "session-facts", workspace: ws })
    expect(calls[0]!.task).toContain("gestor de paquetes: bun")
    expect(calls[0]!.task).toContain("bun run test")
  })
})

describe("reading tasks", () => {
  test("auditing code without mutating gets DB-first guidance", async () => {
    const tasks: string[] = []
    const runner: ProfileRunner = async options => { tasks.push(options.taskDescription); return "informe" }
    const objective = "Audita packages/code/src y packages/cli/src: mapea workspaces, workers y checkpoints"
    const result = await new ProfileHarness(runner).run({ objective, sessionId: "session-read", workspace: "/workspace/test" })
    expect(result.route).toBe("conversation")
    expect(result.routeSignals).toContain("pide leer o auditar el código")
    expect(tasks[0]).toContain("get_project_context")
    expect(tasks[0]).toContain(objective)
  })
})

describe("specificationEvidence", () => {
  test("incluye los artefactos del plan, no sólo el resumen de BEE", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { specificationEvidence } = await import("./profile-harness.ts")
    const ws = mkdtempSync(join(tmpdir(), "hive-evidence-"))
    mkdirSync(join(ws, "specs", "001-x"), { recursive: true })
    writeFileSync(join(ws, "specs", "001-x", "tasks.md"), "- [ ] T001 [builder] hacer algo")
    writeFileSync(join(ws, "specs", "001-x", "plan.md"), "x".repeat(5_000))

    const text = await specificationEvidence(ws, "specs/001-x", "resumen")
    expect(text).toContain("resumen")
    expect(text).toContain("T001 [builder] hacer algo")
    expect(text).toContain("specs/001-x/plan.md")
    expect(text).not.toContain("x".repeat(3_500)) // recortado
  })

  test("sin artefactos devuelve el resumen", async () => {
    const { specificationEvidence } = await import("./profile-harness.ts")
    expect(await specificationEvidence("/nonexistent", "specs/none", "solo resumen")).toBe("solo resumen")
  })
})

describe("approving a plan made in plan mode", () => {
  const OBJECTIVE = "planifica la migración de arquitectura del módulo de auth"

  async function workspaceWithPlan() {
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const ws = mkdtempSync(path.join(tmpdir(), "hive-reuse-plan-"))
    mkdirSync(path.join(ws, "specs", "001-auth"), { recursive: true })
    writeFileSync(path.join(ws, "specs", "001-auth", "tasks.md"), "- [ ] T001 [builder] algo")
    return ws
  }

  function recording(handler?: (task: string) => string) {
    const prompts: string[] = []
    const runner: ProfileRunner = async options => {
      prompts.push(options.taskDescription)
      return handler?.(options.taskDescription) ?? "ok"
    }
    return { prompts, runner }
  }

  test("executes the plan that was already made instead of planning again", async () => {
    const ws = await workspaceWithPlan()
    const planning = recording(task => task.includes("delega el plan") ? "Plan listo.\nFEATURE_DIR: specs/001-auth" : "ok")
    const planned = await new ProfileHarness(planning.runner).run({
      objective: OBJECTIVE, sessionId: "s-reuse", workspace: ws, policy: "plan",
    })
    expect(planned.status).toBe("ready")
    expect(planned.featureDir).toBe("specs/001-auth")
    expect(planning.prompts.filter(p => p.includes("delega el plan"))).toHaveLength(1)

    const executing = recording(task => task.includes("Consolida") ? "listo" : "VERDICT: PASS")
    const done = await new ProfileHarness(executing.runner).run({
      objective: OBJECTIVE, sessionId: "s-reuse", workspace: ws, policy: "auto", resumeTaskId: planned.taskId,
    })

    expect(done.status).toBe("completed")
    expect(done.taskId).toBe(planned.taskId)
    // Ni una sola llamada de planificación en la segunda corrida.
    expect(executing.prompts.some(p => p.includes("delega el plan"))).toBe(false)
    expect(executing.prompts.some(p => p.includes("Ejecuta el plan de specs/001-auth"))).toBe(true)
  })

  test("plans again when the plan's artifacts are no longer in the workspace", async () => {
    const ws = await workspaceWithPlan()
    const planning = recording(task => task.includes("delega el plan") ? "Plan listo.\nFEATURE_DIR: specs/001-auth" : "ok")
    const planned = await new ProfileHarness(planning.runner).run({
      objective: OBJECTIVE, sessionId: "s-reuse-missing", workspace: ws, policy: "plan",
    })

    // Otro workspace, sin specs/: el plan no se puede reutilizar.
    const elsewhere = mkdtempSync(path.join(tmpdir(), "hive-reuse-elsewhere-"))
    const executing = recording(task => task.includes("delega el plan") ? "Plan nuevo.\nFEATURE_DIR: specs/001-auth" : "VERDICT: PASS")
    await new ProfileHarness(executing.runner).run({
      objective: OBJECTIVE, sessionId: "s-reuse-missing", workspace: elsewhere, policy: "auto", resumeTaskId: planned.taskId,
    })

    expect(executing.prompts.some(p => p.includes("delega el plan"))).toBe(true)
  })
})

describe("a blocked worker is announced", () => {
  test("agent_blocked reaches the listener with the reason", async () => {
    const events: Array<{ type: string; agent?: string; message: string }> = []
    const runner: ProfileRunner = async options => {
      await options.onStep?.({ type: "blocked", message: "repitió la misma llamada (shell_executor) sin avanzar" })
      return "entrega parcial"
    }
    await new ProfileHarness(runner).run({
      objective: "hola", sessionId: "s-blocked-1", workspace: "/workspace/test",
      onEvent: event => events.push(event),
    })
    expect(events).toContainEqual({ type: "agent_blocked", agent: "bee", message: "repitió la misma llamada (shell_executor) sin avanzar" })
  })

  test("BEE blocked with nothing to show fails the task instead of carrying on", async () => {
    const runner: ProfileRunner = async options => {
      await options.onStep?.({ type: "blocked", message: "el modelo devolvió respuestas vacías y no pudo continuar" })
      return ""
    }
    const events: Array<{ type: string; message: string }> = []
    await expect(new ProfileHarness(runner).run({
      objective: "hola", sessionId: "s-blocked-2", workspace: "/workspace/test",
      onEvent: event => events.push(event),
    })).rejects.toThrow(/BEE quedó bloqueado: el modelo devolvió respuestas vacías/)
    expect(events.some(event => event.type === "agent_failed")).toBe(true)
  })

  test("a worker blocked but with something to hand over does not fail the task", async () => {
    const runner: ProfileRunner = async options => {
      await options.onStep?.({ type: "blocked", message: "agotó sus 40 pasos sin terminar" })
      return "esto es lo que logré"
    }
    const result = await new ProfileHarness(runner).run({ objective: "hola", sessionId: "s-blocked-3", workspace: "/workspace/test" })
    expect(result.response).toBe("esto es lo que logré")
  })
})
