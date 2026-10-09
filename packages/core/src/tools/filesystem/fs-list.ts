/**
 * fs_list - List files and directories in workspace
 * 
 * @category filesystem
 * @seedId fs_list
 * @spanish listar archivos, ver carpeta, explorar directorio
 */

import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace, expandPath } from "./workspace-guard.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const log = logger.child("fs-list");

/** Never worth listing: dependencies, VCS data and build output. */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "target", "dist", "build", ".next", ".turbo", "coverage",
  "__pycache__", ".venv", "venv", ".cache",
]);
const DEFAULT_MAX_ENTRIES = 200;

export const fsListTool: Tool = {
  name: "fs_list",
  description: "List files and directories in workspace. Spanish: listar archivos, ver carpeta, explorar directorio",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the directory to list (default: current directory)",
      },
      recursive: {
        type: "boolean",
        description: "List recursively (default: false)",
      },
      maxDepth: {
        type: "number",
        description: "Maximum depth for recursive listing (default: 3)",
      },
      detail: {
        type: "boolean",
        description: "Include size and modified date for every entry (default: false — names and types only)",
      },
      maxEntries: {
        type: "number",
        description: "Most entries to return, counted across the whole tree (default: 200)",
      },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const workspace = getWorkspace(config);
    // Default to workspace root when no path given and workspace is configured
    const rawPath = (params.path as string) ?? (workspace ? expandPath(workspace) : ".");
    let dirPath: string;
    try {
      dirPath = resolveInWorkspace(rawPath, workspace);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const recursive = (params.recursive as boolean) ?? false;
    const maxDepth = (params.maxDepth as number) ?? 3;
    const detail = (params.detail as boolean) ?? false;
    const maxEntries = Math.max(1, (params.maxEntries as number) ?? DEFAULT_MAX_ENTRIES);
    let emitted = 0;
    let skipped = 0;

    log.debug(`Listing directory: ${dirPath}`);

    try {
      if (!fs.existsSync(dirPath)) {
        return {
          ok: false,
          error: `Directory not found: ${dirPath}`,
        };
      }

      const stats = fs.statSync(dirPath);
      if (!stats.isDirectory()) {
        return {
          ok: false,
          error: `Not a directory: ${dirPath}`,
        };
      }

      interface FileEntry {
        name: string;
        type: "file" | "directory";
        path: string;
        size?: number;
        modified?: string;
        children?: FileEntry[];
      }

      function listDir(dir: string, depth: number): FileEntry[] {
        if (depth > maxDepth) return [];

        const out: FileEntry[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          // Dependency and build directories are never what the agent is looking
          // for, and a recursive listing of one is what filled the context window.
          if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
            skipped++;
            continue;
          }
          if (emitted >= maxEntries) {
            skipped++;
            continue;
          }
          emitted++;

          const fullPath = path.join(dir, entry.name);
          const result: FileEntry = {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            path: fullPath,
          };

          if (detail) {
            try {
              const subStats = fs.statSync(fullPath);
              result.size = subStats.size;
              result.modified = subStats.mtime.toISOString();
            } catch {
              // Ignore permission errors
            }
          }

          if (entry.isDirectory() && recursive && depth < maxDepth) {
            try {
              result.children = listDir(fullPath, depth + 1);
            } catch {
              // Ignore permission errors
            }
          }

          out.push(result);
        }
        return out;
      }

      const entries = listDir(dirPath, 0);

      return {
        ok: true,
        path: dirPath,
        entries,
        count: emitted,
        ...(skipped > 0 && {
          truncated: true,
          omitted: skipped,
          note: `Se omitieron ${skipped} entradas (carpetas de dependencias/build o tope de ${maxEntries}). Lista una subcarpeta concreta o usa search_knowledge(type="code").`,
        }),
      };
    } catch (error) {
      log.error(`Error listing directory: ${(error as Error).message}`);
      return {
        ok: false,
        error: `Failed to list directory: ${(error as Error).message}`,
      };
    }
  },
};
