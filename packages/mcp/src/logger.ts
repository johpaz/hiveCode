export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogHandler = (level: LogLevel, context: string, message: string, data?: Record<string, unknown>) => void;

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

interface LoggerState { level: LogLevel; handler: LogHandler | null }

export class Logger {
  private context: string;
  private state: LoggerState;

  constructor(context: string, state: LoggerState = { level: "info", handler: null }) {
    this.context = context;
    this.state = state;
  }

  setHandler(handler: LogHandler | null): void {
    this.state.handler = handler;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.state.level]) return;
    if (this.state.handler) {
      this.state.handler(level, this.context, message, data);
      return;
    }

    // Silent by default if no handler is set, to avoid standard console pollution.
    // The consumer (e.g., Hive Agent) should set a handler to bridge these logs.
  }

  debug(message: string, data?: Record<string, unknown>): void { this.log("debug", message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.log("info", message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.log("warn", message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.log("error", message, data); }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`, this.state);
  }

  setLevel(level: LogLevel): void {
    this.state.level = level;
  }
}

export const logger = new Logger("mcp");
