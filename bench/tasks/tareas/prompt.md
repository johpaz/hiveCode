Crea una app full stack en Bun (TypeScript) en el directorio actual: una API HTTP de tareas y un frontend estático que la usa.

Contrato (se verificará con pruebas automáticas que tú no ves):

- Servidor: `bun run src/server.ts` escucha en el puerto de la variable `PORT` (por defecto 3000). Los datos viven en un archivo JSON cuya ruta sale de `TAREAS_DATA` (por defecto `./tareas.json`) y persisten entre reinicios del servidor.
- Una tarea es `{ "id": number, "titulo": string, "hecho": boolean }`. Los ids son enteros crecientes que empiezan en 1 y no se reutilizan aunque se borren tareas.

API (JSON, `Content-Type: application/json`):

- `GET /tareas` → 200 con el arreglo de tareas, ordenadas por id.
- `POST /tareas` con `{ "titulo": string }` → 201 con la tarea creada (`hecho: false`). El título es obligatorio: string no vacío tras recortar espacios; si no, 400 con `{ "error": <texto> }`. El título se guarda recortado.
- `PUT /tareas/:id` con `{ "titulo"?: string, "hecho"?: boolean }` → 200 con la tarea actualizada (solo cambian los campos enviados). 404 si el id no existe; 400 si el título queda vacío o los tipos no son los correctos.
- `DELETE /tareas/:id` → 204 sin cuerpo; 404 si no existe.
- Cualquier otra ruta de la API (`/tareas/...` con otro formato, otros métodos no soportados) responde 404 o 405 con JSON `{ "error": ... }`.

Frontend: `GET /` devuelve una página HTML (`text/html`) que lista las tareas, permite crear una, marcarla como hecha y borrarla llamando a la API con `fetch` (JavaScript plano, sin frameworks). Puede ser un archivo estático servido por el mismo servidor (por ejemplo desde `public/`).

Incluye pruebas (`bun test`) de la API y una prueba de integración que levante el servidor. Termina cuando todo funcione y `bun test` pase.
