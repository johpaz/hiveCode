export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
};

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff delay with equal jitter, for callers that schedule their
 * own retry (a timer, a persisted job) rather than looping in-process. `attempt`
 * is 1-based. Half the computed delay is fixed and half is randomised, so
 * concurrent retries neither thunder together nor fire near-instantly.
 */
export function computeBackoffDelay(attempt: number, options: Partial<RetryOptions> = {}): number {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const exp = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, Math.max(0, attempt - 1));
  const capped = Math.min(exp, opts.maxDelayMs);
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === opts.maxAttempts) {
        break;
      }

      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError ?? new Error("Retry failed");
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: Error) => boolean,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (!shouldRetry(lastError) || attempt === opts.maxAttempts) {
        break;
      }

      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError ?? new Error("Retry failed");
}
