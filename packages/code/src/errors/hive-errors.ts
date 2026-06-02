export type HiveErrorClass = "LLMError" | "NetworkError" | "SystemError" | "TimeoutError"

export abstract class HiveError extends Error {
  abstract readonly errorClass: HiveErrorClass
  readonly originalError?: unknown
  readonly context?: Record<string, unknown>

  constructor(message: string, opts?: { originalError?: unknown; context?: Record<string, unknown> }) {
    super(message)
    this.name = this.constructor.name
    this.originalError = opts?.originalError
    this.context = opts?.context
  }
}

export class LLMError extends HiveError {
  readonly errorClass = "LLMError" as const
  readonly statusCode?: number
  readonly provider?: string

  constructor(message: string, opts?: { statusCode?: number; provider?: string; originalError?: unknown }) {
    super(message, { originalError: opts?.originalError })
    this.statusCode = opts?.statusCode
    this.provider = opts?.provider
  }
}

export class NetworkError extends HiveError {
  readonly errorClass = "NetworkError" as const
}

export class SystemError extends HiveError {
  readonly errorClass = "SystemError" as const
}

export class TimeoutError extends HiveError {
  readonly errorClass = "TimeoutError" as const
  readonly phase?: string
  readonly durationMs?: number

  constructor(message: string, opts?: { phase?: string; durationMs?: number; originalError?: unknown }) {
    super(message, { originalError: opts?.originalError, context: opts?.phase ? { phase: opts.phase } : undefined })
    this.phase = opts?.phase
    this.durationMs = opts?.durationMs
  }
}
