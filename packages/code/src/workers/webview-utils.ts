/**
 * Bun.WebView utilities for visual verification.
 *
 * SPEC §3.6: Uses Bun.WebView for screenshot capture and console error detection.
 * On Linux/headless environments, falls back to manual instructions.
 */

const logPrefix = "[webview]"

/** Check if Bun.WebView is available */
export function isWebViewAvailable(): boolean {
  return typeof (Bun as any).WebView === "function"
}

/** WebView verification result */
export interface WebViewVerification {
  ok: boolean
  screenshot?: Uint8Array
  consoleErrors: string[]
  error?: string
}

/**
 * Open a component in Bun.WebView, capture screenshot, and collect console errors.
 * Falls back gracefully if WebView is not available.
 */
export async function verifyComponent(
  htmlContent: string,
  opts?: { width?: number; height?: number; timeout?: number }
): Promise<WebViewVerification> {
  if (!isWebViewAvailable()) {
    return {
      ok: true, // Graceful degradation
      consoleErrors: [],
      error: "Bun.WebView not available on this platform. Manual visual verification required.",
    }
  }

  const width = opts?.width ?? 1280
  const height = opts?.height ?? 720
  const timeout = opts?.timeout ?? 30_000

  try {
    const WebView = (Bun as any).WebView
    await using view = new WebView()

    view.setSize(width, height)

    const consoleErrors: string[] = []
    view.onConsoleMessage = (level: string, message: string) => {
      if (level === "error" || level === "warning") {
        consoleErrors.push(`[${level}] ${message}`)
      }
    }

    view.loadHTML(htmlContent)

    // Wait for render
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const screenshot = await view.capturePageScreenshot()

    return {
      ok: consoleErrors.length === 0,
      screenshot,
      consoleErrors,
    }
  } catch (err) {
    return {
      ok: false,
      consoleErrors: [],
      error: `WebView verification failed: ${(err as Error).message}`,
    }
  }
}

/**
 * Generate a minimal HTML wrapper for a React/Vanilla component.
 */
export function wrapComponentHTML(componentCode: string, css?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${css || "body { font-family: sans-serif; padding: 20px; }"}</style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
${componentCode}
  </script>
</body>
</html>`
}
