/**
 * How what reaches the model is written: as text.
 *
 * This replaces the TOON encoder. TOON removes the key names from lists of uniform objects, but what weighs in a
 * coding agent's context is text carried inside values (source, command output, search matches), and an encoder that
 * quotes strings turns every quote into `\"` and every line break into `\n`. Measured on real answers it saved 0-15 %
 * where text-first rendering (tool-render.ts) saved 40-47 %. So: tools whose answer is text have their own renderer,
 * and everything else is written by `renderText` below, which never escapes and never quotes a multi-line value.
 */
import { renderToolResult } from "./tool-render"

/** Rough token count, 4 characters per token. The harness budgets use `budgetTokens` (3.5); this one is for logs and tests. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

const MAX_DEPTH = 6
const EMPTY = "(vacío)"
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Error)
const isScalar = (v: unknown): boolean => v === null || ["string", "number", "boolean", "bigint"].includes(typeof v) || v instanceof Date
const scalar = (v: unknown): string => (v instanceof Date ? v.toISOString() : v === null ? "null" : String(v))
const oneLine = (v: unknown): boolean => isScalar(v) && !scalar(v).includes("\n")

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return text.split("\n").map(line => (line ? pad + line : line)).join("\n")
}

function renderValue(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (isScalar(value)) return scalar(value)
  if (value === undefined || typeof value === "function") return ""
  if (value instanceof Error) return value.message
  if (typeof value !== "object") return String(value)
  if (seen.has(value as object)) return "[circular]"
  if (depth >= MAX_DEPTH) return "[…]"
  seen.add(value as object)
  try {
    if (Array.isArray(value)) {
      if (!value.length) return EMPTY
      if (value.every(oneLine)) return value.map(scalar).join(", ")
      // YAML style: the item starts on the dash's line and its other lines are indented under it.
      return value.map(item => {
        const [first, ...rest] = renderValue(item, depth + 1, seen).split("\n")
        return `- ${first}${rest.length ? `\n${indent(rest.join("\n"), 2)}` : ""}`
      }).join("\n")
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && typeof v !== "function")
    if (!entries.length) return EMPTY
    // A flat record of short values reads best on one line per key; anything longer gets its own block.
    return entries.map(([key, v]) => {
      if (oneLine(v)) return `${key}: ${scalar(v)}`
      const text = renderValue(v, depth + 1, seen)
      if (text === EMPTY || (Array.isArray(v) && v.every(oneLine) && !text.includes("\n"))) return `${key}: ${text}`
      return text.includes("\n") || isPlain(v) || Array.isArray(v) ? `${key}:\n${indent(text, 2)}` : `${key}: ${text}`
    }).join("\n")
  } finally {
    seen.delete(value as object)
  }
}

/** Any value as readable text: `key: value` lines, real line breaks, no quoting and no escapes. */
export function renderText(value: unknown): string {
  return renderValue(value, 0, new WeakSet())
}

/** A tool's answer for the model: its own text rendering where it has one, `renderText` otherwise. */
export function formatToolResult(data: unknown, tool?: { name: string; root?: string | null }): string {
  if (typeof data === "string") return data
  const text = tool ? renderToolResult(tool.name, data, { root: tool.root }) : undefined
  return text ?? renderText(data)
}

/** Context data (notes, user data) for the system prompt. */
export function formatContext(data: unknown): string {
  return typeof data === "string" ? data : renderText(data)
}
