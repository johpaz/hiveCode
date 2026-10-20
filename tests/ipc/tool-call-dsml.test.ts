import { describe, it, expect } from "bun:test"
import { extractToolCallsFromText } from "@johpaz/hivecode-core/agent/llm-providers/openai-compat-base"

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

  it("no toca un texto sin DSML", () => {
    const out = extractToolCallsFromText("Hola, ¿en qué te ayudo?", new Map())
    expect(out).toEqual({ content: "Hola, ¿en qué te ayudo?", tool_calls: [] })
  })
})
