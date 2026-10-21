/**
 * Los cinco comandos del CLI.
 *
 * Cada función recibe el inventario ya leído y devuelve lo que hay que
 * imprimir. Si algo no valida, lanza `ErrorInventario` y el inventario se
 * queda como estaba: solo quien llama guarda el archivo, y solo cuando el
 * comando ha terminado bien.
 */
import { ErrorInventario } from "./errores"
import type { Flags } from "./args"
import { requerido } from "./args"
import type { BaseDeDatos, Producto } from "./tipos"
import { validarNombre, validarPrecio, validarStock } from "./validacion"

/** Añade un producto y lo devuelve. */
export function agregar(db: BaseDeDatos, flags: Flags): Producto {
  const nombre = validarNombre(requerido(flags, "nombre"))
  const precio = validarPrecio(requerido(flags, "precio"))
  const stock = validarStock(requerido(flags, "stock"))

  if (nombreDuplicado(db, nombre)) {
    throw new ErrorInventario(`ya existe un producto llamado "${nombre}"`)
  }

  const producto: Producto = { id: db.next, nombre, precio, stock }
  db.next += 1
  db.items.push(producto)
  return producto
}

/** Todos los productos, ordenados por id. */
export function listar(db: BaseDeDatos): Producto[] {
  return [...db.items].sort((a, b) => a.id - b.id)
}

/**
 * Cambia los campos indicados y devuelve el producto completo.
 *
 * Los campos que no se pasan se quedan como estaban.
 */
export function actualizar(db: BaseDeDatos, id: number, flags: Flags): Producto {
  const original = db.items.find((p) => p.id === id)
  if (!original) throw new ErrorInventario(`no existe un producto con id ${id}`)

  // Se validan todos los cambios antes de tocar nada: si uno falla, el
  // producto queda como estaba.
  const nombre = flags.nombre === undefined ? undefined : validarNombre(flags.nombre)
  if (nombre !== undefined && nombreDuplicado(db, nombre, id)) {
    throw new ErrorInventario(`ya existe un producto llamado "${nombre}"`)
  }
  const precio = flags.precio === undefined ? undefined : validarPrecio(flags.precio)
  const stock = flags.stock === undefined ? undefined : validarStock(flags.stock)

  const actualizado: Producto = {
    id: original.id,
    nombre: nombre ?? original.nombre,
    precio: precio ?? original.precio,
    stock: stock ?? original.stock,
  }
  db.items[db.items.indexOf(original)] = actualizado
  return actualizado
}

/** Borra un producto y confirma cuál se borró. */
export function eliminar(db: BaseDeDatos, id: number): { deleted: number } {
  const indice = db.items.findIndex((p) => p.id === id)
  if (indice < 0) throw new ErrorInventario(`no existe un producto con id ${id}`)

  db.items.splice(indice, 1)
  // `db.next` no se toca: el id borrado no vuelve a usarse.
  return { deleted: id }
}

/** Los productos cuyo nombre contiene el texto, sin distinguir mayúsculas. */
export function buscar(db: BaseDeDatos, texto: string): Producto[] {
  const objetivo = texto.trim()
  if (objetivo === "") throw new ErrorInventario("falta el texto a buscar")

  const minuscula = objetivo.toLowerCase()
  return listar(db).filter((p) => p.nombre.toLowerCase().includes(minuscula))
}

/** ¿Hay ya un producto con ese nombre? `exceptoId` deja fuera al propio. */
function nombreDuplicado(db: BaseDeDatos, nombre: string, exceptoId?: number): boolean {
  const objetivo = nombre.toLowerCase()
  return db.items.some(
    (p) => p.id !== exceptoId && p.nombre.trim().toLowerCase() === objetivo,
  )
}
