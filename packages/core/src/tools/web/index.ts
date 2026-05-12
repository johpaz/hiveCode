/**
 * Web Tools - Web utilities (no browser automation in terminal-only mode)
 */

import type { Tool } from "../types.ts";
import { webSearchTool } from "./web-search.ts";
import { webFetchTool } from "./web-fetch.ts";

export function createTools(): Tool[] {
  return [
    webSearchTool,
    webFetchTool,
  ];
}

export * from "./web-search.ts";
export * from "./web-fetch.ts";
