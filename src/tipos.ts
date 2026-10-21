/**
 * Tipos del inventario.
 *
 * Un producto es `{ id, nombre, precio, stock }`. El `id` lo asigna el CLI:
 * enteros que empiezan en 1 y nunca se reutilizan.
 */

/** Un producto del inventario. */
export interface Producto {
  id: number
  nombre: string
  precio: number
  stock: number
}

/**
 * El archivo de datos guarda el siguiente id aparte de los productos.
 *
 * Si el contador viviera solo en los productos, borrar el último dejaría la
 * lista vacía y el siguiente `add` volvería a usar el id 1. Guardándolo
 * aparte, los ids siguen creciendo aunque no quede ningún producto.
 */
export interface BaseDeDatos {
  /** Id que se asignará al próximo producto creado. */
  next: number
  /** Productos guardados. */
  items: Producto[]
}
