import "../setup/memory-keystore";
import { parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import { beforeAll, afterAll, expect, test } from "bun:test"
import { col } from "../../packages/core/src/storage/hive"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import type { CodeConfigDoc } from "../../packages/core/src/storage/collections"
import { ensureHiveDb } from "../../packages/core/src/storage/bootstrap"
import { storeProviderApiKey } from "../../packages/core/src/storage/crypto"
import { sendSettingsSnapshot } from "../../packages/cli/src/commands-code/tui-launcher"
import { startSession, waitForFrame, frameText } from "../../packages/hivetui/tests/e2e/harness"

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const priorPath = process.env.HIVE_DB_PATH;
beforeAll(() => { closeHiveDb(); process.env.HIVE_DB_PATH = mkdtempSync(join(tmpdir(), "hive-settings-contract-")); });
afterAll(() => { closeHiveDb(); if (priorPath === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = priorPath; });

test("DB-backed settings snapshot is accepted by the real TUI, including seeded skills", async () => {
  await ensureHiveDb()
  await (await col<CodeConfigDoc>("codeConfig")).put("default_provider", {
    key: "default_provider", value: "gemini", updated_at: Date.now(),
  })
  let snapshot: any
  await sendSettingsSnapshot(msg => { snapshot = msg })
  expect(snapshot.providers.some((p: any) => p.id === "gemini" && p.models.length > 0)).toBe(true)
  expect(snapshot.providers.filter((p: any) => p.id !== "gemini").every((p: any) => p.models.length === 0)).toBe(true)
  expect(snapshot.agents.length).toBeGreaterThan(0)
  expect(snapshot.skills.length).toBeGreaterThan(0)
  for (const skill of snapshot.skills) expect(Array.isArray(skill.preferida_por)).toBe(true)
  const session = await startSession("approval", { cols: 130, rows: 40 })
  try {
    session.type("\x1bOQ")
    await session.ipc.waitForMessage("request_settings")
    session.ipc.send(snapshot)
    const frame = await waitForFrame(session.iter, f => frameText(f).toLowerCase().includes("gemini") && !frameText(f).includes("Cargando"), 5000, "providers del snapshot real de la BD")
    expect(frameText(frame)).toContain("Google Gemini")
    session.type("\t")
    const model = snapshot.providers.find((p: any) => p.id === "gemini").models[0]
    const modelsFrame = await waitForFrame(session.iter, f => frameText(f).includes(model), 5000, "modelos de Gemini desde la BD")
    expect(frameText(modelsFrame)).toContain(model)
    expect(frameText(modelsFrame)).toContain("Cambiar modelo")
    session.type("\r")
    const command = await session.ipc.waitForMessage("submit")
    // Only the selected model is shown; Enter opens the provider's picker rather than naming a model.
    expect(command.input).toBe("/modelo set gemini")
    const ctx: ContextState = { sessionId: "test", activeProvider: "gemini", activeModel: "", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: "/tmp" }
    // The picker lists this provider's models and what is picked becomes the session's model.
    await storeProviderApiKey("gemini", "test-key")
    const result = await parseInternalCommand(String(command.input), undefined, ctx, {
      showConfigModal: async (_id: string, _title: string, fields: Array<{ options?: string[] }>) => {
        expect(fields[0].options).toContain(model)
        return { model }
      },
    })
    expect(result.newState?.activeModel).toBe(model)
    expect(result.output).toContain(model)
    expect((await (await col<CodeConfigDoc>("codeConfig")).get("provider_model_gemini"))!.doc.value).toBe(model)
    // The Agents tab reads the same snapshot: choosing the model reaches every agent, and the dead
    // limits are no longer sent.
    let after: any
    await sendSettingsSnapshot(msg => { after = msg })
    expect(after.agents.length).toBe(6)
    expect(after.agents.every((agent: any) => agent.provider === "gemini" && agent.model === model)).toBe(true)
    expect(Object.keys(after.agents[0]).sort()).toEqual(["id", "model", "name", "permission_profile", "provider"])
    await sendSettingsSnapshot(msg => session.ipc.send(msg as any))
    const confirmed = await waitForFrame(session.iter, f => frameText(f).includes(model) && !frameText(f).includes("Cargando"), 5000, "modelo confirmado y visible")
    expect(frameText(confirmed)).toContain(model)

  } finally { session.dispose() }
}, 15000)
