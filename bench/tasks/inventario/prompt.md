Crea un proyecto Bun (TypeScript) en el directorio actual: un CLI de inventario de productos.

Contrato (se verificará con pruebas automáticas que tú no ves):

- Punto de entrada: `bun run src/index.ts <comando> [argumentos]`.
- Los datos viven en un archivo JSON cuya ruta sale de la variable de entorno `INVENTARIO_DATA` (por defecto `./inventario.json`). Si el archivo no existe se trata como lista vacía.
- Cada producto es `{ "id": number, "nombre": string, "precio": number, "stock": number }`. Los ids son enteros crecientes que empiezan en 1 y no se reutilizan aunque se borren productos.
- Éxito: imprime en stdout un único JSON y termina con código 0. Error: imprime un mensaje en stderr, nada en stdout, termina con código 1 y NO modifica el archivo de datos.

Comandos:

1. `add --nombre <texto> --precio <número> --stock <entero>` → imprime el producto creado.
2. `list` → imprime el arreglo con todos los productos, ordenados por id.
3. `update <id> [--nombre <texto>] [--precio <número>] [--stock <entero>]` → imprime el producto actualizado (solo cambian los campos indicados).
4. `delete <id>` → imprime `{"deleted": <id>}`.
5. `search <texto>` → imprime el arreglo de productos cuyo nombre contiene el texto, sin distinguir mayúsculas de minúsculas.

Validaciones (todas terminan en error con código 1): nombre obligatorio (no vacío tras recortar espacios) y único sin distinguir mayúsculas (también en `update`); precio numérico mayor o igual que 0; stock entero mayor o igual que 0; id inexistente en `update` o `delete`; comando desconocido; argumentos obligatorios que faltan.

Incluye pruebas (`bun test`) para cada comando. Termina cuando todo funcione y `bun test` pase.
