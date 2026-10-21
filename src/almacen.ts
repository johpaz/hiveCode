/**
 * Lectura y escritura del archivo de datos.
 *
 * La ruta sale de `INVENTARIO_DATA` y, si no está, es `./inventario.json`
 * (relativa al directorio de trabajo). Si el archivo no existe, el
 * inventario está vacío: se empieza a escribir cuando hay algo que guardar.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ErrorInventario, mensajeDe } from "./errores"
import type { BaseDeDatos, Producto } from "./tipos"

/** Ruta usada cuando `INVENTARIO_DATA` no está definida. */
export const RUTA_POR_DEFECTO = "./inventario.json"

/** Ruta del archivo de datos que usa esta ejecución. */
export function rutaDatos(): string {
  const desdeEntorno = process.env.INVENTARIO_DATA
  if (desdeEntorno && desdeEntorno.trim() !== "") return desdeEntorno.trim()
  return RUTA_POR_DEFECTO
}

/**
 * Lee el archivo de datos.
 *
 * Acepta el formato que escribe este CLI (`{ next, items }`) y también un
 * arreglo plano de productos, por si alguien dejó el archivo a mano.
 */
export function cargar(ruta: string): BaseDeDatos {
  if (!existsSync(ruta)) return { next: 1, items: [] }

  let texto: string
  try {
    texto = readFileSync(ruta, "utf-8")
  } catch (error) {
    throw new ErrorInventario(`no se pudo leer "${ruta}": ${mensajeDe(error)}`)
  }
  if (texto.trim() === "") return { next: 1, items: [] }

  let datos: unknown
  try {
    datos = JSON.parse(texto)
  } catch {
    throw new ErrorInventario(`"${ruta}" no contiene JSON válido`)
  }
  return normalizar(datos)
}

/** Guarda el inventario. El archivo se escribe entero o no se toca. */
export function guardar(ruta: string, db: BaseDeDatos): void {
  const contenido = JSON.stringify(db, null, 2) + "\n"

  try {
    const carpeta = dirname(ruta)
    if (carpeta && carpeta !== ".") mkdirSync(carpeta, { recursive: true })
  } catch (error) {
    throw new ErrorInventario(`no se pudo preparar la carpeta de "${ruta}": ${mensajeDe(error)}`)
  }

  // Se escribe primero en un temporal y se renombra: si algo se corta a mitad,
  // el archivo bueno sigue intacto.
  const temporal = `${ruta}.tmp-${process.pid}`
  try {
    writeFileSync(temporal, contenido, "utf-8")
    renameSync(temporal, ruta)
  } catch (error) {
    try {
      unlinkSync(temporal)
    } catch {
      // nada que hacer: el temporal ya no está o no se pudo borrar
    }
    throw new ErrorInventario(`no se pudo guardar "${ruta}": ${mensajeDe(error)}`)
  }
}

/** Convierte lo leído del archivo en un inventario usable. */
function normalizar(datos: unknown): BaseDeDatos {
  const lista: unknown = Array.isArray(datos)
    ? datos
    : datos && typeof datos === "object"
      ? (datos as { items?: unknown }).items
      : undefined
  const items = Array.isArray(lista) ? lista.map(aProducto).filter((p): p is Producto => p !== null) : []

  const declarado =
    !Array.isArray(datos) && datos && typeof datos === "object"
      ? (datos as { next?: unknown }).next
      : undefined
  const siguiente = siguienteId(items)
  const next =
    typeof declarado === "number" && Number.isInteger(declarado) && declarado > siguiente
      ? declarado
      : siguiente

  return { next, items }
}

/** El id que sigue a los productos guardados. */
function siguienteId(items: Producto[]): number {
  let maximo = 0
  for (const producto of items) if (producto.id > maximo) maximo = producto.id
  return maximo + 1
}

/** Un producto del archivo, o `null` si no es un producto válido. */
function aProducto(valor: unknown): Producto | null {
  if (!valor || typeof valor !== "object") return null
  const bruto = valor as Record<string, unknown>

  const id = bruto.id
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null
  if (typeof bruto.nombre !== "string") return null

  return {
    id,
    nombre: bruto.nombre.trim(),
    precio: numero(bruto.precio),
    stock: numero(bruto.stock),
  }
}

/** Un número finito, o 0 si el valor no lo es. */
function numero(valor: unknown): number {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : 0
}
