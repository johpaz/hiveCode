import { afterAll, beforeEach, expect, test } from "bun:test";
import { readCoordinatorContext } from "../../packages/cli/src/commands-code/header-context";
import { col } from "../../packages/core/src/storage/hive";
import { isolateHiveDb, restoreDbPath } from "../e2e/helpers";

beforeEach(() => isolateHiveDb());
afterAll(() => restoreDbPath());

async function seed(bee: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const config = await col<any>("codeConfig");
  await config.put("default_provider", { key: "default_provider", value: "deepseek", created_at: now, updated_at: now });
  await config.put("provider_model_deepseek", { key: "provider_model_deepseek", value: "deepseek-chat", created_at: now, updated_at: now });
  await (await col<any>("agents")).put("bee", { id: "bee", name: "BEE", role: "coordinator", agent_type: "bee", enabled: true, ...bee });
}

test("the coordinator shown is the global default unless BEE has its own explicit model", async () => {
  // The harness copies the global default into BEE's doc on every run; that copy is not a choice.
  await seed({ provider_id: "openai", model_id: "gpt-old", model_selection: "inherit" });
  expect(await readCoordinatorContext()).toMatchObject({ provider: "deepseek", model: "deepseek-chat" });
});

test("a legacy BEE doc without model_selection follows the global default too", async () => {
  await seed({ provider_id: "openai", model_id: "gpt-old" });
  expect(await readCoordinatorContext()).toMatchObject({ provider: "deepseek", model: "deepseek-chat" });
});

test("an explicit choice for BEE wins", async () => {
  await seed({ provider_id: "kimi", model_id: "kimi-k2", model_selection: "custom" });
  expect(await readCoordinatorContext()).toMatchObject({ provider: "kimi", model: "kimi-k2" });
});
