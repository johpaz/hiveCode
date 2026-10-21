/**
 * Lectura de los argumentos con forma `--nombre valor`.
 *
 * Se aceptan las dos formas habituales: `--nombre valor` y `--nombre=valor`.
 */
import { ErrorInventario } from "./errores"

/** Opciones leídas de la línea de comandos, por nombre sin los `--`. */
export type Flags = Record<string, string | undefined>

/**
 * Convierte los tokens que quedan después de un comando en sus opciones.
 *
 * Un token que no es una opción es un error: así `add --precio 5 sucio` no
 * se ignora en silencio.
 */
export function analizarFlags(tokens: string[]): Flags {
  const flags: Flags = {}

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!

    if (!token.startsWith("--")) {
      throw new ErrorInventario(`argumento inesperado: "${token}"`)
    }

    const cuerpo = token.slice(2)
    if (cuerpo === "") throw new ErrorInventario(`opción inválida: "${token}"`)

    const igual = cuerpo.indexOf("=")
    if (igual >= 0) {
      const nombre = cuerpo.slice(0, igual)
      if (nombre === "") throw new ErrorInventario(`opción inválida: "${token}"`)
      flags[nombre] = cuerpo.slice(igual + 1)
      continue
    }

    const valor = tokens[i + 1]
    if (valor === undefined) throw new ErrorInventario(`falta el valor de --${cuerpo}`)
    // Un valor que empieza por `--` es otra opción, no el valor buscado.
    if (valor.startsWith("--")) throw new ErrorInventario(`falta el valor de --${cuerpo}`)

    flags[cuerpo] = valor
    i++
  }

  return flags
}

/** El valor de una opción obligatoria. */
export function requerido(flags: Flags, nombre: string): string {
  const valor = flags[nombre]
  if (valor === undefined) throw new ErrorInventario(`falta el argumento obligatorio --${nombre}`)
  return valor
}
