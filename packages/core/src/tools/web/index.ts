/**
 * Web Tools - Web utilities + browser automation (Bun.WebView + agent-browser)
 */

import type { Tool } from "../types.ts";
import { webSearchTool } from "./web-search.ts";
import { webFetchTool } from "./web-fetch.ts";
import { browserScreenshotTool, browserCaptureClipboardTool, browserPreviewHtmlTool } from "./browser.ts";
import {
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserExtractTool,
  browserScriptTool,
  browserWaitTool,
} from "./browser-agent.ts";

export function createTools(): Tool[] {
  return [
    webSearchTool,
    webFetchTool,
    browserScreenshotTool,
    browserCaptureClipboardTool,
    browserPreviewHtmlTool,
    // agent-browser: accessibility-tree first (~200-400 tokens/step), screenshot fallback
    browserNavigateTool,
    browserClickTool,
    browserTypeTool,
    browserExtractTool,
    browserScriptTool,
    browserWaitTool,
  ];
}

export * from "./web-search.ts";
export * from "./web-fetch.ts";
export * from "./browser.ts";
export * from "./browser-agent.ts";
