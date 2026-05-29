/**
 * Unit tests for browser preview tools.
 * Only schema/metadata is verified here — actual WebView execution requires
 * a graphical display and is covered in integration tests.
 */
import { describe, test, expect } from "bun:test"
import { browserPreviewHtmlTool, browserScreenshotTool, browserCaptureClipboardTool } from "@johpaz/hivecode-core/tools"

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
