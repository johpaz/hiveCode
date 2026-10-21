/**
 * Pruebas de las piezas del CLI: validaciones, lectura de argumentos,
 * archivo de datos y comandos.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { analizarFlags, requerido } from "../../src/args"
import { cargar, guardar } from "../../src/almacen"
import { agregar, actualizar, buscar, eliminar, listar } from "../../src/comandos"
import { ErrorInventario } from "../../src/errores"
import type { BaseDeDatos } from "../../src/tipos"
import { validarId, validarNombre, validarPrecio, validarStock } from "../../src/validacion"

let carpeta = ""
let ruta = ""

beforeEach(() => {
  carpeta = mkdtempSync(join(tmpdir(), "inventario-unidad-"))
  ruta = join(carpeta, "datos.json")
})

afterEach(() => {
  rmSync(carpeta, { recursive: true, force: true })
})

const dbVacia = (): BaseDeDatos => ({ next: 1, items: [] })

describe("validación", () => {
  test("el nombre se recorta y no puede quedar vacío", () => {
    expect(validarNombre("  Teclado  ")).toBe("Teclado")
    expect(() => validarNombre("   ")).toThrow(ErrorInventario)
    expect(() => validarNombre("")).toThrow(ErrorInventario)
  })

  test("el precio es un número mayor o igual que 0", () => {
    expect(validarPrecio("25.5")).toBe(25.5)
    expect(validarPrecio("0")).toBe(0)
    expect(() => validarPrecio("-1")).toThrow(ErrorInventario)
    expect(() => validarPrecio("abc")).toThrow(ErrorInventario)
    expect(() => validarPrecio("")).toThrow(ErrorInventario)
    expect(() => validarPrecio("Infinity")).toThrow(ErrorInventario)
  })

  test("el stock es un entero mayor o igual que 0", () => {
    expect(validarStock("10")).toBe(10)
    expect(validarStock("0")).toBe(0)
    expect(() => validarStock("1.5")).toThrow(ErrorInventario)
    expect(() => validarStock("-3")).toThrow(ErrorInventario)
    expect(() => validarStock("muchos")).toThrow(ErrorInventario)
  })

  test("el id es un entero positivo", () => {
    expect(validarId("1")).toBe(1)
    expect(() => validarId("0")).toThrow(ErrorInventario)
    expect(() => validarId("-1")).toThrow(ErrorInventario)
    expect(() => validarId("1.5")).toThrow(ErrorInventario)
    expect(() => validarId("abc")).toThrow(ErrorInventario)
  })
})

describe("argumentos", () => {
  test("lee las opciones con valor delante y con equals", () => {
    expect(analizarFlags(["--nombre", "Teclado", "--precio=5"])).toEqual({
      nombre: "Teclado",
      precio: "5",
    })
  })

  test("acepta valores negativos", () => {
    expect(analizarFlags(["--precio", "-1"])).toEqual({ precio: "-1" })
  })

  test("rechaza un argumento suelto", () => {
    expect(() => analizarFlags(["sucio"])).toThrow(ErrorInventario)
  })

  test("rechaza una opción sin valor", () => {
    expect(() => analizarFlags(["--nombre"])).toThrow(ErrorInventario)
    expect(() => analizarFlags(["--nombre", "--precio", "1"])).toThrow(ErrorInventario)
  })

  test("una opción obligatoria que falta es un error", () => {
    expect(requerido({ nombre: "X" }, "nombre")).toBe("X")
    expect(() => requerido({}, "nombre")).toThrow(ErrorInventario)
  })
})

describe("archivo de datos", () => {
  test("si no existe, el inventario está vacío", () => {
    expect(cargar(ruta)).toEqual({ next: 1, items: [] })
  })

  test("lee lo que escribió el CLI", () => {
    guardar(ruta, { next: 2, items: [{ id: 1, nombre: "Teclado", precio: 5, stock: 1 }] })
    expect(cargar(ruta)).toEqual({ next: 2, items: [{ id: 1, nombre: "Teclado", precio: 5, stock: 1 }] })
  })

  test("acepta un arreglo plano de productos", () => {
    writeFileSync(ruta, JSON.stringify([{ id: 1, nombre: "Teclado", precio: 5, stock: 1 }]))
    expect(cargar(ruta)).toEqual({ next: 2, items: [{ id: 1, nombre: "Teclado", precio: 5, stock: 1 }] })
  })

  test("un archivo que no es JSON es un error", () => {
    writeFileSync(ruta, "{ esto no es json")
    expect(() => cargar(ruta)).toThrow(ErrorInventario)
  })

  test("guardar deja el archivo escrito", () => {
    guardar(ruta, { next: 1, items: [] })
    expect(JSON.parse(readFileSync(ruta, "utf-8"))).toEqual({ next: 1, items: [] })
  })
})

describe("comandos", () => {
  test("agregar asigna ids crecientes", () => {
    const db = dbVacia()
    expect(agregar(db, { nombre: "A", precio: "1", stock: "1" }).id).toBe(1)
    expect(agregar(db, { nombre: "B", precio: "2", stock: "2" }).id).toBe(2)
    expect(db.next).toBe(3)
  })

  test("agregar no admite nombres repetidos", () => {
    const db = dbVacia()
    agregar(db, { nombre: "Teclado", precio: "1", stock: "1" })
    expect(() => agregar(db, { nombre: "TECLADO", precio: "1", stock: "1" })).toThrow(ErrorInventario)
    expect(db.items).toHaveLength(1)
  })

  test("agregar exige nombre, precio y stock", () => {
    const db = dbVacia()
    expect(() => agregar(db, { precio: "1", stock: "1" })).toThrow(ErrorInventario)
    expect(() => agregar(db, { nombre: "X", stock: "1" })).toThrow(ErrorInventario)
    expect(() => agregar(db, { nombre: "X", precio: "1" })).toThrow(ErrorInventario)
  })

  test("listar ordena por id", () => {
    const db = dbVacia()
    agregar(db, { nombre: "B", precio: "1", stock: "1" })
    agregar(db, { nombre: "A", precio: "2", stock: "2" })
    db.items.reverse()
    expect(listar(db).map((p) => p.id)).toEqual([1, 2])
  })

  test("actualizar cambia solo lo indicado", () => {
    const db = dbVacia()
    agregar(db, { nombre: "Teclado", precio: "10", stock: "5" })
    const producto = actualizar(db, 1, { precio: "12.5" })
    expect(producto).toEqual({ id: 1, nombre: "Teclado", precio: 12.5, stock: 5 })
  })

  test("actualizar un id que no existe es un error", () => {
    const db = dbVacia()
    expect(() => actualizar(db, 42, { precio: "1" })).toThrow(ErrorInventario)
  })

  test("actualizar puede dejar el mismo nombre con otra capitalización", () => {
    const db = dbVacia()
    agregar(db, { nombre: "Teclado", precio: "10", stock: "5" })
    expect(actualizar(db, 1, { nombre: "TECLADO" }).nombre).toBe("TECLADO")
  })

  test("eliminar borra el producto y no libera el id", () => {
    const db = dbVacia()
    agregar(db, { nombre: "A", precio: "1", stock: "1" })
    agregar(db, { nombre: "B", precio: "2", stock: "2" })

    expect(eliminar(db, 2)).toEqual({ deleted: 2 })
    expect(db.items.map((p) => p.id)).toEqual([1])
    expect(db.next).toBe(3)
  })

  test("eliminar un id que no existe es un error", () => {
    expect(() => eliminar(dbVacia(), 1)).toThrow(ErrorInventario)
  })

  test("buscar ignora mayúsculas y minúsculas", () => {
    const db = dbVacia()
    agregar(db, { nombre: "Teclado mecánico", precio: "50", stock: "3" })
    agregar(db, { nombre: "Mouse", precio: "10", stock: "8" })

    expect(buscar(db, "TECLADO").map((p) => p.nombre)).toEqual(["Teclado mecánico"])
    expect(buscar(db, "teclado").map((p) => p.nombre)).toEqual(["Teclado mecánico"])
    expect(buscar(db, "zzz")).toEqual([])
  })

  test("buscar sin texto es un error", () => {
    expect(() => buscar(dbVacia(), "   ")).toThrow(ErrorInventario)
  })
})
