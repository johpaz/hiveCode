/**
 * Log Sanitization — TDD §38.15
 *
 * Redacts sensitive values from log messages to prevent secret leakage.
 */

const LOG_REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED:anthropic-key]" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, replacement: "[REDACTED:github-pat]" },
  { pattern: /ghs_[a-zA-Z0-9]{36}/g, replacement: "[REDACTED:github-secret]" },
  { pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g, replacement: "Bearer [REDACTED:jwt]" },
  { pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, replacement: "[REDACTED:jwt]" },
  { pattern: /"password"\s*:\s*"[^"]+"/gi, replacement: '"password":"[REDACTED]"' },
  { pattern: /"secret"\s*:\s*"[^"]+"/gi, replacement: '"secret":"[REDACTED]"' },
  { pattern: /AIza[0-9A-Za-z-_]{35}/g, replacement: "[REDACTED:google-key]" },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws-key]" },
  { pattern: /sk-[a-zA-Z0-9]{48}/g, replacement: "[REDACTED:openai-key]" },
];

/**
 * Sanitize a string for safe logging.
 * Replaces known secret patterns with [REDACTED] markers.
 */
export function sanitizeForLog(input: string): string {
  let result = input;
  for (const { pattern, replacement } of LOG_REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Sanitize an arbitrary value for logging.
 * - strings: apply pattern redaction
 * - objects: JSON stringify then redact
 * - other: convert to string
 */
export function sanitizeForLogValue(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeForLog(value);
  }
  if (value instanceof Error) {
    return sanitizeForLog(`${value.name}: ${value.message}`);
  }
  try {
    return sanitizeForLog(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}
