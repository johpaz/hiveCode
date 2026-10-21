#!/usr/bin/env bun
/**
 * CLI de inventario de productos.
 *
 *   bun run src/index.ts add --nombre "Teclado" --precio 25.5 --stock 10
 *   bun run src/index.ts list
 *   bun run src/index.ts update 1 --precio 12.5
 *   bun run src/index.ts delete 1
 *   bun run src/index.ts search teclado
 *
 * Los datos viven en el archivo que indica `INVENTARIO_DATA` (por defecto
 * `./inventario.json`). Si no existe, el inventario empieza vacío.
 *
 * En un comando correcto se imprime un único JSON en stdout y se termina con
 * código 0. En un comando incorrecto se escribe el motivo en stderr, stdout
 * queda vacío, se termina con código 1 y el archivo de datos no se toca.
 */
import { analizarFlags } from "./args"
import { cargar, guardar, rutaDatos } from "./almacen"
import { agregar, actualizar, buscar, eliminar, listar } from "./comandos"
import { ErrorInventario, mensajeDe } from "./errores"
import { validarId } from "./validacion"

/** Ejecuta un comando y devuelve lo que hay que imprimir en stdout. */
export function ejecutar(argumentos: string[], ruta: string): unknown {
  const [comando, ...resto] = argumentos
  if (comando === undefined) throw new ErrorInventario("falta el comando")

  const db = cargar(ruta)

  switch (comando) {
    case "add": {
      const producto = agregar(db, analizarFlags(resto))
      guardar(ruta, db)
      return producto
    }

    case "list":
      return listar(db)

    case "update": {
      const [idTexto, ...opciones] = resto
      if (idTexto === undefined) throw new ErrorInventario("falta el id del producto")
      const producto = actualizar(db, validarId(idTexto), analizarFlags(opciones))
      guardar(ruta, db)
      return producto
    }

    case "delete": {
      const [idTexto] = resto
      if (idTexto === undefined) throw new ErrorInventario("falta el id del producto")
      const resultado = eliminar(db, validarId(idTexto))
      guardar(ruta, db)
      return resultado
    }

    case "search": {
      const [texto] = resto
      if (texto === undefined) throw new ErrorInventario("falta el texto a buscar")
      return buscar(db, texto)
    }

    default:
      throw new ErrorInventario(`comando desconocido: "${comando}"`)
  }
}

/** Punto de entrada: un JSON en stdout o un error en stderr. */
function main(): void {
  try {
    const valor = ejecutar(process.argv.slice(2), rutaDatos())
    process.stdout.write(`${JSON.stringify(valor)}\n`)
  } catch (error) {
    const mensaje =
      error instanceof ErrorInventario ? error.message : `error inesperado: ${mensajeDe(error)}`
    process.stderr.write(`${mensaje}\n`)
    process.exitCode = 1
  }
}

// Solo cuando el archivo se ejecuta como programa: importarlo no hace nada.
if (import.meta.main) main()
