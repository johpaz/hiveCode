/**
 * Pruebas del CLI de inventario, de punta a punta.
 *
 * Cada prueba lanza el CLI como lo haría una persona (`bun run src/index.ts`)
 * y mira lo que ve: lo que sale por stdout, lo que sale por stderr, el código
 * de salida y el archivo de datos.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Raíz del proyecto: dos niveles arriba de `tests/inventario`. */
const PROYECTO = join(import.meta.dir, "..", "..")

let carpeta = ""
let datos = ""

beforeEach(() => {
  carpeta = mkdtempSync(join(tmpdir(), "inventario-cli-"))
  datos = join(carpeta, "datos.json")
})

afterEach(() => {
  rmSync(carpeta, { recursive: true, force: true })
})

/** Ejecuta el CLI y devuelve lo que alguien vería en la terminal. */
async function cli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: PROYECTO,
    env: { ...process.env, INVENTARIO_DATA: datos },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

const json = (texto: string) => JSON.parse(texto)

/** Añade un producto y comprueba que se creó bien. */
async function agregar(nombre: string, precio: number | string, stock: number | string) {
  const r = await cli("add", "--nombre", nombre, "--precio", String(precio), "--stock", String(stock))
  expect(r.code).toBe(0)
  return r
}

/** El archivo de datos tal como está, o `null` si todavía no existe. */
const archivo = () => (existsSync(datos) ? readFileSync(datos, "utf-8") : null)

describe("add", () => {
  test("crea el producto y lo imprime", async () => {
    const r = await agregar("Teclado", 25.5, 10)
    expect(json(r.stdout)).toEqual({ id: 1, nombre: "Teclado", precio: 25.5, stock: 10 })
  })

  test("el primer id es 1 y los siguientes crecen", async () => {
    await agregar("Uno", 1, 1)
    expect(json((await agregar("Dos", 2, 2)).stdout).id).toBe(2)
  })

  test("guarda el nombre recortado", async () => {
    expect(json((await agregar("  Mouse  ", 5, 1)).stdout).nombre).toBe("Mouse")
  })

  test("precio 0 y stock 0 son válidos", async () => {
    const r = await agregar("Gratis", 0, 0)
    expect(json(r.stdout)).toMatchObject({ precio: 0, stock: 0 })
  })

  test("el archivo de datos se escribe", async () => {
    await agregar("Teclado", 1, 1)
    expect(existsSync(datos)).toBe(true)
  })

  test.each([
    ["nombre vacío", ["--nombre", "   ", "--precio", "1", "--stock", "1"]],
    ["sin nombre", ["--precio", "1", "--stock", "1"]],
    ["precio negativo", ["--nombre", "X", "--precio", "-1", "--stock", "1"]],
    ["precio que no es número", ["--nombre", "X", "--precio", "abc", "--stock", "1"]],
    ["precio vacío", ["--nombre", "X", "--precio", "", "--stock", "1"]],
    ["stock negativo", ["--nombre", "X", "--precio", "1", "--stock", "-3"]],
    ["stock decimal", ["--nombre", "X", "--precio", "1", "--stock", "1.5"]],
    ["sin precio", ["--nombre", "X", "--stock", "1"]],
    ["sin stock", ["--nombre", "X", "--precio", "1"]],
  ])("rechaza %s", async (_caso, argumentos) => {
    await agregar("Base", 1, 1)
    const antes = archivo()

    const r = await cli("add", ...(argumentos as string[]))

    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr.length).toBeGreaterThan(0)
    expect(archivo()).toBe(antes)
  })

  test("rechaza un nombre repetido sin distinguir mayúsculas", async () => {
    await agregar("Teclado", 10, 1)
    const antes = archivo()

    const r = await cli("add", "--nombre", "TECLADO", "--precio", "20", "--stock", "2")

    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr.length).toBeGreaterThan(0)
    expect(archivo()).toBe(antes)
  })
})

describe("list", () => {
  test("sin archivo de datos devuelve un arreglo vacío", async () => {
    const r = await cli("list")
    expect(r.code).toBe(0)
    expect(json(r.stdout)).toEqual([])
  })

  test("devuelve todos los productos ordenados por id", async () => {
    await agregar("B", 1, 1)
    await agregar("A", 2, 2)
    await agregar("C", 3, 3)

    const r = await cli("list")
    expect(json(r.stdout).map((p: { id: number }) => p.id)).toEqual([1, 2, 3])
  })

  test("los datos persisten entre ejecuciones", async () => {
    await agregar("Uno", 1, 1)
    expect(json((await cli("list")).stdout)).toHaveLength(1)
  })
})

describe("update", () => {
  test("cambia solo los campos indicados", async () => {
    await agregar("Teclado", 10, 5)

    const r = await cli("update", "1", "--precio", "12.5")

    expect(r.code).toBe(0)
    expect(json(r.stdout)).toEqual({ id: 1, nombre: "Teclado", precio: 12.5, stock: 5 })
    expect(json((await cli("list")).stdout)[0].precio).toBe(12.5)
  })

  test("cambia el stock y el nombre a la vez", async () => {
    await agregar("Teclado", 10, 5)

    const r = await cli("update", "1", "--nombre", "  Teclado nuevo ", "--stock", "7")

    expect(json(r.stdout)).toEqual({ id: 1, nombre: "Teclado nuevo", precio: 10, stock: 7 })
  })

  test("deja el nombre con otra capitalización si es el mismo producto", async () => {
    await agregar("Teclado", 10, 5)
    await agregar("Mouse", 5, 1)

    expect((await cli("update", "1", "--nombre", "TECLADO")).code).toBe(0)
  })

  test("rechaza el nombre de otro producto", async () => {
    await agregar("Teclado", 10, 5)
    await agregar("Mouse", 5, 1)
    const antes = archivo()

    const r = await cli("update", "1", "--nombre", "mouse")

    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(archivo()).toBe(antes)
  })

  test.each([
    ["id inexistente", ["99", "--precio", "1"]],
    ["id que no es número", ["abc", "--precio", "1"]],
    ["precio negativo", ["1", "--precio", "-5"]],
    ["stock decimal", ["1", "--stock", "2.5"]],
    ["nombre vacío", ["1", "--nombre", " "]],
    ["sin id", []],
  ])("rechaza %s", async (_caso, argumentos) => {
    await agregar("Teclado", 10, 5)
    const antes = archivo()

    const r = await cli("update", ...(argumentos as string[]))

    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr.length).toBeGreaterThan(0)
    expect(archivo()).toBe(antes)
  })
})

describe("delete", () => {
  test("borra el producto y confirma", async () => {
    await agregar("Teclado", 10, 5)

    const r = await cli("delete", "1")

    expect(r.code).toBe(0)
    expect(json(r.stdout)).toEqual({ deleted: 1 })
    expect(json((await cli("list")).stdout)).toEqual([])
  })

  test("el id borrado no se reutiliza", async () => {
    await agregar("A", 1, 1)
    await agregar("B", 2, 2)

    await cli("delete", "2")

    expect(json((await agregar("C", 3, 3)).stdout).id).toBe(3)
  })

  test("un id inexistente es un error", async () => {
    await agregar("Base", 1, 1)
    const antes = archivo()

    const r = await cli("delete", "42")

    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(archivo()).toBe(antes)
  })
})

describe("search", () => {
  beforeEach(async () => {
    await agregar("Teclado mecánico", 50, 3)
    await agregar("Mouse", 10, 8)
    await agregar("teclado inalámbrico", 40, 2)
  })

  test("ignora mayúsculas y minúsculas", async () => {
    const r = await cli("search", "TECLADO")

    expect(r.code).toBe(0)
    expect(json(r.stdout).map((p: { id: number }) => p.id)).toEqual([1, 3])
  })

  test("sin coincidencias devuelve un arreglo vacío", async () => {
    expect(json((await cli("search", "zzz")).stdout)).toEqual([])
  })

  test("sin texto es un error", async () => {
    const r = await cli("search")
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
  })
})

describe("comandos", () => {
  test("un comando desconocido es un error", async () => {
    const r = await cli("explotar")
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  test("sin comando es un error", async () => {
    const r = await cli()
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr.length).toBeGreaterThan(0)
  })
})
