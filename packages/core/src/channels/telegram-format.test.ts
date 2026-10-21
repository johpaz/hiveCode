import { describe, expect, test } from "bun:test"
import { chunkForTelegram, isBalancedHtml, markdownToTelegramHtml, telegramMessageChunks } from "./telegram-format"

describe("markdownToTelegramHtml", () => {
  test("escapes what the model wrote before adding tags", () => {
    expect(markdownToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d")
    expect(markdownToTelegramHtml("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;")
  })

  test("headings, bold, italic, strikethrough, bullets and links", () => {
    const html = markdownToTelegramHtml("## Título\n- uno **dos**\n* *tres*\n~~viejo~~ [docs](https://ex.com/a?b=1&c=2)")
    expect(html).toContain("<b>Título</b>")
    expect(html).toContain("• uno <b>dos</b>")
    expect(html).toContain("• <i>tres</i>")
    expect(html).toContain("<s>viejo</s>")
    expect(html).toContain('<a href="https://ex.com/a?b=1&amp;c=2">docs</a>')
    expect(isBalancedHtml(html)).toBe(true)
  })

  test("code is kept verbatim and escaped, and never reformatted", () => {
    const html = markdownToTelegramHtml("usa `a<b && **x**` y\n```ts\nconst s = '**no**' < 1\n```")
    expect(html).toContain("<code>a&lt;b &amp;&amp; **x**</code>")
    expect(html).toContain("<pre><code>const s = '**no**' &lt; 1</code></pre>")
  })

  test("snake_case and file names are not italicised", () => {
    const html = markdownToTelegramHtml("mira task_delegate y my_file_name.ts")
    expect(html).toBe("mira task_delegate y my_file_name.ts")
  })

  test("a markdown table is shown monospaced, without the separator row", () => {
    const html = markdownToTelegramHtml("| a | b |\n|---|---|\n| 1 | 2 |")
    expect(html).toBe("<pre>| a | b |\n| 1 | 2 |</pre>")
  })

  test("formatting that Telegram would reject falls back to escaped plain text", () => {
    const out = markdownToTelegramHtml("**negrita que no cierra\n\ny <b>cruda")
    expect(isBalancedHtml(out)).toBe(true)
    expect(out).not.toContain("<b>")
    expect(out).toContain("&lt;b&gt;cruda")
  })

  test("every conversion of arbitrary markup-ish text is balanced", () => {
    const samples = ["***a** b*", "_a **b_ c**", "`x` **`y`** _`z`_", "# **t**\n- *a **b***", "[**x**](https://e.com) __y__"]
    for (const sample of samples) expect(isBalancedHtml(markdownToTelegramHtml(sample))).toBe(true)
  })
})

describe("chunkForTelegram", () => {
  test("short text is one chunk; long text stays under the limit", () => {
    expect(chunkForTelegram("hola")).toEqual(["hola"])
    const long = Array.from({ length: 400 }, (_, i) => `línea ${i} con algo de texto`).join("\n")
    const chunks = chunkForTelegram(long, 500)
    expect(chunks.length).toBeGreaterThan(5)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500)
    expect(chunks.join("\n").replace(/\s+/g, " ")).toContain("línea 399")
  })

  test("a code block cut in two is closed and reopened, so each chunk converts cleanly", () => {
    const code = "```ts\n" + Array.from({ length: 200 }, (_, i) => `const v${i} = ${i} < 2`).join("\n") + "\n```"
    const chunks = chunkForTelegram(`antes\n${code}\ndespués`, 600)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0)
      expect(isBalancedHtml(markdownToTelegramHtml(chunk))).toBe(true)
      expect(markdownToTelegramHtml(chunk).length).toBeLessThan(4096)
    }
  })

  test("the HTML of a default-size chunk fits Telegram's limit even when every character is escaped", () => {
    const chunks = telegramMessageChunks("<".repeat(10_000))
    for (const chunk of chunks) expect(markdownToTelegramHtml(chunk).length).toBeLessThanOrEqual(4096)
  })
})
