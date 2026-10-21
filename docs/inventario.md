# CLI de inventario de productos

Un CLI pequeño para llevar un inventario: se guarda en un archivo JSON y todo se
habla por línea de comandos.

```bash
bun run src/index.ts <comando> [argumentos]
```

Los datos viven en el archivo que indica la variable de entorno
`INVENTARIO_DATA`; si no está definida, se usa `./inventario.json` (relativa al
directorio de trabajo). Si ese archivo no existe, el inventario empieza vacío.

## Comandos

| Comando | Qué hace | Imprime |
|---------|----------|---------|
| `add --nombre <texto> --precio <número> --stock <entero>` | Crea un producto. | El producto creado. |
| `list` | Lista los productos. | El arreglo de productos, ordenado por id. |
| `update <id> [--nombre <texto>] [--precio <número>] [--stock <entero>]` | Cambia los campos indicados y deja los demás como estaban. | El producto actualizado. |
| `delete <id>` | Borra un producto. | `{"deleted": <id>}`. |
| `search <texto>` | Busca productos cuyo nombre contiene el texto, sin distinguir mayúsculas. | El arreglo de productos que coinciden. |

```bash
bun run src/index.ts add --nombre "Teclado" --precio 25.5 --stock 10
# {"id":1,"nombre":"Teclado","precio":25.5,"stock":10}

bun run src/index.ts list
# [{"id":1,"nombre":"Teclado","precio":25.5,"stock":10}]

bun run src/index.ts update 1 --precio 12.5
# {"id":1,"nombre":"Teclado","precio":12.5,"stock":10}

bun run src/index.ts search teclado
# [{"id":1,"nombre":"Teclado","precio":12.5,"stock":10}]

bun run src/index.ts delete 1
# {"deleted":1}
```

Las opciones se pueden escribir con espacio (`--precio 5`) o con equals
(`--precio=5`).

## Códigos de salida

- **0**: el comando se hizo bien. En stdout hay un único JSON.
- **1**: el comando falló. En stderr está el motivo, stdout queda vacío y el
  archivo de datos no se toca.

## Reglas

- Un producto es `{ "id": number, "nombre": string, "precio": number, "stock": number }`.
- Los ids son enteros que empiezan en 1 y suben con cada producto creado. No se
  reutilizan: si se borra el último producto, el siguiente id sigue siendo el
  siguiente.
- El nombre se guarda recortado, no puede quedar vacío y es único sin
  distinguir mayúsculas. En `update` se puede dejar el nombre tal cual está
  (con otra capitalización), pero no adoptar el de otro producto.
- El precio es un número mayor o igual que 0. El stock es un entero mayor o
  igual que 0.
- `update` y `delete` fallan si el id no existe.

## Dónde están las cosas

```
src/
  index.ts        punto de entrada: lee los argumentos y decide qué imprimir
  comandos.ts     los cinco comandos
  args.ts         lectura de las opciones --nombre valor
  validacion.ts   las reglas de los datos
  almacen.ts      lectura y escritura del archivo de datos
  tipos.ts        tipos del inventario
  errores.ts      error de uso
tests/
  inventario/
    cli.test.ts    pruebas de punta a punta: el CLI como lo ve quien lo usa
    unidad.test.ts pruebas de cada pieza por separado
```

## Pruebas

```bash
bun test tests/inventario/     # solo este proyecto
bun run test:inventario         # lo mismo, como script
```
