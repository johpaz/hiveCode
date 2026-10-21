/**
 * Model output → Telegram HTML.
 *
 * Telegram's HTML parser is strict: an unbalanced tag, a raw `<` or a message over 4096 characters
 * is a 400 and the reply is lost. The converter therefore (1) escapes everything first, (2) turns the
 * Markdown models write into the few tags Telegram accepts, and (3) checks the result is balanced,
 * falling back to plain escaped text when it is not. Chunks are cut on the raw text, below the limit
 * with room for the tags, and a code fence cut in two is closed and reopened.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const TAG = /<(\/?)(b|i|s|u|code|pre|a)(?:\s[^>]*)?>/g

/** True when every opening tag is closed in order. */
export function isBalancedHtml(html: string): boolean {
  const stack: string[] = []
  for (const match of html.matchAll(TAG)) {
    const [, closing, name] = match
    if (!closing) stack.push(name)
    else if (stack.pop() !== name) return false
  }
  return stack.length === 0
}

function tableToPre(text: string, hold: (html: string) => string): string {
  const lines = text.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length;) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) { out.push(lines[i++]); continue }
    const rows: string[] = []
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++])
    const body = rows.filter(row => !/^\s*\|[\s:|-]+\|\s*$/.test(row)).map(row => row.trim())
    out.push(hold(`<pre>${escapeHtml(body.join("\n"))}</pre>`))
  }
  return out.join("\n")
}

export function markdownToTelegramHtml(text: string): string {
  const held: string[] = []
  const hold = (html: string) => `\u0000H${held.push(html) - 1}\u0000`

  let out = text
    .replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, (_m, code: string) => hold(`<pre><code>${escapeHtml(code.trim())}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`))
  out = tableToPre(out, hold)

  // Links are held too: their text may carry formatting characters (snake_case in a label).
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
    hold(`<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(label)}</a>`))

  out = escapeHtml(out)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(?<![\w*])__(.+?)__(?![\w*])/g, "<b>$1</b>")
    .replace(/(?<!\*)\*(?![*\s])([^*\n]+?)(?<![*\s])\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<!\w)_(?![_\s])([^_\n]+?)(?<![_\s])_(?!\w)/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
  out = out.replace(/\u0000H(\d+)\u0000/g, (_m, i) => held[Number(i)] ?? "")

  // Formatting that crossed lines or nested badly would be rejected by Telegram: send it as plain text.
  if (!isBalancedHtml(out)) {
    return text.replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, (_m, code: string) => `\u0000${code}\u0000`)
      .split("\u0000").map((part, i) => (i % 2 ? `<pre>${escapeHtml(part.trim())}</pre>` : escapeHtml(part))).join("")
  }
  return out
}

/** Telegram counts the limit on the final text, tags included: cut well below it on the raw text. */
export const TELEGRAM_CHUNK = 3000

/** Splits at paragraph, line or word boundaries; a code fence cut in two is closed and reopened. */
export function chunkForTelegram(content: string, maxLength = TELEGRAM_CHUNK): string[] {
  const chunks: string[] = []
  let remaining = content
  let reopen = ""
  while (remaining.length > 0) {
    if (reopen.length + remaining.length <= maxLength) { chunks.push(reopen + remaining); break }
    const room = maxLength - reopen.length - 4
    let split = remaining.lastIndexOf("\n\n", room)
    if (split < room * 0.5) split = remaining.lastIndexOf("\n", room)
    if (split < room * 0.5) split = remaining.lastIndexOf(" ", room)
    if (split < room * 0.5) split = room
    let piece = reopen + remaining.slice(0, split)
    remaining = remaining.slice(split).replace(/^\s+/, "")
    const fences = piece.match(/^```/gm)?.length ?? 0
    if (fences % 2 === 1) {
      piece += "\n```"
      reopen = "```\n"
    } else {
      reopen = ""
    }
    chunks.push(piece)
  }
  return chunks
}

/** Telegram's hard limit, counted on the final HTML. */
export const TELEGRAM_HTML_LIMIT = 4096

/** Raw chunks whose converted HTML fits the limit (escaping can quadruple a chunk full of `<`). */
export function telegramMessageChunks(content: string): string[] {
  const fit = (piece: string, size: number): string[] => {
    if (markdownToTelegramHtml(piece).length <= TELEGRAM_HTML_LIMIT || size < 100) return [piece]
    return chunkForTelegram(piece, Math.floor(size / 2)).flatMap(part => fit(part, Math.floor(size / 2)))
  }
  return chunkForTelegram(content).flatMap(piece => fit(piece, TELEGRAM_CHUNK))
}
