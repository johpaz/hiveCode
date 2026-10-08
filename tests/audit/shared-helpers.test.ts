import { col } from "../../packages/core/src/storage/hive";
import "../setup/memory-keystore";
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backupIfExists } from "../../packages/core/src/tools/filesystem/backup"
import { getCodeConfig, setCodeConfig } from "../../packages/core/src/storage/code-config"
import { closeHiveDb } from "../../packages/core/src/storage/hivedb"
import { resolveWorkerApiKey } from "../../packages/code/src/workers/secrets"
import { parseInternalCommand, type ContextState } from "../../packages/code/src/coordinator/command-parser"
import packageInfo from "../../package.json"

const root = mkdtempSync(join(tmpdir(), "hive-shared-audit-"))
const previous = process.env.HIVE_DB_PATH
beforeAll(() => { closeHiveDb(); process.env.HIVE_DB_PATH = join(root, "db") })
afterAll(() => { closeHiveDb(); if (previous === undefined) delete process.env.HIVE_DB_PATH; else process.env.HIVE_DB_PATH = previous })
test("configuration helper preserves updates and null clearing", async () => {
 expect(await getCodeConfig("audit")).toBe("")
 await setCodeConfig("audit", "first"); await setCodeConfig("audit", "second")
 expect(await getCodeConfig("audit")).toBe("second")
 await setCodeConfig("audit", null)
 expect(await getCodeConfig("audit")).toBe("")
})
test("shared backup preserves existing content and skips missing files", async () => {
 const log = { debug: () => {}, warn: () => {} }
 const file = join(root, "source.txt")
 expect(await backupIfExists(file, log)).toBeNull()
 await Bun.write(file, "original")
 const backup = await backupIfExists(file, log)
 expect(backup).not.toBeNull()
 await Bun.write(file, "changed")
 expect(await Bun.file(backup!).text()).toBe("original")
})
test("worker credential helper preserves task provider precedence", () => {
 expect(resolveWorkerApiKey("audit-provider", { AUDIT_PROVIDER_API_KEY: "provider-value", LLM_API_KEY: "fallback-value" })).toBe("provider-value")
 expect(() => resolveWorkerApiKey("audit-provider", { LLM_API_KEY: "fallback-value" })).toThrow("No API key")
})
test("slash version agrees with the CLI release version", async () => {
 const ctx: ContextState = { sessionId: "", activeProvider: "", activeModel: "", activeMode: "approval", activeMcp: [], activeSkills: [], projectPath: root }
 expect((await parseInternalCommand("/version", undefined, ctx)).output).toContain(`v${packageInfo.version}`)
})

test("channel configuration is encrypted and shared by runtime readers", async () => {
 const { storeChannelConfig, readChannelConfig } = await import("../../packages/core/src/services/channel-config");
 await storeChannelConfig("default", "telegram", "telegram", { dmPolicy:"allowlist", allowFrom:["test-user"] }, true);
 const row = await (await col<any>("userChannels")).get("default:telegram:telegram");
 expect(row!.doc.config).not.toContain("test-user");
 expect(await readChannelConfig("telegram", "telegram")).toEqual({dmPolicy:"allowlist",allowFrom:["test-user"]});
});
