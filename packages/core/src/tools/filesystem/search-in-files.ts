/**
 * search_in_files - Search for a pattern in a file or directory
 *
 * @category filesystem
 * @seedId search_in_files
 * @spanish buscar en archivos, grep, buscar patrón
 */

import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace } from "./workspace-guard.ts";

const log = logger.child("search-in-files");
const MAX_MATCHES = 100;

export const searchInFilesTool: Tool = {
  name: "search_in_files",
  description: "Search for a string or regex pattern in a file or directory. Returns matching lines with line numbers. Spanish: buscar en archivos, grep, buscar patrón",
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

    log.debug(`Searching "${pattern}" in ${targetPath}`);

    const matches: { file: string; line: number; content: string }[] = [];

    async function searchFile(filePath: string): Promise<void> {
      if (matches.length >= MAX_MATCHES) return;
      try {
        const content = await Bun.file(filePath).text();
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_MATCHES) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push({ file: filePath, line: i + 1, content: lines[i].trim() });
          }
        }
      } catch {
        // Skip unreadable files silently
      }
    }

    try {
      const stat = await Bun.file(targetPath).stat?.() ?? null;
      // Bun.file().stat() works for files; for dirs we use the glob approach
      const isDir = stat === null || (stat as any)?.isDirectory?.() === true;

      if (!isDir) {
        await searchFile(targetPath);
      } else {
        // Recursive directory search using Bun's glob
        const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yaml,yml,toml,rs,py,go}");
        for await (const entry of glob.scan({ cwd: targetPath, onlyFiles: true })) {
          if (matches.length >= MAX_MATCHES) break;
          await searchFile(`${targetPath}/${entry}`);
        }
      }
    } catch (error) {
      return { ok: false, error: `Search failed: ${(error as Error).message}` };
    }

    return {
      ok: true,
      pattern,
      path: targetPath,
      matches,
      count: matches.length,
      truncated: matches.length >= MAX_MATCHES,
    };
  },
};
