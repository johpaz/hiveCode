# Hive-Code — Especificación Técnica
**Spec-Driven Development · v1.0.0**
**Autor:** @johpaz · **Estado:** DRAFT · **Fecha:** Mayo 2026

---

## Índice

1. Visión y Principios
2. Arquitectura de Alto Nivel
3. Stack Tecnológico y APIs de Bun
4. Sistema de Workers y Coordinadores
5. Contexto Narrativo y Memoria
6. Modos de Operación
7. Tools Nativas Compartidas
8. Skills del Sistema
9. Capas de Cache y Storage
10. CLI — Comandos Completos
11. Distribución y Empaquetado
12. Esquema SQLite
13. Contratos de Mensajes entre Workers
14. Flujo Completo de una Tarea
15. Criterios de Aceptación por Módulo

---

## 1. Visión y Principios

Hive-Code es una extensión especializada de Hive que convierte el gateway de agentes en un asistente de ingeniería de software autónomo. Hereda toda la infraestructura de Hive (Native Agent Loop, Context Compiler, ACE, canales, MCP) y agrega una capa de coordinadores especializados en código que corren como Bun Workers reales — un hilo por coordinador, paralelos, con contexto aislado.

**Principios que no se negocian:**

- Local-first: cero dependencias externas obligatorias. Un binario, funciona.
- Un hilo por coordinador. No se comparte estado mutable entre threads.
- El main thread es el árbitro. Todas las tools de escritura pasan por él.
- El contexto narrativo es la memoria del sistema. Todo lo importante se escribe ahí.
- SQLite como fuente de verdad. La memoria en proceso es cache, nunca estado primario.
- Las API keys nunca tocan disco ni logs. Solo viven en Bun.secrets (OS keystore).
- Rollback siempre disponible. Cada tarea crea una rama git y snapshots de archivos.

---

## 2. Arquitectura de Alto Nivel

```
┌─────────────────────────────────────────────────────────────────┐
│                    PROCESO PRINCIPAL (main thread)               │
│                                                                   │
│  Bun.serve()  ←→  WebSocket pub/sub  ←→  UI Dashboard           │
│       ↕                                                           │
│  Coordinador Principal                                            │
│    • Lee narrativo de SQLite                                      │
│    • Decide qué coordinador interviene en cada fase               │
│    • Serializa acceso a tools de escritura                        │
│    • Mantiene SharedArrayBuffer de estado de sesión               │
│    • Escucha BroadcastChannel para eventos de control (Shift+Tab) │
│       ↕                postMessage (string fast-path 500x)        │
├────────┬──────────┬──────────┬──────────┬──────────┬────────────┤
│ Worker │  Worker  │  Worker  │  Worker  │  Worker  │   Worker   │
│ Arch.  │ Backend  │ Frontend │ Security │  Test    │  DevOps    │
│Coord.  │ Coord.   │ Coord.   │ Coord.   │ Coord.   │  Coord.    │
│thread#1│ thread#2 │ thread#3 │ thread#4 │ thread#5 │  thread#6  │
│        │          │          │          │          │            │
│subagts │ subagts  │ subagts  │ subagts  │ subagts  │  subagts   │
│(spawn) │ (spawn)  │(spawn+   │ (spawn)  │(spawn+   │  (spawn)   │
│        │          │ WebView) │          │ WebView) │            │
└────────┴──────────┴──────────┴──────────┴──────────┴────────────┘
                              ↕
              SQLite WAL (fuente de verdad persistente)
              SharedArrayBuffer (estado de sesión, zero-copy)
              setEnvironmentData (config estática, sin serialización)
```

---

## 3. Stack Tecnológico y APIs de Bun

Esta sección mapea cada necesidad del sistema a la API de Bun más apropiada. Toda elección está justificada.

### 3.1 Concurrencia y Paralelismo

**`new Worker(url, { smol: true })`**
Un hilo por coordinador. `smol: true` en workers que solo hacen I/O ligero (Security, DevOps) para reducir heap. Los coordinadores pesados (Backend, Test) usan heap normal.

**`SharedArrayBuffer` + `Atomics`**
Para estado de sesión compartido entre todos los threads sin postMessage. Escribe solo el main thread, leen todos. Campos: modo actual (Plan/Approval/Auto), fase activa, bitmask de workers ocupados, flags de pausa/cancelación.

**`postMessage(string)` fast-path**
Para pasar contexto compilado (10–50 KB JSON) entre fases. Bun evita serialización para strings, resultando en latencia de ~500 ns independiente del tamaño. Usar para: outputs de coordinadores, file contents, contextos LLM.

**`BroadcastChannel`**
Para eventos de control one-to-many. El toggle Shift+Tab emite `MODE_CHANGED` a todos los workers simultáneamente sin pasar por el Coordinador Principal.

**`setEnvironmentData` / `getEnvironmentData`** *(PENDIENTE — documentado en SPEC, no implementado)*
Para config estática leída una vez al arrancar: model names, provider URLs, skill configs. Cero overhead de lectura en workers. El main thread carga las keys de `Bun.secrets` y las distribuye vía `setEnvironmentData` antes de crear los workers.

### 3.2 Storage y Persistencia

**`bun:sqlite` con pragmas WAL**
Fuente de verdad. Pragmas obligatorios al inicializar:
```
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA cache_size = -64000      (64 MB cache en memoria)
PRAGMA temp_store = MEMORY
PRAGMA mmap_size = 268435456    (256 MB memory-mapped I/O)
PRAGMA foreign_keys = ON
```
Permite lecturas concurrentes desde los 6 workers mientras el main thread escribe. No requiere proceso externo.

**`Map<string, { value, ts }>` en main thread**
Cache L1 para el Context Compiler. Invalidación por `MAX(rowid)` de SQLite. Latencia de nanosegundos. No es Redis, no necesita proceso externo.


### 3.3 Secretos y Credenciales

**`Bun.secrets`**
Toda API key vive en el OS keystore (Keychain/libsecret/Windows Credential Manager). Cifrado en reposo. Separado de variables de entorno. Los workers leen las keys vía `getEnvironmentData` — el main thread las carga de `Bun.secrets` al arrancar y las distribuye una vez.

Nunca se escriben keys en: `.env`, logs, SQLite, narrativo, snapshots, PRs.

### 3.4 Ejecución de Procesos

**`Bun.spawn` con sandbox**
Para ejecutar código generado por agentes. Parámetros obligatorios de seguridad:
```
cwd: directorioAisladoPorTarea
timeout: 30_000
stdout: "pipe"
stderr: "pipe"
env: entornoMínimo (sin keys del host)
killSignal: "SIGKILL"
```

**`Bun.spawn` para operaciones de shell**
Para comandos git y ejecución de procesos externos. Usa `Bun.spawn(["git", ...args], { cwd, timeout })` en vez de `Bun.$` para control explícito de `stdout`/`stderr`/`exitCode`. Template literals no aplican — cada argumento es un string independiente, sin riesgo de inyección.

**IPC entre procesos Bun**
Para subagentes de larga duración que necesitan comunicación bidireccional con su coordinador. Usa el protocolo IPC nativo de Bun (mismo que Node.js child_process.fork).

### 3.5 Servidor y Tiempo Real

**`Bun.serve()` con WebSocket nativo**
Gateway HTTP + WebSocket en un proceso. Pub/sub nativo para streaming de narración a la UI. Sin Socket.io. Sin Express.

Cada tarea tiene su canal WebSocket: `task:{taskId}:narration`, `task:{taskId}:phase`, `session:{sessionId}:mode`.

**Server-Sent Events (SSE)**
Para clientes que no soportan WebSocket (curl, herramientas CLI externas). Endpoint `/api/tasks/:id/stream`.

### 3.6 Automatización de Browser

**`Bun.WebView`** *(PENDIENTE — documentado en SPEC, solo en comentarios del código)*
Para verificación visual de UI en el Frontend Coordinator. Cada instancia usa `await using view = new Bun.WebView()` para limpieza automática con `Symbol.dispose`. Backend WebKit en macOS, Chrome DevTools Protocol en Linux/Windows.

Casos de uso en Hive-Code:
- Capturar screenshot de un componente generado para verificación visual
- Capturar errores de consola de JS para retroalimentar al LLM
- Tests E2E de UI generada por el frontend coordinator

### 3.7 Scheduling

**`Bun.cron(schedule, callback)` en-proceso**
Para jobs recurrentes del CronScheduler. Reemplaza a `croner` con API nativa de Bun. El callback tiene acceso directo al pool SQLite sin overhead de IPC. Retorna un `CronJob` con método `.stop()` para cancelación.
> **Nota:** `Bun.cron()` no incluye `pause()`/`resume()`/`trigger()`/`nextRun()` nativos. El `CronScheduler` implementa estas features con una capa wrapper que persiste estado en SQLite.

### 3.8 Seguridad

**`Bun.serve()` con cookies `SameSite`**
Protección CSRF manejada por el runtime de Bun vía cookies `SameSite=Strict` + validación de `Origin`/`Referer` headers. No existe `Bun.CSRF` como API standalone — Bun maneja CSRF implicitamente en `Bun.serve()`.

**`Bun.password.hash`**
Para tokens de autenticación del gateway si el usuario configura `HIVE_AUTH_TOKEN`.

**`Bun.CryptoHasher`**
Para generar hashes de contenido de archivos en snapshots (integridad) y cache keys.

### 3.9 Utilidades Relevantes

**`Bun.Glob`**
Para búsqueda semántica en el codebase. `scan()` es 2x más rápido desde v1.3.12.

**`Bun.Transpiler`** *(PENDIENTE — documentado en SPEC, no implementado)*
Para parsear imports y analizar AST livianamente sin invocar `tsc`. Planeado para la tool `parse_ast`.

**`Bun.randomUUIDv7()`**
Para IDs de tareas, sesiones y trazas. UUIDv7 es monotónicamente creciente, perfecto para ordering en SQLite.

**`Bun.nanoseconds()`**
Para medir latencia de cada tool call y guardarla en trazas del ACE.

**`HTMLRewriter`**
Para scraping selectivo de documentación cuando el ui-debug-agent o el architecture coordinator necesita leer docs web.

---

## 4. Sistema de Workers y Coordinadores

### 4.1 Coordinador Principal (main thread)

No ejecuta código LLM. Su responsabilidad es:

- Recibir tareas del usuario (vía WebSocket o CLI)
- Leer el narrativo para entender el estado del proyecto
- Generar el plan de fases invocando al Architecture Coordinator
- Despachar cada fase al worker correspondiente vía `postMessage`
- Serializar el acceso a todas las tools de escritura (filesystem, git)
- Mantener el SharedArrayBuffer de estado de sesión
- Escuchar el `BroadcastChannel` para eventos de control
- Escribir al narrativo el progreso y resultado de cada fase
- Crear el PR final vía GitHub API

### 4.2 Coordinadores Especialistas

Cada coordinador es un archivo TypeScript en `packages/code/src/workers/` que corre como un Bun Worker permanente. El archivo exporta un handler `onmessage` que recibe una `CoordinatorTask` y devuelve un `CoordinatorResult`.

---

**Architecture Coordinator** (`architecture.worker.ts`)

Propósito: Diseñar, nunca implementar. Recibe una descripción de tarea y el narrativo del proyecto. Produce un ADR y el plan de fases para los demás coordinadores.

System Prompt semilla:
```
Eres el Arquitecto de Software de Hive-Code.
SOLO diseñas — nunca escribes código de implementación.

Ante cada tarea recibes:
- El narrativo del proyecto (decisiones tomadas, contexto acumulado)
- El árbol de archivos del codebase
- La descripción de la tarea

Produces:
1. Un ADR (Architecture Decision Record) con opciones evaluadas y trade-offs
2. Las interfaces TypeScript de contratos entre módulos
3. El plan de fases ordenado con dependencias explícitas
4. Riesgos identificados con severidad (HIGH/MEDIUM/LOW)

Reglas:
- Siempre justifica cada decisión con trade-offs explícitos
- Si ya existe una decisión similar en el narrativo, no la contradices sin justificación
- Los contratos deben compilar con `bun tsc --noEmit`
- Máximo 5 fases por plan — si necesitas más, descompón la tarea
```

Subagentes que spawna: `diagram-agent` (Mermaid), `interface-agent` (tipos TS), `dependency-analyzer` (árbol de imports)

Tools disponibles: `read_file`, `list_dir`, `parse_ast`, `search_in_files`, `read_narrative`, `write_decision`

---

**Backend Coordinator** (`backend.worker.ts`)

Propósito: Implementar la capa de servidor. Recibe el ADR y los contratos del Architecture Coordinator.

System Prompt semilla:
```
Eres el Coordinador de Backend de Hive-Code.
Implementas código TypeScript para Bun runtime.

Recibes:
- El ADR aprobado del Architecture Coordinator
- Las interfaces TypeScript de contratos
- El narrativo del proyecto con USER OVERRIDES marcados

Reglas:
- Verifica con read_file antes de escribir cualquier archivo
- Nunca repitas lo que ya existe
- Las credenciales siempre via Bun.secrets, nunca hardcodeadas
- Los errores async siempre con async stack traces (Bun 1.3+)
- Al terminar cada archivo, escribe al narrativo lo que hiciste y por qué
- Si encuentras un bug o inconsistencia en el ADR, reporta al Principal antes de continuar
```

Subagentes que spawna: `api-agent`, `db-agent`, `integration-agent` (paralelo cuando no hay dependencias entre ellos)

Tools disponibles: todas las de filesystem, git_create_branch, git_commit, shell_executor, run_script, check_types, read_narrative, append_narrative

---

**Frontend Coordinator** (`frontend.worker.ts`)

Propósito: Implementar interfaces de usuario. Caso especial: tiene acceso exclusivo a `Bun.WebView` para verificación visual.

System Prompt semilla:
```
Eres el Coordinador de Frontend de Hive-Code.
Implementas componentes UI y los verificas visualmente con Bun.WebView.

Ciclo obligatorio para cada componente:
1. Lee el contrato de API del Backend Coordinator en el narrativo
2. Implementa el componente
3. Abre con ui-debug-agent en Bun.WebView
4. Captura screenshot y errores de consola
5. Si hay errores: corrígelos, vuelve al paso 3
6. Solo marcas el componente como completo cuando hay screenshot limpio

Reglas:
- Ningún componente se da por bueno sin screenshot de confirmación
- Los errores de consola son blockers — no los ignoras
- Si el componente requiere datos del backend, usa mocks realistas
```

Subagentes que spawna: `component-agent`, `style-agent`, `ui-debug-agent` (usa `Bun.WebView`)

Tools disponibles: todas las de filesystem, shell_executor, read_narrative, append_narrative. El `ui-debug-agent` tiene además acceso a `Bun.WebView`.

---

**Security Coordinator** (`security.worker.ts`)

Propósito: Auditar código después de que fue escrito. Solo lectura del codebase. Sus correcciones van como recomendaciones al Backend/Frontend Coordinator — no escribe directamente.

System Prompt semilla:
```
Eres el Auditor de Seguridad de Hive-Code.
Revisas código YA ESCRITO. No implementas, no modificas.

Para cada hallazgo produces:
- Severidad: CRITICAL / HIGH / MEDIUM / LOW
- Archivo y línea exacta
- Descripción del riesgo
- Patch concreto listo para aplicar (diff format)

Categorías que siempre revisas:
- Inyecciones (SQL, command injection, path traversal)
- Secrets hardcodeados o expuestos en logs
- Autenticación y autorización débil
- Dependencias vulnerables (lee bun.lock)
- XSS y validación de inputs
- Exposición de datos en respuestas de API

Un hallazgo CRITICAL pausa la tarea completa hasta que el usuario apruebe.
```

Subagentes: `sast-agent`, `dependency-audit-agent`, `secrets-scan-agent`

Tools disponibles: solo lectura — `read_file`, `search_in_files`, `parse_ast`, `check_dependencies`, `read_narrative`. Escribe al narrativo sus hallazgos.

---

**Test Coordinator** (`test.worker.ts`)

Propósito: Generar tests y mantener el ciclo test→error→fix hasta cobertura mínima o máximo de reintentos.

System Prompt semilla:
```
Eres el Coordinador de Tests de Hive-Code.
Tu trabajo no termina hasta que los tests pasen o hasta 3 ciclos de retry.

Ciclo:
1. Lee el código implementado
2. Genera tests usando bun:test con --isolate
3. Ejecuta con shell_executor
4. Si falla: analiza el async stack trace completo
5. Decide: ¿bug en el test o bug en el código?
   - Bug en test: corrígelo, vuelve al paso 3
   - Bug en código: reporta al Principal con el análisis completo
6. Completa cuando cobertura >= 80% o después de 3 ciclos

Flags siempre usados: --isolate (entorno limpio por test)
Si hay UI: agrega tests E2E con ui-debug-agent + Bun.WebView
```

Subagentes: `unit-test-agent`, `integration-test-agent`, `e2e-agent` (usa `Bun.WebView` cuando hay UI)

Tools disponibles: `read_file`, `write_file`, `run_tests`, `shell_executor`, `read_narrative`, `append_narrative`

---

**DevOps Coordinator** (`devops.worker.ts`)

Propósito: Se activa solo después de que el código pasó tests y security review. Prepara el deployment.

System Prompt semilla:
```
Eres el Coordinador de DevOps de Hive-Code.
Solo actúas cuando el código está aprobado por Security y Test.

Produces:
- Dockerfile multi-stage optimizado
- GitHub Actions workflow con bun:test --parallel --shard
- Documentación de variables de entorno (sin valores, solo nombres)
- README con instrucciones de deployment
- Changelog entry en formato Conventional Commits

Reglas:
- Ninguna key o secret en archivos de CI — siempre via GitHub Secrets
- El Dockerfile usa el binario standalone de Hive-Code cuando aplica
- El workflow corre en ubuntu-latest con bun instalado via oven-sh/setup-bun@v2
```

Subagentes: `docker-agent`, `ci-agent`, `docs-agent`

Tools disponibles: `read_file`, `write_file`, `git_create_pr`, `shell_executor`, `read_narrative`, `append_narrative`

---

### 4.3 Modelo de Ciclo de Vida de Workers

```
Arranque del gateway
  → main thread crea 6 Workers (permanentes, no se destruyen)
  → setEnvironmentData distribuye config + keys
  → SharedArrayBuffer inicializado con estado default
  → Workers quedan en estado IDLE esperando postMessage

Llegada de tarea
  → main thread lee narrativo
  → Architecture Coordinator recibe primer postMessage
  → Resultado: plan de fases guardado en SQLite
  → Cada fase se despacha al worker correspondiente en orden
  → Fases sin dependencias se despachan en paralelo (Promise.all)

Completion
  → Resultado de cada fase guardado en SQLite y narrativo
  → DevOps Coordinator crea PR si aplica
  → main thread notifica al usuario via WebSocket
  → Todos los workers vuelven a IDLE
```

---

## 5. Contexto Narrativo y Memoria

El narrativo es el hilo conductor de toda tarea. No es un log de eventos — es una narración estructurada que cualquier coordinador puede leer para entender el estado del proyecto sin necesidad de releer el código.

### 5.1 Estructura de una entrada narrativa

```
[{COORDINATOR} — {ISO_TIMESTAMP}] [{TASK_ID}] [{PHASE}]

QUÉ HICE:
{descripción en lenguaje natural de lo que se implementó/diseñó/revisó}

POR QUÉ:
{justificación — referencia al ADR o a una decisión previa del narrativo}

ARCHIVOS AFECTADOS:
{lista de archivos creados/modificados con una línea de descripción cada uno}

ENCONTRÉ:
{problemas, bugs, inconsistencias detectadas — vacío si ninguno}

PENDIENTE:
{qué debe hacer el próximo coordinador — vacío si nada}

USER OVERRIDE: {si el usuario modificó el plan, qué cambió y por qué}
```

### 5.2 Reglas del narrativo

- Solo el main thread escribe al narrativo (serialización garantizada)
- Los workers proponen entradas — el main thread las valida y escribe
- Cada entrada tiene `task_id` para filtrado por tarea
- El ACE Reflector analiza el narrativo para detectar patrones de éxito y fallo
- Las entradas con `USER OVERRIDE` tienen prioridad máxima — ningún coordinador las contradice
- El narrativo se exporta como parte del PR (en el body) para trazabilidad

### 5.3 Decisiones (ADRs)

Separadas del narrativo. Una tabla `decisions` en SQLite con:
- Título, contexto, opciones evaluadas, decisión tomada, consecuencias
- Status: `active`, `superseded`, `deprecated`
- Referencia cruzada con el `task_id` que la originó

---

## 6. Modos de Operación

### 6.1 Los tres modos

**PLAN** — Solo diseña, no toca nada.
El sistema corre Architecture Coordinator únicamente. Ninguna tool de escritura se ejecuta. Produce un Plan Document con estimados de archivos, decisiones técnicas y riesgos. Las entradas al narrativo se marcan `[DRAFT]`.

**APPROVAL** — Checkpoint entre cada fase.
El flujo es completo pero el Coordinador Principal pausa después de cada fase y presenta al usuario un resumen de lo que hizo y un preview de lo que va a hacer la siguiente fase. El usuario puede: aprobar, editar el plan, saltar la fase, o cancelar todo.

**AUTO** — Ejecuta sin preguntar.
El sistema corre completo. Solo se pausa en interrupciones automáticas (ver 6.3).

### 6.2 Toggle Shift+Tab

El modo es por sesión y se cambia en tiempo real con Shift+Tab. Ciclo: Plan → Approval → Auto → Plan.

El toggle llega por WebSocket como mensaje de control de alta prioridad. El main thread lo procesa inmediatamente, antes de cualquier mensaje de narración pendiente.

Comportamiento durante ejecución:
- El toggle cambia el estado en el SharedArrayBuffer instantáneamente
- La UI muestra el nuevo modo antes de que el backend reaccione
- La fase en vuelo termina en su modo original
- La siguiente fase adopta el nuevo modo
- Si el cambio es de Auto a Plan durante ejecución, se ofrece checkpoint inmediato

Historial de cambios guardado en tabla `session_modes` de SQLite con timestamp y fase en curso al momento del cambio.

### 6.3 Interrupciones automáticas (aplican en los 3 modos)

Las siguientes acciones siempre requieren confirmación del usuario:

- `DROP TABLE` o `DELETE FROM` sin cláusula WHERE
- Eliminar archivos del repositorio
- Push directo a rama `main` o `master`
- Instalar nueva dependencia con `bun add`
- Modificar `.env`, `Bun.secrets`, o configs de producción
- Ejecutar script descargado de internet
- Hallazgo de severidad CRITICAL del Security Coordinator

---

## 7. Tools Nativas Compartidas

Todas las tools viven en el main thread. Los workers las invocan por mensaje — nunca directamente. Esto garantiza serialización de acceso a filesystem y git.

### 7.1 Tools de Filesystem

```
read_file(path)
  → Retorna: { content: string, encoding, size, mtime, hash }
  → Usa: Bun.file().text() con CryptoHasher para integridad

write_file(path, content)
  → Pre-condición: snapshot automático en SQLite antes de escribir
  → Usa: Bun.write() — atómico por diseño de Bun
  → Retorna: { path, bytesWritten, hash }

edit_file(path, oldStr, newStr)
  → str_replace semántico: falla si oldStr aparece 0 o >1 veces
  → Retorna: { path, linesChanged, diff }

list_dir(path, recursive?, glob?)
  → Usa: Bun.Glob para patrones
  → Retorna: árbol de archivos con sizes y mtimes

search_in_files(pattern, glob?, maxResults?)
  → Búsqueda por contenido usando Bun.Glob.scan()
  → Retorna: [{ path, line, column, match, context }]

delete_file(path)
  → SIEMPRE requiere confirmación del usuario
  → Snapshot automático antes de borrar
```

### 7.2 Tools de Git

```
git_status()
  → Usa: Bun.$ `git status --porcelain`
  → Retorna: { modified, added, deleted, untracked }

git_diff(path?)
  → Retorna: diff legible como string

git_create_branch(name)
  → Convención: hive-code/task-{taskId}
  → Usa: Bun.$ `git checkout -b ${name}`

git_commit(message, files[])
  → Formato del mensaje: Conventional Commits
  → Usa: Bun.$ con staging explícito de archivos listados

git_create_pr(title, body)
  → Llama a GitHub API via fetch() con token de Bun.secrets
  → El body incluye el narrativo de la tarea formateado en Markdown

git_rollback(taskId)
  → Restaura snapshots de SQLite + git reset a estado pre-tarea
  → Requiere confirmación del usuario

git_blame(path, line)
  → Para que Security Coordinator identifique autoría de código sospechoso
```

### 7.3 Tools de Ejecución

```
shell_executor(cmd, cwd, timeoutMs?)
  → Usa: Bun.spawn con sandbox (cwd aislado, env mínimo, timeout)
  → Captura stdout, stderr, exitCode, durationMs
  → Retorna: { stdout, stderr, exitCode, durationNs }
  → Guarda traza en ACE automáticamente

run_tests(pattern?, flags[])
  → Usa: Bun.spawn ["bun", "test", "--isolate", ...flags]
  → Captura output con async stack traces completos
  → Retorna: { passed, failed, coverage, duration, failures[] }

check_types()
  → Usa: Bun.spawn ["bun", "tsc", "--noEmit"]
  → Retorna: { errors[], warnings[], duration }

run_script(path)
  → Ejecuta un archivo TypeScript en proceso aislado
  → Timeout de 60 segundos
```

### 7.4 Tools de Análisis

```
parse_ast(path)
  → Usa: Bun.Transpiler para análisis liviano sin tsc
  → Retorna: { imports[], exports[], functions[], classes[], complexity }

find_imports(path, recursive?)
  → Árbol de dependencias de importaciones
  → Detecta ciclos

check_dependencies()
  → Lee bun.lock y package.json
  → Cruza contra base de CVEs conocidos
  → Retorna: { vulnerabilities[], outdated[], unused[] }

read_package_json()
  → Parsea package.json con Bun.file().json()
  → Retorna estructura tipada
```

### 7.5 Tools de Contexto Narrativo

```
read_narrative(taskId?, last?)
  → Lectura desde SQLite con filtros opcionales
  → Si last: retorna las N entradas más recientes

append_narrative(entry)
  → Solo el main thread escribe
  → Workers proponen, main thread escribe

search_narrative(query)
  → FTS5 sobre el narrativo completo
  → Retorna entradas relevantes con score

read_decisions(status?)
  → Lista ADRs activos / deprecados / superseded

write_decision(adr)
  → Guarda ADR en tabla decisions
  → Solo Architecture Coordinator la usa

get_task_context(taskId)
  → Retorna narrativo + decisiones + snapshots de una tarea específica
```

---

## 8. Skills del Sistema

Las skills son prompts de razonamiento especializado que el Context Compiler inyecta vía FTS5 cuando el keyword score es relevante. No son tools — son conocimiento inyectado en el system prompt.

Cada skill es un archivo Markdown en `packages/skills/src/code/`.

| Nombre | Cuándo se activa | Quién la usa |
|--------|-----------------|-------------|
| `clean_architecture` | keywords: architecture, layers, SOLID, dependency | Architecture Coordinator |
| `rest_api_design` | keywords: endpoint, REST, HTTP, status code | Backend + Architecture |
| `sql_query_optimization` | keywords: query, index, N+1, performance, SQLite | Backend (db-agent) |
| `react_patterns` | keywords: component, hook, render, React, Vue | Frontend Coordinator |
| `security_owasp` | keywords: injection, XSS, auth, secret, vulnerability | Security Coordinator |
| `test_strategy` | keywords: test, coverage, mock, stub, assertion | Test Coordinator |
| `git_conventions` | keywords: commit, branch, PR, merge, changelog | DevOps + todos |
| `async_error_handling` | keywords: async, await, try, catch, stack trace | Todos los workers |
| `bun_native_apis` | keywords: Bun, Worker, SQLite, spawn, secrets | Todos los workers |
| `context_narration` | keywords: narrativo, summary, handoff | Coordinador Principal |
| `typescript_strict` | keywords: type, interface, generic, strict | Backend + Frontend |
| `dockerfile_best_practices` | keywords: Docker, container, layer, multi-stage | DevOps Coordinator |

---

## 9. Capas de Cache y Storage

```
┌──────────────────────────────────────────────────────────────┐
│  NANOSEGUNDOS — SharedArrayBuffer (zero-copy, sin serializ.) │
│    Campos: modo (2 bits), fase (4 bits), workers_busy (6 bits)│
│    Flags: pausa, cancelación, shutdown                        │
│    Escritura: solo main thread con Atomics.store              │
│    Lectura: cualquier worker con Atomics.load                 │
├──────────────────────────────────────────────────────────────┤
│  NANOSEGUNDOS — Map en memoria (main thread)                  │
│    Cache del Context Compiler compilado                       │
│    Key: {agentId}:{threadId}:{MAX(rowid) de traces}           │
│    Invalidación: automática cuando cambia MAX(rowid)          │
│    Sin TTL explícito — la key cambia con cada nueva traza     │
├──────────────────────────────────────────────────────────────┤
│  ~500 ns — postMessage fast-path (strings, zero-copy en Bun) │
│    Contexto compilado de una fase a la siguiente              │
│    Outputs de coordinadores (10–50 KB JSON típico)            │
│    File contents para análisis                                │
├──────────────────────────────────────────────────────────────┤
│  MICROSEGUNDOS — setEnvironmentData (lectura directa) ¹      │
│    Config de providers (model, baseURL, maxTokens)            │
│    API keys (leídas de Bun.secrets al arrancar)               │
│    Skill configs y listas de MCPs activos                     │
│    Inmutable durante la sesión — no se actualiza en caliente  │
├──────────────────────────────────────────────────────────────┤
│  MILLISEGUNDOS — SQLite WAL (persistente, fuente de verdad)   │
│    Narrativo, decisiones, trazas, playbook, snapshots         │
│    Sesiones, modos, checkpoints de fases                      │
│    Todo lo que debe sobrevivir un reinicio del proceso        │
└──────────────────────────────────────────────────────────────┘
```

**¹ Estado de implementación:**
- `SharedArrayBuffer` + `Atomics` → ✓ Implementado en `session-array.ts`
- `Map<string, {value, ts}>` en memoria → ✓ Implementado en `context/cache.ts`
- `postMessage` fast-path → ✓ Bun nativo, strings JSON en `coordinator-manager.ts`
- `setEnvironmentData` → ✓ Implementado en `workers/secrets.ts`
- SQLite WAL → ✓ Implementado en `sqlite.ts` con pragmas obligatorios

---

## 10. CLI — Comandos Completos

El binario se llama `hive-code`. Hereda todos los comandos de `hive` base y agrega los siguientes.

### Ciclo de Vida
```
hive-code start [--port 18791] [--mode plan|approval|auto]
hive-code stop
hive-code restart
hive-code status
hive-code logs [--follow] [--level debug|info|warn|error]
hive-code onboard
hive-code init [path]
```

### Providers y Modelos
```
hive-code provider list
hive-code provider add <name>              # wizard: solicita API key via stdin oculto → Bun.secrets
hive-code provider remove <name>           # elimina key de Bun.secrets + config
hive-code provider set-default <name>
hive-code provider set-model <provider> <model>
hive-code provider test <name>             # ping con latencia
```

### MCP
```
hive-code mcp list
hive-code mcp add <url-or-name>
hive-code mcp remove <name>
hive-code mcp enable <name>
hive-code mcp disable <name>
hive-code mcp test <name>                  # verifica conexión y lista tools
hive-code mcp inspect <name>               # tools + schemas
```

### Skills
```
hive-code skill list
hive-code skill enable <name>
hive-code skill disable <name>
hive-code skill add <path>                 # importa skill .md local
hive-code skill remove <name>
hive-code skill inspect <name>
hive-code skill assign <skill> <coordinator>
```

### GitHub
```
hive-code github connect                   # wizard OAuth
hive-code github disconnect
hive-code github status
hive-code github set-repo <owner/repo>
hive-code github whoami
```

### Coordinadores y Agentes
```
hive-code coordinator list
hive-code coordinator status <name>
hive-code coordinator restart <name>
hive-code coordinator pause <name>
hive-code coordinator resume <name>

hive-code agent list [--coordinator <name>]
hive-code agent inspect <name>
hive-code agent edit <name>                # abre system prompt en $EDITOR
hive-code agent reset <name>              # restaura system prompt a default
```

### Modo de Operación
```
hive-code mode get
hive-code mode set <plan|approval|auto>
hive-code mode history
```

### Tareas
```
hive-code task list [--status] [--limit]
hive-code task status <id>
hive-code task cancel <id>
hive-code task rollback <id>               # revierte archivos + git
hive-code task resume <id>

hive-code plan "<descripción>"             # shortcut: modo plan + lanza tarea
hive-code run "<descripción>"              # shortcut: modo auto + lanza tarea
```

### Scratchpad (Notas)
```
hive-code note list [--thread <id>]
hive-code note add <key> <value>
hive-code note get <key>
hive-code note delete <key>
hive-code note clear [--thread <id>]
```

### Narrativo y Decisiones
```
hive-code narrative show [--task <id>] [--last <n>]
hive-code narrative search <query>
hive-code narrative export [--format md|json]

hive-code decision list
hive-code decision show <id>
```

### ACE
```
hive-code ace status
hive-code ace playbook list
hive-code ace playbook reset
hive-code ace reflector run                # fuerza análisis inmediato
```

### Secrets
```
hive-code secret list                      # solo muestra nombres, nunca valores
hive-code secret set <name>               # solicita valor via stdin oculto
hive-code secret delete <name>
hive-code secret rotate <name>
```

### Diagnóstico
```
hive-code doctor                           # chequeo completo
hive-code doctor --fix                     # correcciones automáticas donde sea posible
```

Checks del doctor:
- Versión de Bun (mínimo 1.3.10)
- SQLite: integridad, WAL activo, tamaño
- Providers: ping a cada uno configurado
- Workers: estado de cada thread (idle/busy/error)
- MCP: conexión a cada servidor registrado
- GitHub: token válido, permisos, rate limit
- Skills: todas las built-in presentes
- Secrets: presencia de keys requeridas (sin mostrar valores)
- Bun.WebView: disponibilidad del backend WebKit o Chrome
- Espacio en disco disponible para snapshots

### Versión y Actualización
```
hive-code version
hive-code upgrade
hive-code changelog [--last <n>]
```

---

## 11. Distribución y Empaquetado

### Binarios por plataforma

Compilados con `bun build --compile --assets ./dist/ui` para incluir la UI embebida.

```
hive-code-v1.0.0-linux-x64          (bun-linux-x64)
hive-code-v1.0.0-linux-arm64        (bun-linux-arm64)
hive-code-v1.0.0-linux-x64-musl     (bun-linux-x64-musl, para Alpine)
hive-code-v1.0.0-macos-x64          (bun-darwin-x64, Intel)
hive-code-v1.0.0-macos-arm64        (bun-darwin-arm64, Apple Silicon)
hive-code-v1.0.0-windows-x64.exe    (bun-windows-x64)
hive-code-v1.0.0-windows-arm64.exe  (bun-windows-arm64)
```

Generados automáticamente por GitHub Actions en push con tag `v*`. Publicados como assets del release en GitHub. Sin firma de código en v1.0 — documentar el workaround de macOS Gatekeeper.

### Paquete npm `@johpaz/hive-code`

```json
{
  "name": "@johpaz/hive-code",
  "version": "1.0.0",
  "bin": { "hive-code": "./bin/hive-code.js" },
  "scripts": { "postinstall": "node scripts/download-binary.js" }
}
```

El `postinstall` detecta plataforma + arquitectura, descarga el binario nativo desde GitHub Releases, lo ubica en `bin/` y lo hace ejecutable. El `.js` wrapper es un lanzador de 5 líneas.

Instalación para el usuario:
```bash
npm install -g @johpaz/hive-code
bun install -g @johpaz/hive-code
curl -fsSL https://hive-code.io/install.sh | bash  # script directo
```

---

## 12. Esquema SQLite

```sql
-- Activar WAL y pragmas de performance al conectar
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA foreign_keys = ON;

-- Sesiones y estado
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,  -- UUIDv7
  project_path TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_modes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  task_id         TEXT,
  mode            TEXT CHECK(mode IN ('plan','approval','auto')) NOT NULL,
  changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  phase_at_change TEXT,
  triggered_by    TEXT DEFAULT 'shift_tab'
);

-- Tareas
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,  -- UUIDv7
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  description  TEXT NOT NULL,
  status       TEXT CHECK(status IN ('pending','planning','running','paused','completed','failed','cancelled')),
  mode         TEXT CHECK(mode IN ('plan','approval','auto')),
  branch_name  TEXT,
  pr_url       TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS task_phases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  phase_name     TEXT NOT NULL,
  coordinator    TEXT NOT NULL,
  status         TEXT CHECK(status IN ('pending','running','completed','skipped','failed')),
  result_summary TEXT,
  approved_at    DATETIME,
  approved_by    TEXT DEFAULT 'auto',
  started_at     DATETIME,
  completed_at   DATETIME
);

-- Narrativo
CREATE TABLE IF NOT EXISTS narrative (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT REFERENCES tasks(id),
  session_id  TEXT REFERENCES sessions(id),
  coordinator TEXT NOT NULL,
  phase       TEXT,
  entry       TEXT NOT NULL,
  is_draft    INTEGER DEFAULT 0,
  is_override INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS narrative_fts
  USING fts5(entry, content=narrative, content_rowid=id);

-- Decisiones (ADRs)
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,  -- UUIDv7
  task_id      TEXT REFERENCES tasks(id),
  title        TEXT NOT NULL,
  context      TEXT NOT NULL,
  options      TEXT NOT NULL,  -- JSON
  decision     TEXT NOT NULL,
  consequences TEXT NOT NULL,
  status       TEXT CHECK(status IN ('active','superseded','deprecated')) DEFAULT 'active',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Snapshots para rollback
CREATE TABLE IF NOT EXISTS file_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  file_path    TEXT NOT NULL,
  content      TEXT NOT NULL,
  hash         TEXT NOT NULL,
  snapshot_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_snapshots_task ON file_snapshots(task_id);

-- Trazas ACE
CREATE TABLE IF NOT EXISTS traces (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT REFERENCES tasks(id),
  agent_id       TEXT NOT NULL,
  coordinator    TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  input_summary  TEXT,
  output_summary TEXT,
  success        INTEGER DEFAULT 1,
  duration_ns    INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  analyzed       INTEGER DEFAULT 0,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_traces_analyzed ON traces(analyzed) WHERE analyzed = 0;

-- Playbook ACE
CREATE TABLE IF NOT EXISTS playbook (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule          TEXT NOT NULL,
  coordinator   TEXT,  -- NULL = aplica a todos
  helpful_count INTEGER DEFAULT 0,
  harmful_count INTEGER DEFAULT 0,
  confidence    REAL DEFAULT 0.5,
  active        INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_applied  DATETIME
);

CREATE VIRTUAL TABLE IF NOT EXISTS playbook_fts
  USING fts5(rule, content=playbook, content_rowid=id);

-- Reflexiones ACE
CREATE TABLE IF NOT EXISTS reflections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  traces_analyzed INTEGER NOT NULL,
  insights        TEXT NOT NULL,
  ethics_violation INTEGER DEFAULT 0,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Scratchpad
CREATE TABLE IF NOT EXISTS scratchpad (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(thread_id, key) ON CONFLICT REPLACE
);

-- Cache de contexto compilado (TTL gestionado por Bun.cron)
CREATE TABLE IF NOT EXISTS context_cache (
  cache_key   TEXT PRIMARY KEY,
  compiled    TEXT NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON context_cache(expires_at);
```

---

## 13. Contratos de Mensajes entre Workers

### Mensaje del Principal al Coordinador

```typescript
interface CoordinatorTask {
  taskId: string              // UUIDv7
  phaseId: number             // ID en task_phases
  phase: PhaseName            // 'architecture' | 'backend' | ...
  description: string         // descripción de la tarea original
  adr?: string                // ADR del Architecture Coordinator (si aplica)
  interfaces?: string         // contratos TypeScript (si aplica)
  narrative: string           // narrativo relevante serializado (string fast-path)
  previousPhaseOutput?: string// output de la fase anterior
  mode: 'plan' | 'approval' | 'auto'
  projectPath: string
}
```

### Respuesta del Coordinador al Principal

```typescript
interface CoordinatorResult {
  taskId: string
  phaseId: number
  coordinator: string
  status: 'completed' | 'failed' | 'blocked' | 'needs_approval'
  narrativeEntry: string      // entrada para append_narrative
  filesModified: string[]     // para el git commit
  blockerDescription?: string // si status === 'blocked'
  approvalPreview?: string    // si status === 'needs_approval'
  durationMs: number
}
```

### Mensaje de control (BroadcastChannel)

```typescript
interface ControlMessage {
  type: 'MODE_CHANGED' | 'TASK_CANCELLED' | 'PAUSE' | 'RESUME'
  sessionId: string
  payload: {
    mode?: 'plan' | 'approval' | 'auto'
    taskId?: string
  }
}
```

---

## 14. Flujo Completo de una Tarea

Ejemplo: "implementa autenticación JWT con refresh tokens"

```
1. Usuario envía tarea (WebSocket o CLI)
   → main thread crea task en SQLite (status: 'planning')
   → git_create_branch("hive-code/task-{id}")
   → modo actual leído del SharedArrayBuffer

2. Architecture Coordinator (thread #1)
   → Recibe task via postMessage
   → Lee narrativo: detecta que ya existe un auth middleware
   → Decide: extender el existente, no crear uno nuevo
   → Subagente interface-agent genera contratos TypeScript
   → Escribe ADR con decisiones (jose vs jsonwebtoken, httpOnly cookie)
   → Resultado: plan de 4 fases + interfaces
   → postMessage resultado al main thread

3. main thread
   → Si modo APPROVAL: presenta plan al usuario, espera confirmación
   → Guarda ADR en SQLite
   → Despacha Backend Coordinator

4. Backend Coordinator (thread #2)
   → Recibe ADR + contratos + narrativo
   → api-agent y db-agent corren en paralelo:
     api-agent: /auth/login, /auth/refresh, /auth/logout
     db-agent: migración refresh_tokens con índices
   → Cada archivo escrito con snapshot previo en SQLite
   → Al terminar, append_narrative via main thread

5. Security Coordinator (thread #4) — paralelo con Test
   → Revisa código implementado
   → Encuentra: refresh token no tiene rotación implementada (MEDIUM)
   → Genera patch concreto
   → Escribe findings al narrativo

6. Test Coordinator (thread #5) — paralelo con Security
   → Genera unit tests para sign/verify/refresh
   → Primer run: 2 tests fallan (edge case de token expirado)
   → Analiza async stack trace
   → Diagnostica: bug en implementación, no en el test
   → Reporta al Principal con análisis

7. main thread (checkpoint)
   → Recibe fallo del Test Coordinator
   → Notifica al usuario via WebSocket (narración en tiempo real)
   → Si modo AUTO: redirige al Backend Coordinator para fix
   → Si modo APPROVAL: espera confirmación del usuario

8. Backend Coordinator fix (thread #2)
   → Lee el análisis del Test Coordinator del narrativo
   → Corrige el edge case de token expirado
   → append_narrative con la corrección

9. Test Coordinator retry
   → Todos los tests pasan, cobertura 87%
   → append_narrative con resultados

10. DevOps Coordinator (thread #6)
    → Dockerfile multi-stage
    → GitHub Actions workflow con bun test --parallel --shard
    → Changelog entry
    → git_create_pr con narrativo completo en el body

11. Notificación al usuario
    → WebSocket: "PR #42 creado — johpaz/hive-code"
    → Task status: 'completed'
    → Narrativo cerrado y exportado como parte del PR
```

---

## 15. Criterios de Aceptación por Módulo

### Workers (Bun threads)

- Los 6 coordinadores arrancan y quedan IDLE en menos de 2 segundos
- Cada worker responde a `postMessage` en menos de 100 ms (sin contar tiempo de LLM)
- Un worker que falla no afecta a los demás
- El main thread detecta un worker caído y lo reinicia automáticamente
- `SharedArrayBuffer` refleja el modo actual en menos de 1 ms después del toggle

### Context Compiler

- El contexto compilado cacheado se sirve en menos de 1 ms (cache hit)
- Un cache miss (primera compilación para un thread/task) tarda menos de 50 ms
- El Context Compiler inyecta siempre las reglas de ética en el primer bloque del system prompt

### Tools de Filesystem

- `write_file` crea un snapshot en SQLite antes de cada escritura, con menos de 5 ms de overhead
- `edit_file` falla con error descriptivo si `oldStr` aparece 0 o más de 1 vez
- `git_rollback` restaura el estado exacto previo a una tarea en menos de 10 segundos

### Narrativo

- Toda entrada del narrativo tiene `task_id`, `coordinator`, `phase` y `timestamp`
- FTS5 sobre el narrativo retorna resultados en menos de 10 ms para narrativos de hasta 50,000 entradas
- El narrativo exportado es legible como documento Markdown autónomo

### CLI

- `hive-code doctor` completa su verificación en menos de 5 segundos
- `hive-code doctor --fix` no modifica configuración sin mostrar qué va a cambiar
- `hive-code secret set` nunca muestra el valor ingresado en pantalla ni en logs
- Todos los comandos retornan código de salida 0 en éxito y no-cero en error

### Modos de Operación

- El toggle Shift+Tab refleja el nuevo modo en la UI en menos de 200 ms
- En modo PLAN, ninguna tool de escritura se ejecuta — verificable por log de trazas
- En modo APPROVAL, el checkpoint de fase muestra exactamente qué archivos va a tocar la siguiente fase

### Distribución

- `npm install -g @johpaz/hive-code` funciona en Node.js 18+ sin Bun instalado
- El binario standalone arranca el gateway en menos de 1.5 segundos en frío
- `hive-code upgrade` reemplaza el binario actual sin perder datos de SQLite

---

Hive-Code — Instrucciones de Implementación
UI CLI 
Para agente de código o implementación manual Versión: 1.0.0 · Mayo 2026

CONTEXTO OBLIGATORIO (leer antes de cualquier acción)
Estás implementando tres módulos del proyecto Hive-Code, una extensión de Hive que convierte el gateway de agentes en un asistente de ingeniería de software autónomo. El proyecto usa Bun como runtime (>=1.3.10), TypeScript strict, SQLite WAL como base de datos, y un monorepo con workspaces de Bun.
Estructura relevante del monorepo:
packages/
  core/       ← NO TOCAR — infraestructura base de Hive
  cli/        ← EXTENDER — agregar en src/ui/ y src/commands-code/
  code/       ← NUEVO — todo Hive-Code vive aquí
Antes de crear cualquier archivo:
    1. Lee los archivos existentes en packages/cli/src/ para no duplicar 
    2. Verifica que bun:sqlite está disponible con: bun --version 
    3. Confirma que @clack/core está en package.json (no @clack/prompts) 

MÓDULO 1 — UI del CLI con identidad propia
Objetivo
Crear un sistema de UI para el CLI de Hive-Code usando @clack/core (no @clack/prompts) con identidad visual propia: símbolos de colmena, color ámbar, barra lateral coloreada por coordinador.
Paso 1 — Instalar dependencia correcta
# En la raíz del monorepo
bun add @clack/core

# NUNCA instalar @clack/prompts — su tema es el que queremos evitar
# Verificar que quedó en package.json:
grep "@clack" package.json
Paso 2 — Crear el archivo de tema
Crear packages/cli/src/ui/theme.ts con exactamente este contenido:
// packages/cli/src/ui/theme.ts
// Sistema de UI propio de Hive-Code usando @clack/core como motor.
// NO importar de @clack/prompts en ningún lugar del proyecto.

import { createPrompt, State, isCancel } from '@clack/core';

// ─── Códigos ANSI ────────────────────────────────────────────────
const C = {
  amber:      '\x1b[38;5;214m',
  amberDim:   '\x1b[38;5;172m',
  green:      '\x1b[38;5;114m',
  red:        '\x1b[38;5;203m',
  blue:       '\x1b[38;5;111m',
  purple:     '\x1b[38;5;141m',
  cyan:       '\x1b[38;5;116m',
  white:      '\x1b[38;5;252m',
  dim:        '\x1b[2m',
  bold:       '\x1b[1m',
  reset:      '\x1b[0m',
  clearLine:  '\x1b[2K\r',
};

// ─── Símbolos de identidad ────────────────────────────────────────
// ⬡ hexágono vacío  = paso activo / pendiente
// ⬢ hexágono sólido = paso completado
// Los hexágonos evocan la colmena sin usar emojis pesados
export const S = {
  bee:      '🐝',
  active:   '⬡',
  done:     '⬢',
  error:    '✗',
  warn:     '▲',
  info:     '◆',
  bar:      '│',
  barEnd:   '└',
  bullet:   '▸',
  dot:      '·',
  arrow:    '→',
  check:    '✓',
} as const;

// ─── Color de barra por coordinador ──────────────────────────────
// Cada coordinador tiene su color lateral para identificación visual
export const COORDINATOR_COLOR: Record<string, string> = {
  'architecture': C.purple,
  'backend':      C.blue,
  'frontend':     C.cyan,
  'security':     C.red,
  'test':         C.green,
  'devops':       C.amberDim,
  'principal':    C.amber,
  'default':      C.dim,
};

// ─── Primitivos de layout ─────────────────────────────────────────

/** Línea de barra lateral coloreada por coordinador */
function bar(coordinator = 'default'): string {
  const color = COORDINATOR_COLOR[coordinator] ?? C.dim;
  return `${color}${S.bar}${C.reset}`;
}

/** Línea vacía con barra lateral */
function emptyLine(coordinator = 'default'): string {
  return `  ${bar(coordinator)}`;
}

// ─── Componentes de UI ────────────────────────────────────────────

/**
 * Intro de sesión. Se muestra una vez al arrancar.
 *
 * Ejemplo de salida:
 *   🐝  hive-code v1.0.0 · johpaz
 *   │
 */
export function hiveIntro(title: string): void {
  process.stdout.write(
    `\n  ${S.bee}  ${C.bold}${C.amber}${title}${C.reset}\n` +
    `  ${C.amber}${S.bar}${C.reset}\n`
  );
}

/**
 * Outro de sesión. Se muestra al terminar.
 *
 * Ejemplo de salida:
 *   └  PR #42 creado ✓
 */
export function hiveOutro(message: string, type: 'success' | 'error' = 'success'): void {
  const color = type === 'success' ? C.green : C.red;
  const symbol = type === 'success' ? S.check : S.error;
  process.stdout.write(
    `  ${C.amber}${S.barEnd}${C.reset}  ${color}${symbol}${C.reset}  ${message}\n\n`
  );
}

/**
 * Muestra el estado del modo actual (Plan / Approval / Auto).
 * Se renderiza después del intro y al cambiar modo con Shift+Tab.
 */
export function hiveModeBar(mode: 'plan' | 'approval' | 'auto'): void {
  const labels = {
    plan:     `${C.purple}PLAN${C.reset}`,
    approval: `${C.amber}APROBACIÓN${C.reset}`,
    auto:     `${C.green}AUTO${C.reset}`,
  };
  process.stdout.write(
    `  ${bar()}  Modo: ${labels[mode]}` +
    `  ${C.dim}[shift+tab para cambiar]${C.reset}\n` +
    `  ${bar()}\n`
  );
}

/**
 * Línea de fase completada.
 *
 * Ejemplo:
 *   ⬢  Architecture Coordinator completó
 */
export function hivePhaseComplete(coordinator: string, summary: string): void {
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber;
  process.stdout.write(
    `  ${color}${S.done}${C.reset}  ${C.white}${summary}${C.reset}\n` +
    `  ${bar(coordinator)}\n`
  );
}

/**
 * Línea de fase activa (en progreso).
 *
 * Ejemplo:
 *   ⬡  Backend Coordinator: escribiendo jwt.ts...
 */
export function hivePhaseActive(coordinator: string, message: string): void {
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber;
  process.stdout.write(
    `  ${color}${S.active}${C.reset}  ${C.dim}${message}${C.reset}\n`
  );
}

/**
 * Box de nota. Para información importante que necesita destacarse.
 *
 * Ejemplo:
 *   ┌─ Nota ──────────────────────────────────┐
 *   │  Encontré un middleware existente        │
 *   └──────────────────────────────────────────┘
 */
export function hiveNote(title: string, lines: string[]): void {
  const width = Math.max(title.length + 4, ...lines.map(l => l.length + 4), 44);
  const top    = `┌─ ${C.amber}${title}${C.reset} ${'─'.repeat(width - title.length - 4)}┐`;
  const bottom = `└${'─'.repeat(width)}┘`;

  process.stdout.write(`\n  ${top}\n`);
  for (const line of lines) {
    const padding = ' '.repeat(width - line.length - 2);
    process.stdout.write(`  ${C.dim}│${C.reset}  ${line}${padding}${C.dim}│${C.reset}\n`);
  }
  process.stdout.write(`  ${bottom}\n\n`);
}

/**
 * Spinner con frames de colmena. Retorna un objeto con
 * start(msg), update(msg) y stop(msg).
 */
export function hiveSpinner(coordinator = 'default') {
  const frames = ['⬡', '⬡', '⬢', '⬢'];
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber;
  let i = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentMsg = '';

  return {
    start(message: string) {
      currentMsg = message;
      interval = setInterval(() => {
        const frame = frames[i++ % frames.length];
        process.stdout.write(
          `${C.clearLine}  ${color}${frame}${C.reset}  ${C.dim}${currentMsg}${C.reset}`
        );
      }, 120);
    },
    update(message: string) {
      currentMsg = message;
    },
    stop(message: string, type: 'done' | 'error' = 'done') {
      if (interval) clearInterval(interval);
      const symbol = type === 'done' ? S.done : S.error;
      const msgColor = type === 'done' ? C.white : C.red;
      process.stdout.write(
        `${C.clearLine}  ${color}${symbol}${C.reset}  ${msgColor}${message}${C.reset}\n`
      );
    },
  };
}

/**
 * Barra de progreso. Para fases con progreso medible (ej: indexar archivos).
 *
 * Ejemplo:
 *   ⬡  Indexando   ■■■■■■□□□□  60%  12/20 archivos
 */
export function hiveProgress(coordinator = 'default') {
  const color = COORDINATOR_COLOR[coordinator] ?? C.amber;
  const BAR_WIDTH = 10;

  return {
    render(current: number, total: number, label: string) {
      const pct = Math.round((current / total) * 100);
      const filled = Math.round((current / total) * BAR_WIDTH);
      const empty = BAR_WIDTH - filled;
      const bar = `${'■'.repeat(filled)}${'□'.repeat(empty)}`;

      process.stdout.write(
        `${C.clearLine}  ${color}${S.active}${C.reset}  ` +
        `${C.dim}${label}${C.reset}  ` +
        `${C.amber}${bar}${C.reset}  ` +
        `${C.white}${pct}%${C.reset}  ` +
        `${C.dim}${current}/${total}${C.reset}`
      );
    },
    stop(message: string) {
      process.stdout.write(
        `${C.clearLine}  ${color}${S.done}${C.reset}  ${message}\n`
      );
    },
  };
}

/**
 * Prompt de texto usando @clack/core.
 * Muestra el prompt con los símbolos de Hive.
 */
export async function hiveText(opts: {
  message: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | symbol> {
  return createPrompt<string, { value: string; error?: string }>(
    (state, done) => {
      const { value = '', error } = state;
      const placeholder = opts.placeholder ? C.dim + opts.placeholder + C.reset : '';
      const display = value || placeholder;

      let output = `  ${C.amber}${S.active}${C.reset}  ${C.white}${opts.message}${C.reset}\n`;
      output += `  ${bar()}  ${display}`;
      if (error) output += `\n  ${bar()}  ${C.red}${S.error} ${error}${C.reset}`;

      return output;
    },
    (key, _char, state) => {
      // El manejo de teclado lo gestiona @clack/core internamente
      return state;
    },
  )(opts);
}

/**
 * Prompt de selección con los símbolos de Hive.
 * ▸ ítem seleccionado  · ítem no seleccionado
 */
export async function hiveSelect<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
}): Promise<T | symbol> {
  return createPrompt<T, { cursor: number }>(
    (state, _done) => {
      const { cursor = 0 } = state;
      let output = `  ${C.amber}${S.active}${C.reset}  ${C.white}${opts.message}${C.reset}\n`;

      for (let i = 0; i < opts.options.length; i++) {
        const opt = opts.options[i];
        const isSelected = i === cursor;
        const bullet = isSelected
          ? `${C.amber}${S.bullet}${C.reset}`
          : `${C.dim}${S.dot}${C.reset}`;
        const label = isSelected
          ? `${C.white}${opt.label}${C.reset}`
          : `${C.dim}${opt.label}${C.reset}`;
        const hint = opt.hint ? `  ${C.dim}${opt.hint}${C.reset}` : '';

        output += `  ${bar()}  ${bullet}  ${label}${hint}\n`;
      }

      return output;
    },
    (key, _char, state) => {
      return state;
    },
  )(opts);
}

/**
 * Checkpoint de fase para modo APPROVAL.
 * Muestra lo que hizo la fase anterior y lo que hará la siguiente.
 */
export async function hiveCheckpoint(opts: {
  coordinator: string;
  phaseNumber: number;
  totalPhases: number;
  completed?: {
    filesCreated: string[];
    filesModified: string[];
    summary: string;
  };
  upcoming: {
    coordinator: string;
    willCreate: { path: string; reason: string }[];
    willModify: { path: string; lines: string; reason: string }[];
  };
}): Promise<'approve' | 'edit' | 'skip' | 'cancel'> {
  const { completed, upcoming, phaseNumber, totalPhases } = opts;
  const upColor = COORDINATOR_COLOR[upcoming.coordinator] ?? C.amber;

  // Mostrar resumen de fase completada
  if (completed) {
    process.stdout.write(
      `\n  ${C.green}${S.done}${C.reset}  ` +
      `${C.white}Fase ${phaseNumber - 1}/${totalPhases} completada${C.reset}  ` +
      `${C.dim}${completed.summary}${C.reset}\n`
    );
    for (const f of completed.filesCreated) {
      process.stdout.write(`  ${bar()}  ${C.green}+${C.reset}  ${C.dim}${f}${C.reset}\n`);
    }
    for (const f of completed.filesModified) {
      process.stdout.write(`  ${bar()}  ${C.amber}~${C.reset}  ${C.dim}${f}${C.reset}\n`);
    }
  }

  // Mostrar preview de siguiente fase
  process.stdout.write(
    `\n  ${upColor}${S.active}${C.reset}  ` +
    `${C.white}Fase ${phaseNumber}/${totalPhases}: ${upcoming.coordinator}${C.reset}\n`
  );
  for (const f of upcoming.willCreate) {
    process.stdout.write(
      `  ${bar(upcoming.coordinator)}  ${C.green}+${C.reset} crear    ` +
      `${C.white}${f.path}${C.reset}  ${C.dim}${f.reason}${C.reset}\n`
    );
  }
  for (const f of upcoming.willModify) {
    process.stdout.write(
      `  ${bar(upcoming.coordinator)}  ${C.amber}~${C.reset} modificar ` +
      `${C.white}${f.path}${C.reset}  ${C.dim}${f.lines}${C.reset}\n`
    );
  }

  // Selección de acción
  const result = await hiveSelect({
    message: '¿Continúo con esta fase?',
    options: [
      { value: 'approve', label: 'Aprobar y continuar' },
      { value: 'edit',    label: 'Editar el plan',     hint: 'escribe instrucciones adicionales' },
      { value: 'skip',    label: 'Saltar esta fase' },
      { value: 'cancel',  label: 'Cancelar todo' },
    ],
  });

  return isCancel(result) ? 'cancel' : result as 'approve' | 'edit' | 'skip' | 'cancel';
}

// Re-exportar isCancel de @clack/core para uso en el resto del CLI
export { isCancel } from '@clack/core';
Paso 3 — Crear el index del módulo UI
Crear packages/cli/src/ui/index.ts:
export {
  hiveIntro,
  hiveOutro,
  hiveModeBar,
  hivePhaseComplete,
  hivePhaseActive,
  hiveNote,
  hiveSpinner,
  hiveProgress,
  hiveText,
  hiveSelect,
  hiveCheckpoint,
  isCancel,
  S,
  COORDINATOR_COLOR,
} from './theme.ts';
Paso 4 — Ejemplo de uso en un comando
Crear packages/cli/src/commands-code/run.ts como referencia de cómo se usa el tema en un comando real:
import {
  hiveIntro, hiveOutro, hiveModeBar,
  hivePhaseActive, hivePhaseComplete,
  hiveSpinner, hiveNote, hiveText, isCancel,
} from '../ui/index.ts';

export async function commandRun(description?: string) {
  hiveIntro('hive-code v1.0.0 · johpaz');
  hiveModeBar('auto');

  const task = description ?? await hiveText({
    message: '¿Qué quieres construir?',
    placeholder: 'implementa autenticación JWT...',
    validate: (v) => v.length < 10 ? 'Describe la tarea con más detalle' : undefined,
  });

  if (isCancel(task)) {
    hiveOutro('Cancelado', 'error');
    process.exit(0);
  }

  const spinner = hiveSpinner('architecture');
  spinner.start('Architecture Coordinator: analizando codebase...');

  // ... llamada real al coordinador ...
  await new Promise(r => setTimeout(r, 2000)); // simula trabajo

  spinner.stop('Arquitectura diseñada — 3 contratos TypeScript generados');
  hivePhaseComplete('architecture', 'Architecture Coordinator completó');

  hiveNote('Decisión de arquitectura', [
    'Usaré jose en vez de jsonwebtoken',
    'Compatibilidad ESM nativa con Bun',
    'Refresh token en httpOnly cookie',
  ]);

  hivePhaseActive('backend', 'Backend Coordinator: implementando...');

  // ... más fases ...

  hiveOutro('PR #42 creado — johpaz/hive-code');
}
Paso 5 — Verificar el resultado visual
bun run packages/cli/src/commands-code/run.ts
Debes ver en terminal: intro con 🐝 en ámbar, barra lateral de color por coordinador, hexágonos como símbolos de estado, y la nota en box. Si los caracteres hexagonales no se ven, verificar que el terminal soporta Unicode (iTerm2, Warp, Windows Terminal, cualquier terminal moderno).



CHECKLIST DE VERIFICACIÓN FINAL
Antes de marcar los tres módulos como completos, verificar:
UI CLI
    • [ ] bun run packages/cli/src/commands-code/run.ts muestra la UI con hexágonos y color ámbar 
    • [ ] Los símbolos ⬡ y ⬢ se renderizan correctamente en el terminal 
    • [ ] hiveSpinner actualiza la línea en lugar de agregar líneas nuevas 
    • [ ] hiveCheckpoint retorna correctamente las cuatro opciones de acción 
    • [ ] Ningún archivo importa de @clack/prompts — solo de @clack/core 


NOTAS PARA EL AGENTE DE CÓDIGO
    1. El proyecto usa TypeScript strict. Todos los archivos nuevos deben pasar bun tsc --noEmit sin errores antes de considerarse completos.
    2. Los any en el código de ejemplo (type Database = any) deben reemplazarse con el tipo correcto de bun:sqlite al integrar con el resto del proyecto.
    3. Los componentes de UI en theme.ts usan el contrato de render de @clack/core. Si la API de @clack/core v1+ cambió el signature de createPrompt, consultar la documentación actualizada antes de adaptar.



*Fin del documento · Hive-Code Spec v1.0.0 · @johpaz · Mayo 2026*
*"Tu colmena de agentes de código. Local-first. Spec-driven. Construido desde Colombia para el mundo."*
