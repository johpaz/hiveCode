import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { inspectProcess, type ProcessIdentity } from "./process-identity";

interface Execution { signal: AbortSignal; stopping: Promise<void>[] }
const execution = new AsyncLocalStorage<Execution>();
export async function runWithTaskSignal<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return action();
  const scope: Execution = { signal, stopping: [] };
  try { return await execution.run(scope, action); }
  finally { await Promise.all(scope.stopping); }
}

function descendants(pid: number): ProcessIdentity[] {
  const result: ProcessIdentity[] = [];
  const visit = (parent: number) => {
    try {
      for (const value of readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8").trim().split(/\s+/)) {
        const child = Number(value);
        if (!child) continue;
        const identity = inspectProcess(child, process.cwd());
        if (identity) { visit(child); result.push(identity); }
      }
    } catch { /* The process may already have exited. */ }
  };
  if (process.platform === "linux") visit(pid);
  return result;
}
function alive(identity: ProcessIdentity): boolean {
  const current = inspectProcess(identity.pid, identity.instance);
  return !!current && current.started === identity.started && current.executable === identity.executable;
}
async function stopChildren(children: ProcessIdentity[]): Promise<void> {
  const signal = (kind: NodeJS.Signals) => {
    for (const child of children) if (alive(child)) {
      try { process.kill(child.pid, kind); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 5000;
  while (children.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  signal("SIGKILL");
  const finalDeadline = Date.now() + 1000;
  while (children.some(alive) && Date.now() < finalDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (children.some(alive)) throw new Error("Owned subprocess did not stop");
}

/** Tracks only subprocess handles and descendants created within this tool call. */
export const spawnTaskProcess: typeof Bun.spawn = ((...args: any[]) => {
  const scope = execution.getStore();
  scope?.signal.throwIfAborted();
  const proc = (Bun.spawn as any)(...args);
  if (scope) {
    const abort = () => {
      const children = descendants(proc.pid);
      const owner = inspectProcess(proc.pid, process.cwd());
      if (owner) children.push(owner);
      scope.stopping.push(stopChildren(children));
      if (!owner) { try { proc.kill("SIGTERM"); } catch {} }
    };
    scope.signal.addEventListener("abort", abort, { once: true });
    void proc.exited.finally(() => scope.signal.removeEventListener("abort", abort));
    if (scope.signal.aborted) abort();
  }
  return proc;
}) as typeof Bun.spawn;

export const fetchTaskResource: typeof fetch = ((input: any, init?: RequestInit) => {
  const scope = execution.getStore();
  scope?.signal.throwIfAborted();
  if (!scope) return fetch(input, init);
  const signals = [scope.signal, init?.signal, input instanceof Request ? input.signal : undefined]
    .filter((signal): signal is AbortSignal => !!signal);
  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
}) as typeof fetch;
