/**
 * Parser tolerante para JSON cortado a mitad de un stream (argumentos de tool call).
 * Cierra strings, arrays y objetos abiertos y descarta una clave o valor a medias.
 * Devuelve `undefined` si ni siquiera así se puede interpretar.
 */
export function parsePartialJson(text: string): unknown {
  const src = text.trim()
  if (!src) return undefined
  try {
    return JSON.parse(src)
  } catch { /* sigue: está incompleto */ }

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of src) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      continue
    }
    if (ch === "\"") inString = true
    else if (ch === "{") stack.push("}")
    else if (ch === "[") stack.push("]")
    else if ((ch === "}" || ch === "]") && stack.length) stack.pop()
  }

  let out = src
  if (inString) {
    // Un escape cortado (`\` o `\u12`) no se puede cerrar: lo recortamos.
    if (escaped) out = out.slice(0, -1)
    out = out.replace(/\\u[0-9a-fA-F]{0,3}$/, "")
    out += "\""
  }
  // Quita restos que no forman un valor válido: coma colgante, `"clave":` sin valor, `"clave"` sin dos puntos.
  for (;;) {
    const trimmed = out.replace(/\s+$/, "")
    const next = trimmed
      .replace(/,$/, "")
      .replace(/,\s*"(?:[^"\\]|\\.)*"\s*:$/, "")
      .replace(/\{\s*"(?:[^"\\]|\\.)*"\s*:$/, "{")
      .replace(/,\s*"(?:[^"\\]|\\.)*"$/, (m, off) => (isKeyPosition(trimmed, off) ? "" : m))
      .replace(/:\s*(?:-|tru|fals|nul|tr|fa|nu|t|f|n)$/, "")
    if (next === out) break
    out = next
  }
  try {
    return JSON.parse(out + stack.reverse().join(""))
  } catch {
    return undefined
  }
}

/** `, "x"` es una clave (no un elemento de array) si el contenedor abierto más cercano es un objeto. */
function isKeyPosition(text: string, commaOffset: number): boolean {
  let depth: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < commaOffset; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      continue
    }
    if (ch === "\"") inString = true
    else if (ch === "{" || ch === "[") depth.push(ch)
    else if (ch === "}" || ch === "]") depth.pop()
  }
  return depth[depth.length - 1] === "{"
}
