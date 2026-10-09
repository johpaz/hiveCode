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
