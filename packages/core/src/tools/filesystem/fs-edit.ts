import { backupIfExists } from "./backup";
/**
 * fs_edit - Edit specific lines or sections of a file
 *
 * @category filesystem
 * @seedId fs_edit
 * @spanish editar archivo, modificar líneas, actualizar contenido
 */

import type { Tool } from "../types.ts";
import { logger } from "../../utils/logger.ts";
import { resolveInWorkspace, getWorkspace } from "./workspace-guard.ts";
const log = logger.child("fs-edit");

type Edit = { oldString: string; newString: string; replaceAll?: boolean };

export const fsEditTool: Tool = {
  name: "fs_edit",
  description: "Edit a file by exact text replacement. Pass oldString/newString for one change, or edits[] for several changes to the same file in ONE call (applied in order, all-or-nothing). Spanish: editar archivo, modificar líneas, actualizar contenido",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit",
      },
      oldString: {
        type: "string",
        description: "The text to search for and replace",
      },
      newString: {
        type: "string",
        description: "The text to replace with",
      },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences (default: false)",
      },
      edits: {
        type: "array",
        description: "Several replacements to the same file, applied in order against the running result. Use instead of oldString/newString.",
        items: {
          type: "object",
          properties: {
            oldString: { type: "string", description: "The text to search for and replace" },
            newString: { type: "string", description: "The text to replace with" },
            replaceAll: { type: "boolean", description: "Replace all occurrences (default: false)" },
          },
          required: ["oldString", "newString"],
        },
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

    const edits: Edit[] = Array.isArray(params.edits) && params.edits.length > 0
      ? (params.edits as Edit[])
      : typeof params.oldString === "string" && typeof params.newString === "string"
        ? [{ oldString: params.oldString, newString: params.newString, replaceAll: (params.replaceAll as boolean) ?? false }]
        : [];
    if (edits.length === 0) {
      return { ok: false, error: "Provide oldString and newString, or a non-empty edits[]" };
    }
    if (edits.some(e => typeof e?.oldString !== "string" || typeof e?.newString !== "string")) {
      return { ok: false, error: "Every edit needs string oldString and newString" };
    }

    log.debug(`Editing file: ${filePath} (${edits.length} edit${edits.length === 1 ? "" : "s"})`);

    try {
      if (!await Bun.file(filePath).exists()) {
        return {
          ok: false,
          error: `File not found: ${filePath}`,
        };
      }

      const original = await Bun.file(filePath).text();

      // Apply in memory, in order: a later edit sees the result of the earlier ones, and a failure
      // anywhere leaves the file untouched.
      let content = original;
      let replacements = 0;
      for (const [i, edit] of edits.entries()) {
        const label = edits.length > 1 ? `edits[${i}]: ` : "";
        if (!edit.oldString) {
          return { ok: false, error: `${label}oldString is empty` };
        }
        const occurrences = content.split(edit.oldString).length - 1;
        if (occurrences === 0) {
          return {
            ok: false,
            error: `${label}String not found in file: ${edit.oldString.substring(0, 50)}...`,
          };
        }
        if (!edit.replaceAll && occurrences > 1) {
          return {
            ok: false,
            error: `${label}Found ${occurrences} occurrences. Use replaceAll: true or provide more context.`,
          };
        }
        content = edit.replaceAll
          ? content.split(edit.oldString).join(edit.newString)
          // A replacer function: `$&`-style patterns in newString must stay literal.
          : content.replace(edit.oldString, () => edit.newString);
        replacements += edit.replaceAll ? occurrences : 1;
      }

      const backup = await backupIfExists(filePath, log);
      await Bun.write(filePath, content);

      return {
        ok: true,
        path: filePath,
        replacements,
        ...(edits.length > 1 && { edits: edits.length }),
        backup,
      };
    } catch (error) {
      log.error(`Error editing file: ${(error as Error).message}`);
      return {
        ok: false,
        error: `Failed to edit file: ${(error as Error).message}`,
      };
    }
  },
};
