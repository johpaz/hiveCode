import { describe, it, expect } from "bun:test"
import { extractToolCallsFromText, stripDsmlBlocks } from "@johpaz/hivecode-core/agent/llm-providers/openai-compat-base"

// DeepSeek emite sus llamadas en DSML cuando el servidor no las convierte a
// tool_calls. Sin parser, el bloque se veía crudo en la TUI y la herramienta
// nunca se ejecutaba.

const B = "｜"
const file = "export const a = 1\n\nconsole.log(`a: ${a}`)\n"
const block = (bar = B) =>
  `Voy a escribir el archivo.\n<${bar}DSML${bar}function_calls>\n` +
  `<${bar}DSML${bar}invoke name="fs_write">\n` +
  `<${bar}DSML${bar}parameter name="path" string="true">src/a.ts</${bar}DSML${bar}parameter>\n` +
  `<${bar}DSML${bar}parameter name="content" string="true">${file}</${bar}DSML${bar}parameter>\n` +
  `<${bar}DSML${bar}parameter name="overwrite" string="false">true</${bar}DSML${bar}parameter>\n` +
  `</${bar}DSML${bar}invoke>\n` +
  `<${bar}DSML${bar}invoke name="fs_read">\n` +
  `<${bar}DSML${bar}parameter name="path" string="true">package.json</${bar}DSML${bar}parameter>\n` +
  `</${bar}DSML${bar}invoke>\n` +
  `</${bar}DSML${bar}function_calls>`

describe("formato DSML de DeepSeek", () => {
  for (const [label, bar] of [["barra de ancho completo", B], ["barra ASCII", "|"]] as const) {
    it(`extrae las llamadas (${label}) y deja sólo la narración`, () => {
      const { content, tool_calls } = extractToolCallsFromText(block(bar), new Map())
      expect(content).toBe("Voy a escribir el archivo.")
      expect(tool_calls.map(c => c.function.name)).toEqual(["fs_write", "fs_read"])
      const args = JSON.parse(tool_calls[0].function.arguments)
      expect(args.path).toBe("src/a.ts")
      // El código del archivo llega tal cual: saltos de línea y espacios intactos.
      expect(args.content).toBe(file)
      // string="false" es JSON, no texto.
      expect(args.overwrite).toBe(true)
    })
  }

  it("acepta un bloque cortado sin el cierre de function_calls", () => {
    const cut = block().replace(`</${B}DSML${B}function_calls>`, "")
    expect(extractToolCallsFromText(cut, new Map()).tool_calls).toHaveLength(2)
  })

  it("acepta la variante real de DeepSeek: barra doble, espacio tras la barra y envoltorio `calls`", () => {
    // Texto copiado de una corrida real con deepseek-flash.
    const drift =
      `<${B}${B}DSML${B}${B} calls>\n` +
      `<${B}${B}DSML${B}${B} invoke name="fs_read">\n` +
      `<${B}${B}DSML${B}${B} parameter name="path" string="true">hola.txt</${B}${B}DSML${B}${B} parameter>\n` +
      `</${B}${B}DSML${B}${B} invoke>\n` +
      `</${B}${B}DSML${B}${B} calls>`
    const { content, tool_calls } = extractToolCallsFromText(drift, new Map())
    expect(content).toBe("")
    expect(tool_calls).toHaveLength(1)
    expect(tool_calls[0].function.name).toBe("fs_read")
    expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ path: "hola.txt" })
  })

  it("acepta `tool_calls` como envoltorio", () => {
    const wrapped = block().replaceAll("function_calls", "tool_calls")
    expect(extractToolCallsFromText(wrapped, new Map()).tool_calls).toHaveLength(2)
  })

  it("stripDsmlBlocks quita el marcado de un texto sin herramientas que ejecutarlo", () => {
    const text = `Resumen del estado.\n${block().split("\n").slice(1).join("\n")}`
    expect(stripDsmlBlocks(text)).toBe("Resumen del estado.")
    expect(stripDsmlBlocks("sin marcado")).toBe("sin marcado")
  })

  it("no toca un texto sin DSML", () => {
    const out = extractToolCallsFromText("Hola, ¿en qué te ayudo?", new Map())
    expect(out).toEqual({ content: "Hola, ¿en qué te ayudo?", tool_calls: [] })
  })
})

describe("HIVE_LLM_RAW_LOG", () => {
  const { mkdtempSync, readFileSync, existsSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const { join } = require("node:path") as typeof import("node:path")

  it("records tool markup with how many calls were recovered, and nothing else", async () => {
    const { logToolMarkup } = await import("@johpaz/hivecode-core/agent/llm-providers/openai-compat-base")
    const file = join(mkdtempSync(join(tmpdir(), "hive-rawlog-")), "raw.jsonl")
    process.env.HIVE_LLM_RAW_LOG = file
    try {
      logToolMarkup("deepseek", "m", block(), 2)
      logToolMarkup("deepseek", "m", "una respuesta normal sin herramientas", 0)
      logToolMarkup("deepseek", "m", `<${B}${B}DSML${B}${B} algo nuevo>`, 0, true)

      const lines = readFileSync(file, "utf-8").trim().split("\n").map(l => JSON.parse(l))
      expect(lines).toHaveLength(2)
      expect(lines.map(l => l.parsed)).toEqual([2, 0])
      expect(lines[1].raw).toContain("algo nuevo")
      expect(lines[1].toolsOffered).toBe(true)
    } finally {
      delete process.env.HIVE_LLM_RAW_LOG
    }
  })

  it("does nothing without the variable", async () => {
    const { logToolMarkup } = await import("@johpaz/hivecode-core/agent/llm-providers/openai-compat-base")
    delete process.env.HIVE_LLM_RAW_LOG
    expect(() => logToolMarkup("deepseek", "m", block(), 2)).not.toThrow()
  })
})
