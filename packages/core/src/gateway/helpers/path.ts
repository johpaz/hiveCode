import * as path from "node:path";
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from "node:url";

/**
 * Converts a file URL to a file path.
 * Uses Bun's native implementation when available, falling back to node:url.
 */
export const fileURLToPath: typeof nodeFileURLToPath =
  typeof Bun !== "undefined" && (Bun as any).fileURLToPath
    ? (Bun as any).fileURLToPath.bind(Bun)
    : nodeFileURLToPath;

/**
 * Converts a file path to a file URL.
 * Uses Bun's native implementation when available, falling back to node:url.
 */
export const pathToFileURL: typeof nodePathToFileURL =
  typeof Bun !== "undefined" && (Bun as any).pathToFileURL
    ? (Bun as any).pathToFileURL.bind(Bun)
    : nodePathToFileURL;

/**
 * Expands a path that starts with ~ to the user's home directory.
 * @param p - The path to expand
 * @returns The expanded path
 */
export function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME ?? "", p.slice(1));
  }
  return p;
}
