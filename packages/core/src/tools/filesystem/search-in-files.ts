/**
 * search_in_files - Search for a pattern in a file or directory
 *
 * @category filesystem
 * @seedId search_in_files
 * @spanish buscar en archivos, grep, buscar patrón
 */

import { stat } from "node:fs/promises";
import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace } from "./workspace-guard.ts";
import { isReaderAgent } from "../../agent/loadout.ts";
import { isGeneratedFile } from "../../agent/source-index.ts";

const log = logger.child("search-in-files");
const DEFAULT_MAX_MATCHES = 100;
/** A reader explores: thirty matches say where a thing lives, a hundred only fill the context (4.6K tokens a call). */
const READER_MAX_MATCHES = 30;
/** Longest line of a match shown; a minified or data line would otherwise be the whole answer. */
const MAX_MATCH_CHARS = 240;
const HARD_MAX_MATCHES = 500;
const MAX_CONTEXT = 5;
const DEFAULT_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yaml,yml,toml,rs,py,go}";
/** Directories that are never the answer and can hold thousands of files. */
const SKIPPED_DIR = /(^|\/)(node_modules|\.git|dist|build|target|\.next|coverage)\//;

type Match = { file: string; line: number; content: string; before?: string[]; after?: string[] };

export const searchInFilesTool: Tool = {
  name: "search_in_files",
  description: "Search for a string or regex pattern in a file or directory (like grep). For concepts, symbols and \"where is X\", search_knowledge(type=\"code\") is cheaper; use this for exact text the index may not hold. Returns matching lines with line numbers; filter files with glob, add surrounding lines with context, or list only the matching files with output='files'. Spanish: buscar en archivos, grep, buscar patrón",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "String or regex pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory path to search in",
      },
      flags: {
        type: "string",
        description: "Regex flags: 'i' for case-insensitive, 'g' is always applied (default: '')",
      },
      glob: {
        type: "string",
        description: "Only search files matching this glob, relative to path (e.g. '**/*.ts', 'src/**/*.test.ts'). Default: common source and config files.",
      },
      context: {
        type: "number",
        description: `Lines of context before and after each match (0-${MAX_CONTEXT}, default 0)`,
      },
      output: {
        type: "string",
        enum: ["lines", "files"],
        description: "'lines' (default) returns matching lines; 'files' returns only the files that match, with their match count",
      },
      limit: {
        type: "number",
        description: `Maximum matches to return (default ${DEFAULT_MAX_MATCHES}, max ${HARD_MAX_MATCHES})`,
      },
    },
    required: ["pattern", "path"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const workspace = getWorkspace(config);
    let targetPath: string;
    try {
      targetPath = resolveInWorkspace(params.path as string, workspace);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    const pattern = params.pattern as string;
    const flags = ((params.flags as string) ?? "") + "g";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    } catch {
      // Fall back to literal string search if pattern is not valid regex
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }

    const context = Math.min(MAX_CONTEXT, Math.max(0, Math.floor(Number(params.context) || 0)));
    const filesOnly = params.output === "files";
    const reader = isReaderAgent(config?.configurable?.agent_id);
    const maxMatches = Math.min(reader ? READER_MAX_MATCHES * 2 : HARD_MAX_MATCHES, Math.max(1, Math.floor(Number(params.limit) || (reader ? READER_MAX_MATCHES : DEFAULT_MAX_MATCHES))));
    const globPattern = typeof params.glob === "string" && params.glob ? params.glob : DEFAULT_GLOB;

    log.debug(`Searching "${pattern}" in ${targetPath}`);

    const matches: Match[] = [];
    const perFile = new Map<string, number>();

    async function searchFile(filePath: string): Promise<void> {
      if (matches.length >= maxMatches) return;
      try {
        const content = await Bun.file(filePath).text();
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxMatches) break;
          regex.lastIndex = 0;
          if (!regex.test(lines[i])) continue;
          perFile.set(filePath, (perFile.get(filePath) ?? 0) + 1);
          if (filesOnly) { matches.push({ file: filePath, line: i + 1, content: "" }); continue; }
          const text = lines[i].trim();
          const match: Match = { file: filePath, line: i + 1, content: text.length > MAX_MATCH_CHARS ? `${text.slice(0, MAX_MATCH_CHARS)}…` : text };
          if (context > 0) {
            match.before = lines.slice(Math.max(0, i - context), i).map(l => l.trimEnd());
            match.after = lines.slice(i + 1, i + 1 + context).map(l => l.trimEnd());
          }
          matches.push(match);
        }
      } catch {
        // Skip unreadable files silently
      }
    }

    try {
      const isDir = (await stat(targetPath)).isDirectory();

      if (!isDir) {
        await searchFile(targetPath);
      } else {
        // Recursive directory search using Bun's glob
        const glob = new Bun.Glob(globPattern);
        for await (const entry of glob.scan({ cwd: targetPath, onlyFiles: true })) {
          if (matches.length >= maxMatches) break;
          if (SKIPPED_DIR.test(`/${entry}`) || isGeneratedFile(entry)) continue;
          await searchFile(`${targetPath}/${entry}`);
        }
      }
    } catch (error) {
      return { ok: false, error: `Search failed: ${(error as Error).message}` };
    }

    const truncated = matches.length >= maxMatches;
    if (filesOnly) {
      const files = [...perFile].map(([file, count]) => ({ file, count }));
      return { ok: true, pattern, path: targetPath, files, count: files.length, truncated };
    }
    return {
      ok: true,
      pattern,
      path: targetPath,
      matches,
      count: matches.length,
      truncated,
    };
  },
};
