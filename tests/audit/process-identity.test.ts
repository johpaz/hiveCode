import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectProcess, writeProcessIdentity, readVerifiedProcess, signalVerifiedProcess, stopVerifiedProcess } from "../../packages/core/src/runtime/process-identity";

test("identity refuses legacy, reused PID and altered executable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-identity-"));
  const file = path.join(dir, "gateway.pid");
  try {
    fs.writeFileSync(file, String(process.pid));
    expect(readVerifiedProcess(file)).toBeNull();
    expect(() => signalVerifiedProcess(file, "SIGTERM")).toThrow("Identidad");
    if (process.platform !== "linux") return;
    writeProcessIdentity(file);
    expect(readVerifiedProcess(file)?.pid).toBe(process.pid);
    const identity = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const field of ["started", "executable", "directory", "instance"]) {
      fs.writeFileSync(file, JSON.stringify({ ...identity, [field]: "altered" }));
      expect(readVerifiedProcess(file)).toBeNull();
    }
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("stops only registered child and waits for exit", async () => {
  if (process.platform !== "linux") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-child-"));
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(inspectProcess(child.pid, dir)).not.toBeNull();
    const file = path.join(dir, "gateway.pid");
    writeProcessIdentity(file, child.pid);
    expect(await stopVerifiedProcess(file)).toBe(true);
    await child.exited;
    expect(fs.existsSync(file)).toBe(false);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true }); }
});
