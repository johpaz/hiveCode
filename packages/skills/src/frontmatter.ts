import { YAML } from "bun";

/** Parse a Markdown YAML header using LF or CRLF line endings. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = YAML.parse(match[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { frontmatter: {}, body: content };
    return { frontmatter: parsed as Record<string, unknown>, body: match[2]! };
  } catch {
    return { frontmatter: {}, body: content };
  }
}
