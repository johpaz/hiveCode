/**
 * fs_read - Read file content from agent workspace
 * 
 * @category filesystem
 * @seedId fs_read
 * @spanish leer archivo, ver contenido, abrir archivo
 */

import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace } from "./workspace-guard.ts";

const log = logger.child("fs-read");

/** Most characters one read returns, whatever the line count. */
const MAX_READ_CHARS = 20_000;

/** Lines returned when a larger file is read without offset/limit. */
const LARGE_FILE_LINES = 500;

export const fsReadTool: Tool = {
  name: "fs_read",
  description: "Read file content from agent workspace. Spanish: leer archivo, ver contenido, abrir archivo",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed, default: 1). Negative values read from the end: -20 reads the last 20 lines.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read (default: 2000)",
      },
    },
    required: ["path"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const workspace = getWorkspace(config);
    let filePath: string;
    try {
      filePath = resolveInWorkspace(params.path as string, workspace);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const rawOffset = (params.offset as number | undefined);
    const limit = (params.limit as number) ?? 2000;

    log.debug(`Reading file: ${filePath}`);

    try {
      const content = await Bun.file(filePath).text();
      const lines = content.split("\n");
      const totalLines = lines.length;

      // A large file read without offset/limit still returns its first lines (never an empty turn),
      // with the way to continue.
      const bounded = totalLines > LARGE_FILE_LINES && rawOffset === undefined && (params.limit as number | undefined) === undefined;
      const effectiveLimit = bounded ? LARGE_FILE_LINES : limit;

      // Support negative offset: -20 → last 20 lines
      const resolvedOffset = rawOffset === undefined ? 1 : rawOffset;
      const start = resolvedOffset < 0
        ? Math.max(0, totalLines + resolvedOffset)
        : Math.max(0, resolvedOffset - 1);
      const end = Math.min(totalLines, start + effectiveLimit);
      let selected = lines.slice(start, end);

      // Line limits do not bound size (a minified file is one line). Cap the
      // characters too, and say where to continue.
      let charCount = 0;
      let cut = selected.length;
      for (let i = 0; i < selected.length; i++) {
        charCount += selected[i].length + 8;
        if (charCount > MAX_READ_CHARS && i > 0) { cut = i; break; }
      }
      const truncated = cut < selected.length;
      if (truncated) selected = selected.slice(0, cut);
      else if (selected.length === 1 && selected[0].length > MAX_READ_CHARS) {
        selected = [`${selected[0].slice(0, MAX_READ_CHARS)} […línea recortada a ${MAX_READ_CHARS} caracteres]`];
      }

      return {
        ok: true,
        path: filePath,
        content: selected.map((line, i) => `${start + i + 1}: ${line}`).join("\n"),
        totalLines,
        linesRead: selected.length,
        ...(truncated && {
          truncated: true,
          nextOffset: start + selected.length + 1,
          note: `Lectura cortada a ~${MAX_READ_CHARS} caracteres. Continúa con fs_read offset=${start + selected.length + 1}.`,
        }),
        ...(!truncated && bounded && {
          truncated: true,
          nextOffset: start + selected.length + 1,
          note: `Archivo grande (${totalLines} líneas): se devolvieron las primeras ${selected.length}. Continúa con fs_read offset=${start + selected.length + 1}, o usa parse_ast para ver su estructura.`,
        }),
      };
    } catch (error) {
      log.error(`Error reading file: ${(error as Error).message}`);
      return {
        ok: false,
        error: `Failed to read file: ${(error as Error).message}`,
      };
    }
  },
};
