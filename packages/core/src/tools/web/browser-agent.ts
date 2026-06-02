/**
 * Browser automation tools using Vercel agent-browser CLI (accessibility-tree first).
 *
 * These tools spawn the `agent-browser` CLI as a subprocess and return structured
 * accessibility tree snapshots (~200-400 tokens/step vs ~1,280 for screenshots).
 *
 * Falls back gracefully when the CLI is not installed:
 *   - browser_navigate → falls back to Bun.WebView screenshot
 *   - all others       → { ok: false, error: install instructions }
 *
 * Install: npm install -g @vercel/agent-browser
 */

import { logger } from "../../utils/logger";
import type { Tool } from "../types";
import { browserScreenshotTool } from "./browser";
import { detectBrowser } from "./browser-detector";

const log = logger.child("browser-agent");

// ── CLI binary resolution ────────────────────────────────────────────────────

/**
 * Resolve the agent-browser binary path.
 * Checks PATH first (global install), then walks up from this file to find
 * node_modules/.bin/agent-browser (local dependency via bun install).
 * Returns null if not found anywhere.
 */
function resolveAgentBrowserBin(): string | null {
  // 1. Check PATH (global install or bun already prepended node_modules/.bin)
  try {
    const r = Bun.spawnSync(["which", "agent-browser"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (r.exitCode === 0) {
      const p = r.stdout.toString().trim();
      if (p.length > 0) return p;
    }
  } catch { /* ignore */ }

  // 2. Walk up from this file to find node_modules/.bin (local dependency)
  const parts = import.meta.dir.split("/");
  for (let i = parts.length; i > 0; i--) {
    const candidate = [...parts.slice(0, i), "node_modules", ".bin", "agent-browser"].join("/");
    const check = Bun.spawnSync(["test", "-x", candidate], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (check.exitCode === 0) return candidate;
  }

  return null;
}

const AGENT_BROWSER_BIN: string | null = resolveAgentBrowserBin();

// ── Session state (shared across all 6 tools in this module) ─────────────────

let activeBrowserSessionId: string | null = null;

// ── Subprocess helper ────────────────────────────────────────────────────────

function buildExecPathArgs(): string[] {
  if (process.env.AGENT_BROWSER_EXECUTABLE_PATH) return [];
  const detected = detectBrowser();
  if (!detected) return [];
  // Skip flatpak/snap native binaries — they need the container environment;
  // agent-browser (Playwright) will hang trying to connect to them via CDP.
  if (detected.name.includes("flatpak") || detected.name.includes("snap")) return [];
  return ["--executable-path", detected.path];
}

async function runAgentBrowser(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const execArgs = buildExecPathArgs();
  const proc = Bun.spawn([AGENT_BROWSER_BIN!, ...execArgs, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJsonOutput(raw: string): object {
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: true, snapshot: raw };
  }
}

const INSTALL_ERROR = "agent-browser CLI not installed. Run: npm install -g @vercel/agent-browser";
const NO_SESSION_ERROR = "No active browser session. Call browser_navigate first.";

// ── Tools ────────────────────────────────────────────────────────────────────

export const browserNavigateTool: Tool = {
  name: "browser_navigate",
  description:
    "Navigate to a URL and return an accessibility tree snapshot (~200-400 tokens). " +
    "Preferred over browser_screenshot for most automation tasks. " +
    "Falls back to Bun.WebView screenshot if agent-browser CLI is not installed. " +
    "Sets the active session for subsequent browser_click, browser_type, etc.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to navigate to (http/https or file://)",
      },
      waitFor: {
        type: "string",
        description: "CSS selector to wait for before returning the snapshot",
      },
      timeoutMs: {
        type: "number",
        description: "Navigation timeout in milliseconds (default: 30000)",
      },
      newSession: {
        type: "boolean",
        description: "Force a new browser session (default: reuse existing)",
      },
      useScreenshot: {
        type: "boolean",
        description: "Force visual screenshot instead of accessibility tree (for canvas/visual tasks)",
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    const url = String(args.url);
    const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 30_000;
    const useScreenshot = args.useScreenshot === true;

    if (!AGENT_BROWSER_BIN || useScreenshot) {
      if (!AGENT_BROWSER_BIN) {
        log.warn("[browser-agent] agent-browser not installed, falling back to screenshot");
      }
      return browserScreenshotTool.execute({ url });
    }

    const cliArgs = ["navigate", url, "--json"];
    if (url.startsWith("file://")) cliArgs.push("--allow-file-access");
    if (args.waitFor) { cliArgs.push("--wait-for", String(args.waitFor)); }
    if (args.newSession === true) { cliArgs.push("--new-session"); }

    log.info(`[browser-agent] navigate ${url}`);
    const result = await runAgentBrowser(cliArgs, timeoutMs);

    if (!result.ok) {
      log.error(`[browser-agent] navigate failed: ${result.stderr}`);
      return { ok: false, error: result.stderr || `Exit code ${result.exitCode}` };
    }

    const parsed = parseJsonOutput(result.stdout) as Record<string, unknown>;
    // Agent-browser uses named persistent sessions; default session is "default".
    // Newer CLI versions no longer echo sessionId in the navigate response.
    activeBrowserSessionId = parsed.sessionId ? String(parsed.sessionId) : "default";
    log.info(`[browser-agent] session: ${activeBrowserSessionId}`);

    return parsed;
  },
};

export const browserClickTool: Tool = {
  name: "browser_click",
  description:
    "Click an element on the active browser page using a CSS selector or ARIA ID (e.g. @e3). " +
    "Requires an active session from browser_navigate. " +
    "Returns an updated accessibility tree snapshot.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector or ARIA element ID like @e3",
      },
      sessionId: {
        type: "string",
        description: "Browser session ID (defaults to the active session)",
      },
      timeoutMs: {
        type: "number",
        description: "Timeout in milliseconds (default: 10000)",
      },
    },
    required: ["selector"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    if (!AGENT_BROWSER_BIN) return { ok: false, error: INSTALL_ERROR };

    const sessionId = args.sessionId ? String(args.sessionId) : activeBrowserSessionId;
    if (!sessionId) return { ok: false, error: NO_SESSION_ERROR };

    const selector = String(args.selector);
    const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 10_000;

    log.info(`[browser-agent] click ${selector}`);
    const result = await runAgentBrowser(
      ["click", selector, "--session", sessionId, "--json"],
      timeoutMs,
    );

    if (!result.ok) return { ok: false, error: result.stderr || `Exit code ${result.exitCode}` };
    return parseJsonOutput(result.stdout);
  },
};

export const browserTypeTool: Tool = {
  name: "browser_type",
  description:
    "Type text into an input field or form element on the active browser page. " +
    "Accepts CSS selector or ARIA ID like @e3. " +
    "Requires an active session from browser_navigate.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector or ARIA element ID like @e3",
      },
      text: {
        type: "string",
        description: "Text to type into the element",
      },
      clear: {
        type: "boolean",
        description: "Clear existing content before typing (default: false)",
      },
      sessionId: {
        type: "string",
        description: "Browser session ID (defaults to the active session)",
      },
    },
    required: ["selector", "text"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    if (!AGENT_BROWSER_BIN) return { ok: false, error: INSTALL_ERROR };

    const sessionId = args.sessionId ? String(args.sessionId) : activeBrowserSessionId;
    if (!sessionId) return { ok: false, error: NO_SESSION_ERROR };

    const selector = String(args.selector);
    const text = String(args.text);

    const cliArgs = ["type", selector, text, "--session", sessionId, "--json"];
    if (args.clear === true) cliArgs.push("--clear");

    log.info(`[browser-agent] type into ${selector}`);
    const result = await runAgentBrowser(cliArgs, 15_000);

    if (!result.ok) return { ok: false, error: result.stderr || `Exit code ${result.exitCode}` };
    return parseJsonOutput(result.stdout);
  },
};

export const browserExtractTool: Tool = {
  name: "browser_extract",
  description:
    "Extract text, links, or structured data from the active browser page. " +
    "Use a CSS selector to target specific elements, or omit for the full page. " +
    "Requires an active session from browser_navigate.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to target specific elements (omit for full page)",
      },
      format: {
        type: "string",
        enum: ["text", "json", "links"],
        description: "Output format: text (default), json (structured), or links (href list)",
      },
      sessionId: {
        type: "string",
        description: "Browser session ID (defaults to the active session)",
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    if (!AGENT_BROWSER_BIN) return { ok: false, error: INSTALL_ERROR };

    const sessionId = args.sessionId ? String(args.sessionId) : activeBrowserSessionId;
    if (!sessionId) return { ok: false, error: NO_SESSION_ERROR };

    const format = args.format ? String(args.format) : "text";
    const selector = args.selector ? String(args.selector) : null;

    log.info(`[browser-agent] extract format=${format}`);

    let cliArgs: string[];
    if (format === "json") {
      // Accessibility tree snapshot — best structured format for AI agents
      cliArgs = ["snapshot", "--session", sessionId, "--json"];
    } else if (format === "links") {
      // Eval JS to get all anchor hrefs + text
      const script = `JSON.stringify(Array.from(document.querySelectorAll('${selector ?? "a"}')).map(a=>({text:a.innerText.trim(),href:a.href})))`;
      cliArgs = ["eval", script, "--session", sessionId, "--json"];
    } else {
      // text: get text content of selector or full body
      if (selector) {
        cliArgs = ["get", "text", selector, "--session", sessionId, "--json"];
      } else {
        cliArgs = ["eval", "document.body.innerText", "--session", sessionId, "--json"];
      }
    }

    const result = await runAgentBrowser(cliArgs, 15_000);

    if (!result.ok) return { ok: false, error: result.stderr || `Exit code ${result.exitCode}` };
    return parseJsonOutput(result.stdout);
  },
};

export const browserScriptTool: Tool = {
  name: "browser_script",
  description:
    "Execute arbitrary JavaScript in the browser page context and return the result. " +
    "Requires an active session from browser_navigate.",
  parameters: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "JavaScript expression or statement to evaluate in the page",
      },
      sessionId: {
        type: "string",
        description: "Browser session ID (defaults to the active session)",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in milliseconds (default: 10000)",
      },
    },
    required: ["script"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    if (!AGENT_BROWSER_BIN) return { ok: false, error: INSTALL_ERROR };

    const sessionId = args.sessionId ? String(args.sessionId) : activeBrowserSessionId;
    if (!sessionId) return { ok: false, error: NO_SESSION_ERROR };

    const script = String(args.script);
    const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 10_000;

    log.info(`[browser-agent] eval script (${script.length} chars)`);
    const result = await runAgentBrowser(
      ["eval", script, "--session", sessionId, "--json"],
      timeoutMs,
    );

    if (!result.ok) return { ok: false, error: result.stderr || `Exit code ${result.exitCode}` };
    return parseJsonOutput(result.stdout);
  },
};

export const browserWaitTool: Tool = {
  name: "browser_wait",
  description:
    "Wait for a CSS selector or ARIA element to appear on the active browser page. " +
    "Requires an active session from browser_navigate.",
  parameters: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector or ARIA element ID to wait for",
      },
      timeoutMs: {
        type: "number",
        description: "Maximum wait time in milliseconds (default: 10000)",
      },
      sessionId: {
        type: "string",
        description: "Browser session ID (defaults to the active session)",
      },
    },
    required: ["selector"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    if (!AGENT_BROWSER_BIN) return { ok: false, error: INSTALL_ERROR };

    const sessionId = args.sessionId ? String(args.sessionId) : activeBrowserSessionId;
    if (!sessionId) return { ok: false, error: NO_SESSION_ERROR };

    const selector = String(args.selector);
    const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : 10_000;

    log.info(`[browser-agent] wait for ${selector}`);
    const result = await runAgentBrowser(
      ["wait", selector, "--timeout", String(timeoutMs), "--session", sessionId, "--json"],
      timeoutMs + 2_000,
    );

    if (!result.ok) return { ok: false, error: result.stderr || "timeout" };
    return parseJsonOutput(result.stdout);
  },
};
