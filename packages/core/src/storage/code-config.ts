import { col } from "./hive";
import type { CodeConfigDoc } from "./collections";

export async function getCodeConfig(key: string): Promise<string> {
  return (await (await col<CodeConfigDoc>("codeConfig")).get(key))?.doc.value ?? "";
}

export async function setCodeConfig(key: string, value: string | null): Promise<void> {
  const codeConfig = await col<CodeConfigDoc>("codeConfig");
  const existing = await codeConfig.get(key);
  await codeConfig.put(key, { key, value, updated_at: Date.now() }, { expectedVersion: existing?.version ?? 0 });
}
