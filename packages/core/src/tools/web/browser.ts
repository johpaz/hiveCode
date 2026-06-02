/**
 * Browser automation tools using Bun.WebView + Bun.Image pipeline
 *
 * - browser_screenshot: Open URL, capture PNG, resize to 800x600 WebP 70%
 * - browser_capture_clipboard: Read screenshot from clipboard into agent context
 *
 * Requires Bun >= 1.3.14 (WebView + Image APIs available on macOS/Linux desktop).
 * On Linux headless: Bun.WebView needs a display (Xvfb or Wayland).
 */

import { logger } from "../../utils/logger";
import type { Tool } from "../types";
import { detectBrowser } from "./browser-detector";

const log = logger.child("browser");

// ── Image pipeline helpers ──────────────────────────────────────────────────

type BunImageInstance = {
  resize(w: number, h: number): BunImageInstance;
  webp(opts?: { quality?: number }): BunImageInstance; // synchronous in Bun >=1.3.14
  png(): BunImageInstance;                             // synchronous in Bun >=1.3.14
  toBuffer(): Promise<Buffer>;
  bytes(): Promise<Uint8Array>;
  blob(): Promise<Blob>;
  metadata(): { width?: number; height?: number };
};

type BunImageConstructor = {
  new(src: Buffer | string): BunImageInstance;
  hasClipboardImage(): boolean;
  fromClipboard(): Promise<BunImageInstance>;
};

const BunImage: BunImageConstructor | null = (() => {
  try {
    return (Bun as any).Image ?? null;
  } catch {
    return null;
  }
})();

/**
 * Resize to targetWidth×targetHeight and encode as WebP at 70% quality.
 * Accepts a Buffer, Blob, or Bun.Image (returned by view.screenshot() in Bun >=1.3.14).
 * Falls through to raw PNG if Bun.Image is unavailable or the pipeline fails.
 *
 * Bun 1.3.14 API:
 *   view.screenshot()           → Blob
 *   new Bun.Image(buf)          → Image
 *   img.resize(w, h)            → Image  (synchronous)
 *   img.webp({ quality })       → Image  (synchronous, encodes on access)
 *   await encodedImg.toBuffer() → Buffer
 */
async function applyImagePipeline(
  src: Buffer | Blob | BunImageInstance,
  targetWidth = 800,
  targetHeight = 600,
): Promise<{ data: Buffer; mimeType: string; width: number; height: number }> {
  if (BunImage) {
    try {
      let img: BunImageInstance;
      if (src instanceof Buffer) {
        img = new BunImage(src);
      } else if (src instanceof Blob) {
        img = new BunImage(Buffer.from(await src.arrayBuffer()));
      } else {
        img = src as BunImageInstance; // already a Bun.Image
      }
      const webpImg = img.resize(targetWidth, targetHeight).webp({ quality: 70 });
      const webpBuffer = await webpImg.toBuffer();
      return { data: webpBuffer, mimeType: "image/webp", width: targetWidth, height: targetHeight };
    } catch (err) {
      log.warn(`[browser] Image pipeline failed, returning raw PNG: ${(err as Error).message}`);
    }
  }

  // Fallback: raw PNG
  let pngBuffer: Buffer;
  if (src instanceof Buffer) {
    pngBuffer = src;
  } else if (src instanceof Blob) {
    pngBuffer = Buffer.from(await src.arrayBuffer());
  } else {
    // Bun.Image: encode as PNG and get the buffer
    pngBuffer = await (src as BunImageInstance).png().toBuffer();
  }
  return { data: pngBuffer, mimeType: "image/png", width: targetWidth, height: targetHeight };
}

// ── Screenshot ─────────────────────────────────────────────────────────────

export interface ScreenshotResult {
  ok: boolean;
  imageBase64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
}

async function takeScreenshot(
  url: string,
  options: {
    width?: number;
    height?: number;
    selector?: string;
    waitMs?: number;
    applyPipeline?: boolean;
  } = {}
): Promise<ScreenshotResult> {
  if (typeof Bun.WebView !== "function") {
    return { ok: false, error: "Bun.WebView is not available in this build (requires macOS/Linux desktop)" };
  }

  // Auto-detect the OS browser if BUN_CHROME_PATH is not already set
  if (!process.env.BUN_CHROME_PATH) {
    const detected = detectBrowser();
    if (detected) {
      process.env.BUN_CHROME_PATH = detected.path;
      log.info(`[browser] Using ${detected.name} at ${detected.path}`);
    }
  }

  let view: InstanceType<typeof Bun.WebView> | null = null;

  try {
    view = new Bun.WebView({
      url: (url.startsWith("http") || url.startsWith("file://")) ? url : `file://${url}`,
      width: options.width || 1280,
      height: options.height || 720,
      headless: true,
    });

    let attempts = 0;
    while (view.loading && attempts < 50) {
      await Bun.sleep(100);
      attempts++;
    }

    if (options.waitMs) await Bun.sleep(options.waitMs);

    if (options.selector) {
      let selectorAttempts = 0;
      let found = false;
      while (selectorAttempts < 30 && !found) {
        try {
          const result = await view.evaluate(
            `!!document.querySelector(${JSON.stringify(options.selector)})`
          );
          found = result === true || result === "true";
        } catch { /* ignore */ }
        if (!found) { await Bun.sleep(200); selectorAttempts++; }
      }
      if (!found) log.warn(`[browser] Selector ${options.selector} not found after 6s`);
    }

    // Bun.WebView.screenshot() returns Buffer (old), Blob, or Bun.Image (>=1.3.14)
    const screenshotResult = await (view.screenshot() as unknown as Promise<Buffer | Blob | BunImageInstance>);
    view.close();
    view = null;

    if (!screenshotResult) {
      return { ok: false, error: "Screenshot returned empty result" };
    }

    if (options.applyPipeline !== false) {
      const processed = await applyImagePipeline(screenshotResult, 800, 600);
      return {
        ok: true,
        imageBase64: processed.data.toString("base64"),
        mimeType: processed.mimeType,
        width: processed.width,
        height: processed.height,
      };
    }

    // applyPipeline=false: return the raw screenshot as PNG
    const raw = await applyImagePipeline(screenshotResult, options.width || 1280, options.height || 720);
    return {
      ok: true,
      imageBase64: raw.data.toString("base64"),
      mimeType: "image/png",
      width: options.width || 1280,
      height: options.height || 720,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("Chrome") || message.includes("Chromium")) {
      return {
        ok: false,
        error:
          "No Chromium-compatible browser found. " +
          "Install google-chrome-stable, chromium, brave, or microsoft-edge, " +
          "or set BUN_CHROME_PATH to the browser executable path.",
      };
    }
    return { ok: false, error: message };
  } finally {
    if (view) {
      try { view.close(); } catch { /* ignore */ }
    }
  }
}

export const browserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description:
    "Open a URL in a headless browser (Bun.WebView), take a screenshot, and resize it to 800×600 WebP " +
    "for efficient inclusion in agent context. Useful for verifying UI components generated by frontend agents.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to open (http/https or absolute local file path)",
      },
      width: {
        type: "number",
        description: "Browser viewport width before resize (default: 1280)",
      },
      height: {
        type: "number",
        description: "Browser viewport height before resize (default: 720)",
      },
      selector: {
        type: "string",
        description: "CSS selector to wait for before capturing",
      },
      waitMs: {
        type: "number",
        description: "Extra milliseconds to wait after page load (default: 500)",
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    const url = String(args.url);
    const width = args.width ? Number(args.width) : undefined;
    const height = args.height ? Number(args.height) : undefined;
    const selector = args.selector ? String(args.selector) : undefined;
    const waitMs = args.waitMs ? Number(args.waitMs) : 500;

    log.info(`[browser] Screenshot + pipeline: ${url}`);
    const result = await takeScreenshot(url, { width, height, selector, waitMs, applyPipeline: true });

    if (!result.ok) {
      log.error(`[browser] Screenshot failed: ${result.error}`);
    } else {
      log.info(`[browser] Screenshot OK ${result.width}×${result.height} ${result.mimeType} (${Math.round((result.imageBase64?.length ?? 0) * 3 / 4 / 1024)}KB)`);
    }

    return result;
  },
};

// ── Clipboard capture ──────────────────────────────────────────────────────

/**
 * Read an image from the system clipboard and return it as base64 WebP.
 * Allows the user to paste a screenshot directly into Bee's context.
 */
export async function captureClipboard(): Promise<ScreenshotResult> {
  if (!BunImage) {
    return { ok: false, error: "Bun.Image not available — cannot read clipboard" };
  }
  try {
    if (!BunImage.hasClipboardImage()) {
      return { ok: false, error: "No image in clipboard" };
    }
    const img = await BunImage.fromClipboard();
    const meta = img.metadata();
    const processed = await applyImagePipeline(
      img,
      Math.min(meta.width ?? 800, 800),
      Math.min(meta.height ?? 600, 600),
    );
    return {
      ok: true,
      imageBase64: processed.data.toString("base64"),
      mimeType: processed.mimeType,
      width: processed.width,
      height: processed.height,
    };
  } catch (err) {
    return { ok: false, error: `Clipboard capture failed: ${(err as Error).message}` };
  }
}

export const browserCaptureClipboardTool: Tool = {
  name: "browser_capture_clipboard",
  description:
    "Read an image from the system clipboard and return it as base64 WebP for inclusion in agent context. " +
    "Use this when the user pastes a screenshot to share a visual with Bee.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string | object> {
    log.info("[browser] Capturing clipboard image");
    const result = await captureClipboard();
    if (!result.ok) {
      log.warn(`[browser] Clipboard capture failed: ${result.error}`);
    } else {
      log.info(`[browser] Clipboard capture OK ${result.width}×${result.height} ${result.mimeType}`);
    }
    return result;
  },
};

// ── HTML preview ───────────────────────────────────────────────────────────

/**
 * Serve raw HTML via a temporary local HTTP server and screenshot it via Bun.WebView.
 * Using HTTP avoids file:// access restrictions that affect sandboxed Chrome builds
 * (flatpak, snap) which may block local filesystem access in headless mode.
 */
export const browserPreviewHtmlTool: Tool = {
  name: "browser_preview_html",
  description:
    "Serve raw HTML on a temporary local HTTP server and capture a screenshot via Bun.WebView " +
    "(headless). Use to verify generated web components without starting a server. Returns base64 WebP.",
  parameters: {
    type: "object",
    properties: {
      html: {
        type: "string",
        description: "Full HTML document to preview",
      },
      waitMs: {
        type: "number",
        description: "Milliseconds to wait after page load before capture (default: 800)",
      },
      selector: {
        type: "string",
        description: "CSS selector to wait for before capture",
      },
      width: {
        type: "number",
        description: "Viewport width (default: 1280)",
      },
      height: {
        type: "number",
        description: "Viewport height (default: 720)",
      },
    },
    required: ["html"],
  },
  async execute(args: Record<string, unknown>): Promise<string | object> {
    const html = String(args.html);

    // Serve HTML via local HTTP to avoid file:// sandbox restrictions (flatpak/snap Chrome)
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });

    log.info(`[browser] HTML preview → http://localhost:${server.port}/`);

    try {
      const result = await takeScreenshot(`http://localhost:${server.port}/`, {
        width: args.width ? Number(args.width) : undefined,
        height: args.height ? Number(args.height) : undefined,
        waitMs: args.waitMs ? Number(args.waitMs) : 800,
        selector: args.selector ? String(args.selector) : undefined,
        applyPipeline: true,
      });
      if (!result.ok) {
        log.error(`[browser] HTML preview failed: ${result.error}`);
      } else {
        log.info(`[browser] HTML preview OK ${result.width}×${result.height} ${result.mimeType}`);
      }
      return result;
    } finally {
      server.stop();
    }
  },
};
