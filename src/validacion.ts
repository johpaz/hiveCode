/**
 * Validaciones de los datos de un producto.
 *
 * Todas lanzan `ErrorInventario`: el CLI las convierte en un mensaje por
 * stderr y un código de salida 1, sin tocar el archivo de datos.
 */
import { ErrorInventario } from "./errores"

/** Un número decimal escrito como texto: `12`, `12.5`, `.5`, `1e3`. */
const NUMERO = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** Nombre obligatorio: se recorta y no puede quedar vacío. */
export function validarNombre(bruto: string): string {
  const nombre = bruto.trim()
  if (nombre === "") throw new ErrorInventario("el nombre no puede estar vacío")
  return nombre
}

/** Precio: número mayor o igual que 0. */
export function validarPrecio(bruto: string): number {
  const precio = numero(bruto)
  if (precio === undefined) throw new ErrorInventario(`el precio no es un número: "${bruto}"`)
  if (precio < 0) throw new ErrorInventario("el precio no puede ser negativo")
  return precio
}

/** Stock: número entero mayor o igual que 0. */
export function validarStock(bruto: string): number {
  const stock = numero(bruto)
  if (stock === undefined) throw new ErrorInventario(`el stock no es un número: "${bruto}"`)
  if (!Number.isInteger(stock)) throw new ErrorInventario("el stock debe ser un número entero")
  if (stock < 0) throw new ErrorInventario("el stock no puede ser negativo")
  return stock
}

/** Id: entero positivo. */
export function validarId(bruto: string): number {
  const id = numero(bruto)
  if (id === undefined || !Number.isInteger(id) || id < 1) {
    throw new ErrorInventario(`id inválido: "${bruto}"`)
  }
  return id
}

/** Un número escrito como texto, o `undefined` si no lo es. */
function numero(bruto: string): number | undefined {
  const texto = bruto.trim()
  if (!NUMERO.test(texto)) return undefined
  const valor = Number(texto)
  return Number.isFinite(valor) ? valor : undefined
}
