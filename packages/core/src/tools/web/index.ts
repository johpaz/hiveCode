/**
 * Web Tools - Web utilities + browser automation (Bun.WebView)
 */

import type { Tool } from "../types.ts";
import { webSearchTool } from "./web-search.ts";
import { webFetchTool } from "./web-fetch.ts";
import { browserScreenshotTool, browserCaptureClipboardTool, browserPreviewHtmlTool } from "./browser.ts";

export function createTools(): Tool[] {
  return [
    webSearchTool,
    webFetchTool,
    browserScreenshotTool,
    browserCaptureClipboardTool,
    browserPreviewHtmlTool,
  ];
}

export * from "./web-search.ts";
export * from "./web-fetch.ts";
export * from "./browser.ts";
