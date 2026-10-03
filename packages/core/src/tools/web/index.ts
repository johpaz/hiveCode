/**
 * Web Tools - Web utilities + browser automation (Obscura via direct MCP 2.0)
 */

import type { Tool } from "../types.ts";
import { webSearchTool } from "./web-search.ts";
import { webFetchTool } from "./web-fetch.ts";
import { browserCaptureClipboardTool, browserPreviewHtmlTool } from "./browser.ts";
import { createObscuraTools } from "./obscura.ts";

export function createTools(): Tool[] {
  return [
    webSearchTool,
    webFetchTool,
    browserCaptureClipboardTool,
    browserPreviewHtmlTool,
    // Obscura (MCP 2.0): the full browser_* automation surface — live session,
    // element refs, markdown extraction, forms, tabs, cookies, screenshots, PDF.
    // browser_screenshot here is session-based (current page); the standalone
    // Bun.WebView screenshot (browserScreenshotTool) stays exported below for
    // programmatic use but is not registered to avoid a duplicate tool name.
    ...createObscuraTools(),
  ];
}

export * from "./web-search.ts";
export * from "./web-fetch.ts";
export * from "./browser.ts";
export * from "./obscura.ts";
