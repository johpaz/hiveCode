import { backupIfExists } from "./backup";
/**
 * fs_write - Create or overwrite file in agent workspace
 * 
 * @category filesystem
 * @seedId fs_write
 * @spanish crear archivo, guardar archivo, escribir archivo
 */

import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace } from "./workspace-guard.ts";
import * as path from "node:path";

const log = logger.child("fs-write");



export const fsWriteTool: Tool = {
  name: "fs_write",
  description: "Create or overwrite file in agent workspace. Spanish: crear archivo, guardar archivo, escribir archivo",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
  execute: async (params: Record<string, unknown>, config?: any) => {
    const workspace = getWorkspace(config);
    let filePath: string;
    try {
      filePath = resolveInWorkspace(params.path as string, workspace);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const content = params.content as string;

    log.debug(`Writing file: ${filePath}`);

    try {
      // Bun.write automatically creates parent directories if they don't exist
      const backup = await backupIfExists(filePath, log);

      await Bun.write(filePath, content);

      return { ok: true, path: filePath, bytesWritten: content.length, backup };
    } catch (error) {
      log.error(`Error writing file: ${(error as Error).message}`);
      return { ok: false, error: `Failed to write file: ${(error as Error).message}` };
    }
  },
};
