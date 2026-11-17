/**
 * Contexto sin llamadas al modelo: libro de trabajo derivado de `toolRuns`, historial indexado al guardarse y
 * recuperación por búsqueda. Nada de esto usa un LLM: se comprueba también que no se hace ninguna llamada.
 *
 * Run: bun test tests/compaction/work-ledger.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { col } from "@johpaz/hivecode-core/storage/hive"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { ensureHiveDb } from "@johpaz/hivecode-core/storage/bootstrap"
import { ensureCoreAgentProfiles } from "@johpaz/hivecode-core/agent/agent-profiles"
import { addMessage } from "@johpaz/hivecode-core/agent/conversation-store"
import { compileContext } from "@johpaz/hivecode-core/agent/context-compiler"
import { searchThreadMessages } from "@johpaz/hivecode-core/agent/message-memory"
import { buildWorkLedger, loadWorkLedger, renderWorkLedger } from "@johpaz/hivecode-core/agent/work-ledger"
import type { ToolRunDoc } from "@johpaz/hivecode-core/storage/collections"

let n = 0
function run(over: Partial<ToolRunDoc> & { tool_name: string; args?: Record<string, unknown> }): ToolRunDoc {
  const { args, ...rest } = over
  n++
  return {
    id: `r:${n}`, run_id: "r", task_id: "hilo", call_id: `c${n}`, args_json: JSON.stringify(args ?? {}), result_json: null,
    status: "completed", read_only: false, mutates_workspace: false, mutates_db: false,
    started_at: n, completed_at: n, duration_ms: 1, error: null, ...rest,
  } as ToolRunDoc
}

describe("buildWorkLedger (pura)", () => {
  test("separa lo modificado de lo leído, y no cuenta como leído lo que luego se modificó", () => {
    const l = buildWorkLedger([
      run({ tool_name: "fs_read", args: { path: "src/a.ts" }, read_only: true }),
      run({ tool_name: "fs_read", args: { path: "src/b.ts" }, read_only: true }),
      run({ tool_name: "fs_edit", args: { path: "src/a.ts" }, mutates_workspace: true }),
    ])
    expect(l.changed).toEqual(["src/a.ts"])
    expect(l.read).toEqual(["src/b.ts"])
  })

  test("un intento fallido que luego se repite con éxito no es callejón sin salida; uno que sigue fallando sí", () => {
    const l = buildWorkLedger([
      run({ tool_name: "fs_edit", args: { path: "x.ts", old: "A" }, status: "failed", error: "no se encontró el texto", mutates_workspace: true }),
      run({ tool_name: "fs_edit", args: { path: "x.ts", old: "A" }, mutates_workspace: true }),
      run({ tool_name: "shell_executor", args: { command: "npm test" }, status: "failed", error: "npm: command not found" }),
      run({ tool_name: "shell_executor", args: { command: "npm test" }, status: "failed", error: "npm: command not found" }),
    ])
    expect(l.deadEnds).toHaveLength(1)
    expect(l.deadEnds[0]).toMatchObject({ tool: "shell_executor", target: "npm test", times: 2 })
    expect(l.failures).toBe(3)
  })

  test("de cada comprobación queda el último resultado", () => {
    const l = buildWorkLedger([
      run({ tool_name: "code_test", status: "failed", error: "2 pruebas fallan" }),
      run({ tool_name: "check_types" }),
      run({ tool_name: "code_test" }),
    ])
    expect(l.checks).toEqual([{ tool: "code_test", ok: true }, { tool: "check_types", ok: true }])
  })

  test("ignora llamadas sin terminar, es determinista y tolera argumentos rotos", () => {
    const runs = [
      run({ tool_name: "fs_read", args: { path: "a" }, read_only: true, status: "running" }),
      { ...run({ tool_name: "fs_read", read_only: true }), args_json: "{roto" },
    ]
    expect(buildWorkLedger(runs)).toEqual(buildWorkLedger([...runs].reverse()))
    expect(buildWorkLedger(runs).calls).toBe(1)
  })
})

describe("renderWorkLedger", () => {
  test("vacío si no hay nada, y recorta lo menos importante primero", () => {
    expect(renderWorkLedger(buildWorkLedger([]))).toBe("")
    const many = Array.from({ length: 60 }, (_, i) => run({ tool_name: "fs_read", args: { path: `src/archivo-${i}.ts` }, read_only: true }))
    const l = buildWorkLedger([
      run({ tool_name: "fs_edit", args: { path: "importante.ts" }, status: "failed", error: "falló" , mutates_workspace: true}),
      ...many,
    ])
    const text = renderWorkLedger(l, 400)
    expect(text).toContain("importante.ts")
    expect(text).toContain("falló")
    expect(text.length).toBeLessThan(700)
  })
})

describe("contexto sin modelo", () => {
  const previousDbPath = process.env.HIVE_DB_PATH
  // Sin proveedor, modelo ni clave configurados: si alguna parte necesitara un LLM, estas pruebas fallarían.
  beforeEach(async () => {
    closeHiveDb()
    process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "hivecode-ledger-")), "db")
    await ensureHiveDb()
    await ensureCoreAgentProfiles()
  })
  afterEach(() => closeHiveDb())
  afterAll(() => {
    if (previousDbPath === undefined) delete process.env.HIVE_DB_PATH
    else process.env.HIVE_DB_PATH = previousDbPath
  })

  async function putRuns(threadId: string, runs: ToolRunDoc[]) {
    const toolRuns = await col<ToolRunDoc>("toolRuns")
    for (const r of runs) await toolRuns.put(r.id, { ...r, task_id: threadId })
  }

  test("loadWorkLedger lee solo las llamadas del hilo", async () => {
    await putRuns("hilo-a", [run({ tool_name: "fs_edit", args: { path: "a.ts" }, mutates_workspace: true })])
    await putRuns("hilo-b", [run({ tool_name: "fs_edit", args: { path: "b.ts" }, mutates_workspace: true })])
    expect((await loadWorkLedger("hilo-a")).changed).toEqual(["a.ts"])
  })

  test("al guardar un mensaje queda indexado, sin compactar nada", async () => {
    await addMessage("hilo-i", "user", "El despliegue usa el puerto 8443 en producción", { channel: "webchat" })
    await Bun.sleep(150) // el índice se escribe en segundo plano
    const hits = await searchThreadMessages("hilo-i", "puerto despliegue producción", 3)
    expect(hits.map((h) => h.message.content)).toEqual(["El despliegue usa el puerto 8443 en producción"])
    expect(await searchThreadMessages("otro-hilo", "puerto despliegue producción", 3)).toEqual([])
  })

  test("con el hilo fuera de la ventana el prompt trae el libro y el mensaje antiguo relevante, sin ningún modelo configurado", async () => {
    const thread = "hilo-largo"
    await addMessage(thread, "user", "El despliegue usa el puerto 8443 en producción y no se puede cambiar", { channel: "webchat" })
    for (let i = 1; i < 90; i++) await addMessage(thread, i % 2 ? "assistant" : "user", `mensaje de relleno número ${i} sobre otra cosa`, { channel: "webchat" })
    await Bun.sleep(300)
    await putRuns(thread, [
      run({ tool_name: "fs_edit", args: { path: "src/servidor.ts" }, mutates_workspace: true }),
      run({ tool_name: "code_test", status: "failed", error: "1 prueba falla: puerto" }),
    ])

    const compiled = await compileContext({ agentId: "bee", threadId: thread, userMessage: "¿qué puerto usa el despliegue en producción?", isolated: false })

    expect(compiled.systemPrompt).toContain("LIBRO DE TRABAJO")
    expect(compiled.systemPrompt).toContain("src/servidor.ts")
    expect(compiled.systemPrompt).toContain("code_test ✗")
    expect(compiled.systemPrompt).toContain("MENSAJES ANTERIORES RELEVANTES")
    expect(compiled.systemPrompt).toContain("8443")
    expect(compiled.systemPrompt).toContain("HISTORIAL FUERA DE VENTANA")
    expect(compiled.tools.map((t) => t.function.name)).toContain("conversation_read")
  })

  test("un hilo corto, entero en la ventana, no lleva nada de esto", async () => {
    const thread = "hilo-corto"
    for (let i = 0; i < 6; i++) await addMessage(thread, i % 2 ? "assistant" : "user", `mensaje corto número ${i} de la charla`, { channel: "webchat" })
    await putRuns(thread, [run({ tool_name: "fs_edit", args: { path: "a.ts" }, mutates_workspace: true })])
    const compiled = await compileContext({ agentId: "bee", threadId: thread, userMessage: "continúa con la tarea de antes", isolated: false })
    expect(compiled.systemPrompt).not.toContain("LIBRO DE TRABAJO")
    expect(compiled.systemPrompt).not.toContain("HISTORIAL FUERA DE VENTANA")
    expect(compiled.tools.map((t) => t.function.name)).not.toContain("conversation_read")
  })
})
