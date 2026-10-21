export function buildSnippet(content: string, query: string, maxLen = 420): string {
  const terms = query
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lower = content.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    idx = lower.indexOf(term);
    if (idx !== -1) break;
  }
  if (idx === -1) return content.slice(0, maxLen);
  const start = Math.max(0, idx - Math.floor(maxLen / 2));
  const end = Math.min(content.length, start + maxLen);
  return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}

/** Same fragment as {@link buildSnippet}, plus the 1-based line range it covers, so a reader can ask for those lines instead of the whole file. */
export function buildSnippetWithRange(content: string, query: string, maxLen = 420): { snippet: string; startLine: number; endLine: number } {
  const snippet = buildSnippet(content, query, maxLen)
  const body = snippet.replace(/^\.\.\./, "").replace(/\.\.\.$/, "")
  const at = body ? content.indexOf(body) : 0
  const from = at < 0 ? 0 : at
  const startLine = content.slice(0, from).split("\n").length
  return { snippet, startLine, endLine: startLine + body.split("\n").length - 1 }
}
