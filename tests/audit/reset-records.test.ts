import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("explicit reset rebuilds temporary store and preserves sibling files", async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-reset-"));
 const db = path.join(root, "data", "hivedb");
 const env = { ...process.env, HIVE_HOME: root, HIVE_DB_PATH: db };
 try {
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  fs.writeFileSync(path.join(root, "preserve.txt"), "keep");
  const seed = Bun.spawn([process.execPath, "-e", 'import {getHiveDb} from "./packages/core/src/storage/hivedb"; const db=await getHiveDb(); await db.collection("codeConfig").put("test-marker", {key:"test-marker",value:"remove"}); db.close();'], { env, stdout: "pipe", stderr: "pipe" });
  expect(await seed.exited).toBe(0);
  const reset = Bun.spawn([process.execPath, "packages/cli/src/index.ts", "dev", "reset-records"], { env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(reset.stdout).text();
  const error = await new Response(reset.stderr).text();
  if (await reset.exited !== 0) throw new Error(`Reset failed: ${output}\n${error}`);
  expect(output).toContain(db);
  const check = Bun.spawn([process.execPath, "-e", 'import {getHiveDb} from "./packages/core/src/storage/hivedb"; const db=await getHiveDb(); if(await db.collection("codeConfig").get("test-marker")) process.exit(2); if(await db.collection("providers").count()===0) process.exit(3); db.close();'], { env, stdout: "ignore", stderr: "pipe" });
  expect(await check.exited, await new Response(check.stderr).text()).toBe(0);
  expect(fs.readFileSync(path.join(root, "preserve.txt"), "utf8")).toBe("keep");
  expect(fs.readFileSync(path.join(root, "config.json"), "utf8")).toBe("{}");
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
