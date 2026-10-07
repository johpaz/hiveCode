import { describe, it, expect } from "bun:test"
import { extractToolCallsFromText } from "@johpaz/hivecode-core/agent/llm-providers/openai-compat-base"

// ─── El XML de tool call no debe verse nunca en el chat ──────────────────────
//
// Lo que se veía en la TUI:
//
//     <tool_call>
//     <function>fs_list
//     <parameter>path
//     .
//     </parameter>
//     </function>
//     </tool_call>
//
// El parser existente solo aceptaba **JSON** entre las etiquetas
// (`<tool_call>{...}</tool_call>`). Este formato, que es el nativo de Mistral
// y de sus derivados, no matchea: la llamada nunca se extraía y el XML se
// quedaba en `content`, que es lo que se renderiza en el chat.
//
// Estos tests fijan que el XML se convierta en tool calls reales y que el texto
// que llega al chat sea solo narración.

const ZWSP = "\u200b"

/** El bloque tal cual lo emitía el modelo en la captura. */
const MISTRAL_BLOCKS = [
  {
    tool: "fs_list",
    args: { path: "." },
    block: `<${ZWSP}tool_call>\n<function>fs_list\n<parameter>path\n.\n</parameter>\n</function>\n</${ZWSP}tool_call>`,
  },
  {
    tool: "fs_read",
    args: { path: "README.md" },
    block: `<${ZWSP}tool_call>\n<function>fs_read\n<parameter>path\nREADME.md\n</parameter>\n</function>\n</${ZWSP}tool_call>`,
  },
]

describe("formato nativo de tool call (Mistral y derivados)", () => {
  it("extrae la llamada que antes se quedaba como XML crudo", () => {
    const texto = `Voy a explorar el proyecto.\n\n${MISTRAL_BLOCKS[0].block}`
    const { content, tool_calls } = extractToolCallsFromText(texto, new Map())

    expect(tool_calls).toHaveLength(1)
    expect(tool_calls[0].function.name).toBe("fs_list")
    expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ path: "." })
    // Y el XML desaparece del texto que va al chat.
    expect(content).not.toContain("tool_call")
    expect(content).not.toContain("function")
    expect(content).toBe("Voy a explorar el proyecto.")
  })

  it("el texto que llega al chat es narración, no protocolo", () => {
    // Esta es la queja: el usuario lee la narración, no el marcado.
    const texto = `El proyecto tiene tres módulos.\n${MISTRAL_BLOCKS[1].block}`
    const { content } = extractToolCallsFromText(texto, new Map())
    expect(content).toBe("El proyecto tiene tres módulos.")
  })

  it("extrae varias llamadas consecutivas", () => {
    const texto = MISTRAL_BLOCKS.map(b => b.block).join("\n")
    const { content, tool_calls } = extractToolCallsFromText(texto, new Map())

    expect(tool_calls.map(c => c.function.name)).toEqual(["fs_list", "fs_read"])
    expect(content.trim()).toBe("")
  })

  it("lee varios parámetros de la misma llamada", () => {
    const texto = `<${ZWSP}tool_call>
<function>fs_edit
<parameter>path
src/a.ts
</parameter>
<parameter>content
export const x = 1
</parameter>
</function>
</${ZWSP}tool_call>`
    const { tool_calls } = extractToolCallsFromText(texto, new Map())

    expect(tool_calls).toHaveLength(1)
    const args = JSON.parse(tool_calls[0].function.arguments)
    expect(args.path).toBe("src/a.ts")
    expect(args.content).toBe("export const x = 1")
  })

  it("lee la variante con atributos", () => {
    // Los templates de chat varian entre si aunque el modelo sea el mismo.
    const texto = `<${ZWSP}tool_call>
<function name="shell_executor">
<parameter name="command">bun test</parameter>
</function>
</${ZWSP}tool_call>`
    const { tool_calls } = extractToolCallsFromText(texto, new Map())

    expect(tool_calls[0].function.name).toBe("shell_executor")
    expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ command: "bun test" })
  })

  it("lee la variante con [TOOL_CALL] y atributo directo", () => {
    const texto = `<${ZWSP}tool_call>[TOOL_CALL] <function=web_search><parameter=query>jev hivecode</parameter></function>[/TOOL_CALL]</${ZWSP}tool_call>`
    const { tool_calls } = extractToolCallsFromText(texto, new Map())

    expect(tool_calls[0].function.name).toBe("web_search")
    expect(JSON.parse(tool_calls[0].function.arguments)).toEqual({ query: "jev hivecode" })
  })

  it("aplica el mapa de nombres que exige el provider", () => {
    // Algunos providers no aceptan puntos; el mapa los renombra.
    const map = new Map([["fs.list", "fs_list"]])
    const texto = `<${ZWSP}tool_call>\n<function>fs.list\n<parameter>path\n.\n</parameter>\n</function>\n</${ZWSP}tool_call>`
    const { tool_calls } = extractToolCallsFromText(texto, map)
    expect(tool_calls[0].function.name).toBe("fs_list")
  })

  it("descarta un bloque sin nombre de función en vez de inventarlo", () => {
    const texto = `<${ZWSP}tool_call>\n<parameter>path\n.\n</parameter>\n</${ZWSP}tool_call>`
    const { content, tool_calls } = extractToolCallsFromText(texto, new Map())
    expect(tool_calls).toHaveLength(0)
    // Sin llamada que lo consuma, el bloque se queda: borrarlo sería perder
    // texto del modelo sin razón.
    expect(content).toContain("tool_call")
  })

  it("no rompe el parser de JSON que ya existía", () => {
    const texto = `Voy a buscar.\n<${ZWSP}tool_call>{"name":"fs_read","arguments":{"path":"a.ts"}}</${ZWSP}tool_call>`
    const { content, tool_calls } = extractToolCallsFromText(texto, new Map())

    expect(tool_calls).toHaveLength(1)
    expect(tool_calls[0].function.name).toBe("fs_read")
    expect(content).toBe("Voy a buscar.")
  })

  it("un mensaje que era solo XML no produce una entrada vacía en el chat", () => {
    const { content } = extractToolCallsFromText(MISTRAL_BLOCKS[0].block, new Map())
    // Una línea vacía en el chat parece un bug; mejor que no haya línea.
    expect(content).toBe("")
  })

  it("no toca texto normal que mentiona palabras sueltas", () => {
    const texto = "La función `function_call` no existe aquí. Uso fs_read normalmente."
    const { content, tool_calls } = extractToolCallsFromText(texto, new Map())
    expect(tool_calls).toHaveLength(0)
    expect(content).toBe(texto)
  })

  it("sobrevive a un bloque sin cerrar", () => {
    // Un corte por `max_tokens` deja el XML a medias: no debe romper el turno.
    const texto = `Analizo.\n${ZWSP}tool_call>\n<function>fs_read\n<parameter>path\nRE`
    const { content, tool_calls } = extractToolCallsFromText(texto, new Map())
    expect(tool_calls).toHaveLength(0)
    expect(content).toContain("Analizo.")
  })
})