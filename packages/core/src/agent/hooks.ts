import type { Config } from "../config/loader.ts";
import { logger } from "../utils/logger.ts";

export type HookName =
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "before_compaction"
  | "after_compaction"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";

export interface HookContext {
  sessionId?: string;
  agentId?: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

export type HookHandler = (context: HookContext) => Promise<Record<string, unknown> | void>;

export class HookPipeline {
  private config: Config;
  private log = logger.child("hooks");
  private handlers: Map<HookName, HookHandler[]> = new Map();
  private scriptCache: Map<HookName, string> = new Map();

  constructor(config: Config) {
    this.config = config;
    this.loadScripts();
  }

  private loadScripts(): void {
    const scripts = this.config.hooks?.scripts;
    if (!scripts) return;

    const hookNames: HookName[] = [
      "before_model_resolve",
      "before_prompt_build",
      "before_tool_call",
      "after_tool_call",
      "tool_result_persist",
      "before_compaction",
      "after_compaction",
      "message_received",
      "message_sending",
      "message_sent",
      "session_start",
      "session_end",
      "gateway_start",
      "gateway_stop",
    ];

    for (const name of hookNames) {
      const script = scripts[name];
      if (script) {
        this.scriptCache.set(name, script);
        this.log.debug(`Loaded script for hook: ${name}`);
      }
    }
  }

  registerHandler(name: HookName, handler: HookHandler): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
    this.log.debug(`Registered handler for hook: ${name}`);
  }

  unregisterHandler(name: HookName, handler: HookHandler): boolean {
    const handlers = this.handlers.get(name);
    if (!handlers) return false;

    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
      return true;
    }
    return false;
  }

  async execute(name: HookName, context: HookContext): Promise<Record<string, unknown> | void> {
    this.log.debug(`Executing hook: ${name}`, { sessionId: context.sessionId });

    const handlers = this.handlers.get(name) ?? [];
    for (const handler of handlers) {
      try {
        await handler(context);
      } catch (error) {
        this.log.error(`Handler failed for ${name}: ${(error as Error).message}`);
      }
    }

    const script = this.scriptCache.get(name);
    if (script) {
      try {
        const result = await this.executeScript(script, context);
        return result;
      } catch (error) {
        this.log.error(`Script failed for ${name}: ${(error as Error).message}`);
      }
    }
  }

  private async executeScript(
    scriptPath: string,
    context: HookContext
  ): Promise<Record<string, unknown> | void> {
    const payload = JSON.stringify(context);

    const proc = Bun.spawn(["sh", "-c", scriptPath], {
      stdin:  new Response(payload).body ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    if (code === 0 && stdout) {
      try { return JSON.parse(stdout) } catch { return }
    }
    if (stderr) throw new Error(stderr)
  }

  hasHandlers(name: HookName): boolean {
    return (this.handlers.get(name)?.length ?? 0) > 0 || this.scriptCache.has(name);
  }
}

export function createHookPipeline(config: Config): HookPipeline {
  return new HookPipeline(config);
}
