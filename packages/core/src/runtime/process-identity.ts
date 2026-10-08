import { readFileSync, readlinkSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";

export interface ProcessIdentity {
  version: 1;
  pid: number;
  executable: string;
  directory: string;
  started: string;
  instance: string;
}

/** Unsupported platforms fail closed: never signal a PID without creation identity. */
export function inspectProcess(pid: number, instance: string): ProcessIdentity | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return {
      version: 1, pid,
      executable: readlinkSync(`/proc/${pid}/exe`),
      directory: readlinkSync(`/proc/${pid}/cwd`),
      started: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`,
      instance: path.resolve(instance),
    };
  } catch { return null; }
}

export function writeProcessIdentity(file: string, pid = process.pid): void {
  const identity = inspectProcess(pid, path.dirname(file));
  if (!identity) throw new Error("No se puede verificar la identidad del proceso en esta plataforma");
  writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
}

export function readVerifiedProcess(file: string): ProcessIdentity | null {
  try {
    const recorded = JSON.parse(readFileSync(file, "utf8")) as ProcessIdentity;
    if (recorded.version !== 1 || recorded.instance !== path.resolve(path.dirname(file))) return null;
    const actual = inspectProcess(recorded.pid, path.dirname(file));
    return actual && actual.executable === recorded.executable && actual.directory === recorded.directory
      && actual.started === recorded.started ? actual : null;
  } catch { return null; }
}

export function signalVerifiedProcess(file: string, signal: NodeJS.Signals): boolean {
  const identity = readVerifiedProcess(file);
  if (!identity) {
    if (existsSync(file)) throw new Error(`Identidad no verificable: ${file}. No se enviaron señales.`);
    return false;
  }
  if (identity.pid === process.pid) throw new Error("No se puede detener el propio proceso desde este comando");
  process.kill(identity.pid, signal);
  return true;
}

export async function stopVerifiedProcess(file: string, timeoutMs = 10_000): Promise<boolean> {
  if (!signalVerifiedProcess(file, "SIGTERM")) return false;
  const deadline = Date.now() + timeoutMs;
  while (readVerifiedProcess(file)) {
    if (Date.now() >= deadline) throw new Error("El proceso no terminó; los datos se conservan");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // The service may remove its own file during shutdown.
  if (existsSync(file)) unlinkSync(file);
  return true;
}
