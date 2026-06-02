/**
 * Unit tests for browser preview tools.
 * Only schema/metadata is verified here — actual WebView execution requires
 * a graphical display and is covered in integration tests.
 */
import { describe, test, expect } from "bun:test"
import { browserPreviewHtmlTool, browserScreenshotTool, browserCaptureClipboardTool } from "@johpaz/hivecode-core/tools"
import { detectBrowser } from "@johpaz/hivecode-core/tools/web/browser-detector"

describe("browserPreviewHtmlTool — schema", () => {
  test("name is browser_preview_html", () => {
    expect(browserPreviewHtmlTool.name).toBe("browser_preview_html")
  })

  test("html is listed as required", () => {
    const params = browserPreviewHtmlTool.parameters as any
    expect(Array.isArray(params.required)).toBe(true)
    expect(params.required).toContain("html")
  })

  test("exposes waitMs, selector, width, height properties", () => {
    const props = (browserPreviewHtmlTool.parameters as any).properties
    expect(props.html).toBeDefined()
    expect(props.waitMs).toBeDefined()
    expect(props.selector).toBeDefined()
    expect(props.width).toBeDefined()
    expect(props.height).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof browserPreviewHtmlTool.execute).toBe("function")
  })

  test("description mentions Bun.WebView and temp file", () => {
    expect(browserPreviewHtmlTool.description).toContain("Bun.WebView")
    expect(browserPreviewHtmlTool.description.toLowerCase()).toContain("temp")
  })
})

describe("browserScreenshotTool — schema", () => {
  test("name is browser_screenshot", () => {
    expect(browserScreenshotTool.name).toBe("browser_screenshot")
  })

  test("url is listed as required", () => {
    const params = browserScreenshotTool.parameters as any
    expect(params.required).toContain("url")
  })

  test("exposes width, height, selector, waitMs", () => {
    const props = (browserScreenshotTool.parameters as any).properties
    expect(props.url).toBeDefined()
    expect(props.width).toBeDefined()
    expect(props.height).toBeDefined()
    expect(props.selector).toBeDefined()
    expect(props.waitMs).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof browserScreenshotTool.execute).toBe("function")
  })
})

describe("browserCaptureClipboardTool — schema", () => {
  test("name is browser_capture_clipboard", () => {
    expect(browserCaptureClipboardTool.name).toBe("browser_capture_clipboard")
  })

  test("has an execute function", () => {
    expect(typeof browserCaptureClipboardTool.execute).toBe("function")
  })
})

// ── Real integration tests ────────────────────────────────────────────────────
// These run only when a Chromium-compatible browser is detected on the system.

const browser = detectBrowser()
const itReal = browser ? test : test.skip

describe("browser_preview_html — real render", () => {
  itReal("renders a simple HTML page and returns a base64 image", async () => {
    const html = `<!DOCTYPE html>
<html><head><style>body{margin:0;background:#1e1e2e;display:flex;align-items:center;justify-content:center;height:100vh}</style></head>
<body><h1 style="color:#cdd6f4;font-family:sans-serif">hiveCode browser test</h1></body></html>`

    const result = await browserPreviewHtmlTool.execute({ html, waitMs: 800 }) as any

    expect(result.ok).toBe(true)
    expect(typeof result.imageBase64).toBe("string")
    expect(result.imageBase64.length).toBeGreaterThan(1000)
    expect(result.mimeType).toMatch(/webp|png/)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  }, 30_000)

  itReal("waits for a CSS selector before capturing", async () => {
    const html = `<!DOCTYPE html>
<html><body style="background:#313244">
<script>setTimeout(()=>{const d=document.createElement('div');d.id='ready';d.style.color='white';d.textContent='loaded';document.body.appendChild(d)},300)</script>
</body></html>`

    const result = await browserPreviewHtmlTool.execute({ html, selector: "#ready", waitMs: 100 }) as any

    expect(result.ok).toBe(true)
    expect(typeof result.imageBase64).toBe("string")
  }, 30_000)
})

describe("browser_screenshot — real render", () => {
  itReal("screenshots an HTTP URL served locally", async () => {
    const html = `<!DOCTYPE html><html><body style="background:green;color:white"><h1>Screenshot Test</h1></body></html>`
    const server = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) })

    try {
      const result = await browserScreenshotTool.execute({ url: `http://localhost:${server.port}/` }) as any
      expect(result.ok).toBe(true)
      expect(typeof result.imageBase64).toBe("string")
      expect(result.imageBase64.length).toBeGreaterThan(500)
    } finally {
      server.stop()
    }
  }, 30_000)
})
