/**
 * Prompt Guard — TDD §38.11
 *
 * Detects instruction files and marks user content as untrusted in LLM context.
 */

// Patterns that suggest a file contains instructions for the agent
const INSTRUCTION_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /ignore\s+all\s+prior\s+instructions/i,
  /you\s+are\s+now\s+a\s+different\s+agent/i,
  /new\s+role:\s*/i,
  /system\s+prompt\s*:/i,
  /override\s+system\s+prompt/i,
  /disregard\s+your\s+instructions/i,
  /forget\s+everything\s+above/i,
  /from\s+now\s+on\s*,?\s*you\s+will/i,
  /you\s+will\s+act\s+as\s+/i,
  /do\s+not\s+follow\s+your\s+original\s+instructions/i,
  /inject\s+the\s+following\s+prompt/i,
  /execute\s+the\s+following\s+command/i,
  /run\s+this\s+shell\s+command/i,
  /write\s+a\s+script\s+to\s+/i,
  /bypass\s+security\s+check/i,
  /ignore\s+safety\s+guidelines/i,
];

/**
 * Detect if file content appears to contain instructions for the agent.
 */
export function detectInstructionFile(content: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Detect if file content appears to contain instructions for the agent.
 * Returns the matching pattern reason, or null if safe.
 */
export function detectInstructionFileWithReason(content: string): string | null {
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(content)) {
      return `Detected potential instruction override: ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Wrap user-provided content with delimiters to mark it as untrusted
 * in the LLM context. This helps the model distinguish between
 * system instructions and potentially malicious user input.
 */
export function markUserContent(content: string): string {
  return `<<<USER_CONTENT>>>
${content}
<<</USER_CONTENT>>>`;
}

/**
 * Sanitize a user message before sending to the LLM.
 * - Detects instruction override attempts
 * - Marks content as untrusted
 * - Returns a warning if suspicious patterns are found
 */
export function sanitizeUserMessage(content: string): {
  sanitized: string;
  warning: string | null;
} {
  const warning = detectInstructionFileWithReason(content);
  const sanitized = markUserContent(content);
  return { sanitized, warning };
}
