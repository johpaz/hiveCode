# hivecode

**Multi-AI Coding Swarm — Consola-first. Enfocado en código. Multi-proveedor.**

`hivecode` es un harness de ingeniería de software que corre en tu terminal. Un coordinador, **BEE**, recibe tu tarea y delega en seis perfiles estables —**BEE**, **Planner**, **Scout**, **Builder**, **Quality Gate** (`verifier`) y **Spider**—, activa ejecuciones y especialistas temporales bajo demanda, limita por defecto a cuatro las llamadas activas a modelos o herramientas por sesión y usa Spec Kit nativo para features, arquitectura, migraciones y refactors amplios.

> **Runtime:** Bun >= 1.4.2 (los binarios de GitHub Releases lo traen embebido)
> **Base de datos:** HiveDB WAL — única fuente de verdad
> **TUI:** Rust + crossterm, renderer custom (`packages/hivetui/`)
> **Licencia:** hivecode-NC-1.0 (no comercial)

**Documentación técnica:**

- [`docs/agent-harness.md`](./docs/agent-harness.md) — referencia vigente: perfiles, herramientas, skills, especialidades, delegación, contexto HiveDB, oficina del enjambre y oráculos JEV/KEV.
- [`docs/plans/2026-10-10-hivedb-context.md`](./docs/plans/2026-10-10-hivedb-context.md) — cómo los agentes obtienen contexto del proyecto: caché, aislamiento, presupuestos y entrega durable.
- [`docs/workers.md`](./docs/workers.md) — referencia histórica del pipeline de compatibilidad (los once coordinadores por niveles).

---

## Instalación

Hay tres formas. Elige según tu sistema.

### Con npm (Linux x64)

```bash
# 1. Bun >= 1.4.2 (el CLI se ejecuta sobre Bun aunque lo instales con npm)
curl -fsSL https://bun.sh/install | bash

# 2. hivecode
npm i -g @johpaz/hivecode

# 3. Comprueba y arranca
hivecode --version
hivecode doctor
hivecode
```

El paquete npm incluye la TUI y la base de datos nativa compiladas para **Linux x64** (glibc y musl). En macOS, Windows y Linux arm64 usa los binarios de la siguiente sección.

Para actualizar: `npm i -g @johpaz/hivecode@latest`, o `hivecode upgrade` para comprobar si hay una versión nueva.

### Binario independiente (todas las plataformas)

Cada [release de GitHub](https://github.com/johpaz/hiveCode/releases) publica un ejecutable por plataforma con el runtime y la TUI embebidos: **no hace falta instalar Bun**.

| Sistema | Archivo |
|---------|---------|
| Linux x64 | `hive-code-linux-x64` (musl: `hive-code-linux-x64-musl`) |
| Linux arm64 | `hive-code-linux-arm64` |
| macOS Apple Silicon | `hive-code-macos-arm64` |
| macOS Intel | `hive-code-macos-x64` |
| Windows x64 | `hive-code-windows-x64.exe` |
| Windows arm64 | `hive-code-windows-arm64.exe` |

```bash
# Linux / macOS
chmod +x hive-code-linux-x64
sudo mv hive-code-linux-x64 /usr/local/bin/hivecode
hivecode --version

# Verificar la descarga (SHA256SUMS va en cada release)
sha256sum -c SHA256SUMS --ignore-missing
```

Si macOS bloquea el binario por haberlo descargado con el navegador, quita la marca de cuarentena: `xattr -d com.apple.quarantine hivecode`.

> **Windows:** el binario de Windows es el menos probado de los siete. Además, la herramienta `shell_executor` no está soportada fuera de WSL2 (no hay `/bin/sh`): para el flujo completo usa hivecode dentro de una distro WSL2 con el binario de Linux. Ver [Sandbox del shell](#sandbox-del-shell-por-sistema-operativo).

### Desde el código fuente

```bash
git clone https://github.com/johpaz/hiveCode.git hivecode
cd hivecode
bun install
bun run dev        # compila la TUI en debug y arranca gateway + TUI en el mismo proceso
```

Requiere Bun, Rust y Git. `bun run dev` compila la TUI con `cargo build`; para un binario optimizado, véase [Build y distribución](#build-y-distribución).

---

## Primer arranque

`hivecode` abre la TUI y el gateway local en el mismo proceso. Antes de la primera tarea hay que configurar un provider, sin salir de la TUI o desde la línea de comandos:

```text
En la TUI:   F2 → tab Providers → elige la fila → Enter → pega la API key
Por CLI:     hivecode provider add anthropic
             hivecode provider set-model anthropic <modelo>
             hivecode provider test
Sin clave:   hivecode login        # habilita los modelos de hivecode-free
```

Las claves se guardan en el llavero del sistema (`Bun.secrets`), nunca en texto plano. Si falla algo, `hivecode doctor` hace un diagnóstico completo.

---

## Interfaz: TUI

La interfaz es un **terminal Rust compilado** (`packages/hivetui/`) con renderer custom propio sobre `crossterm` — sin dependencias de Ratatui ni Tui-rs. Se comunica con el proceso Bun vía IPC con colas de prioridad (`critical / normal / low`).

### Vistas (teclas 1–5)

| # | Vista | Contenido |
|---|-------|-----------|
| 1 | **ENJAMBRE** | La oficina: un puesto por perfil, su herramienta en vuelo, esperas y agentes bloqueados por un MCP apagado. `Alt+↑/↓` selecciona, `Enter` abre CÓDIGO. |
| 2 | **PLAN** | Spec, plan y fases + strip de aprobación interactiva (modo `approval`). |
| 3 | **MESA** | La conversación con BEE y, a la derecha, su razonamiento en vivo. Mientras trabaja muestra un loader con los agentes y herramientas activas. |
| 4 | **CÓDIGO** | Diff activo o mapa de archivos y panel lateral de workers. |
| 5 | **REVISIÓN** | Hallazgos del Quality Gate, mapa de riesgo y veredicto. |

La vista activa se enruta automáticamente según el estado de la tarea y puede fijarse pulsando 1–5. Otras superficies: la **ficha del agente** (`i` o `/ficha <agente>`: capacidades, carga efectiva y decisiones del oráculo), el **registro** (`/logs`) y la **configuración** (`F2`).

### Cabecera, estado y mascota

La cabecera muestra el modo (`PLAN` / `APPROVAL` / `AUTO`), los workers activos, el contexto de BEE (`ctx`), el provider y modelo, y el costo de la sesión. La **mascota** junto al nombre cambia de gesto con el modo —`\(^•^)/` plan, `(?•?)` approval, `(•ᴗ•)` auto— y mueve los ojos mientras el enjambre trabaja. Un toast sobre el input indica qué está haciendo el agente.

### Overlays y modales

| Widget | Activación |
|--------|-----------|
| `command_popup` | Tecla `/` — lista de comandos disponibles con navegación |
| `settings_hub` | `F2` o `Ctrl+Shift+S` — providers, modelos, agentes, MCP, skills, GitHub, Telegram |
| `config_modal` | `Enter` en un provider del hub — introducir su API key sin volver a elegirlo |
| `info_modal` | `?` — ayuda contextual del tab activo |
| `resume_badge` | `Enter` ×2 sobre `[▶ RESUME]` — reanuda una tarea que quedó a medias si el proceso murió. La primera pulsación arma, la segunda reanuda |

### Elegir provider e introducir su API key

`F2` abre el hub en el tab **Providers**. Cada fila muestra el estado real de sus
credenciales en la columna `Key`: `✓` clave guardada, `?` falta la API key, `~`
login de navegador (`hivecode-free`, sin API key).

Al pulsar `Enter` sobre una fila:

- **Falta la clave** → se abre un formulario con un único campo enmascarado.
  El provider **no** se vuelve a preguntar: el id elegido viaja en el mensaje
  `provider_activate` y la clave se guarda en `Bun.secrets`.
- **Ya tiene clave** → se activa directamente.
- **Login de navegador** → se activa sin pedir clave; hay que haber hecho
  `/auth login` antes.

El hub se queda abierto mientras se procesa, así que la tabla se refresca sola con
el `✓` y el `● activo` ya actualizados.

Un provider nuevo que aún no está en la tabla se da de alta con `A`
(`/provider add`).

### IPC con Bun

El TUI es un binario Rust que se conecta al proceso Bun vía IPC local (Unix socket o TCP loopback en Windows). El gateway HTTP/WebSocket arranca dentro del mismo proceso Bun que el REPL/TUI. Los mensajes entrantes se procesan por prioridad:

- **CRITICAL** — `forensic_alert`, `approval_required`: se procesan antes que cualquier otra cosa
- **NORMAL** — `worker_update`, `history_append`, `diff_update`, `task_status`, `status`
- **LOW** — `memory_update`, `librarian_progress`, `thinking_chunk`

El TUI también funciona en modo headless (`HIVETUI_HEADLESS=1`) para testing: emite frames como NDJSON a stdout en lugar de pintar la terminal.

### Compilar el TUI

```bash
cd packages/hivetui && cargo build --release
```

---

---

## Modos de operación

| Modo | Qué hace | Comando rápido |
|------|----------|---------------|
| `plan` | BEE enruta y el Planner define spec, plan y tareas. **Ningún archivo se modifica.** | `/mode set plan` |
| `approval` | Hay un gate de aprobación antes de implementar y otro al converger. | `/mode set approval` |
| `auto` | Ejecución completa sin intervención. | `/mode set auto` |

`Shift+Tab` recorre los modos. Delegar en modo `plan` está permitido para investigación y planificación, pero no concede permiso de escritura: `fs_write`, `fs_edit`, `shell_executor`, tests/build y commits siguen bloqueados.

---

## Cómo funciona

**BEE** es el único interlocutor del usuario. Clasifica cada solicitud y decide cuánta maquinaria activar: una pregunta se responde directo, un cambio pequeño se delega al Builder y una tarea compleja pasa por spec, plan, implementación, verificación y convergencia.

| Perfil | Rol |
|--------|-----|
| **BEE** | Orquesta, delega con `task_delegate`, juzga la evidencia y consolida. |
| **Planner** | Convierte un objetivo complejo en spec, plan y tareas con dueño (Spec Kit). No implementa. |
| **Scout** | Investiga el repositorio sin modificar nada. |
| **Builder** | Implementa una tarea acotada. |
| **Quality Gate** | Reproduce los criterios de aceptación y revisa el diff. Termina con `VERDICT: PASS` o `FAIL`. |
| **Spider** | Búsqueda, scraping y automatización de navegador. |

- **Paralelo:** varias delegaciones corren a la vez si son workers distintos y como máximo uno escribe el workspace. El tope por defecto son cuatro llamadas activas por sesión (`HIVE_MAX_AGENT_CONCURRENCY`, de 1 a 32).
- **Reparación:** si el Quality Gate devuelve `FAIL`, hay hasta dos ciclos de reparación con `task_revise`.
- **Especialistas temporales:** un responsable puede crear un especialista para una subtarea independiente. Hereda los permisos del padre y desaparece al terminar; la evidencia queda en HiveDB.
- **Oráculos JEV/KEV:** modelos pequeños opcionales deciden qué contexto entra al prompt. No conceden permisos; sin ellos todo funciona por el camino clásico.

El detalle de herramientas, skills y especialidades por perfil está en [`docs/agent-harness.md`](./docs/agent-harness.md). El pipeline anterior de once coordinadores por niveles está archivado en [`docs/workers.md`](./docs/workers.md).

---
## Learning Harness — Autocorrección

El sistema detecta sus propios fallos durante la ejecución y genera propuestas de mejora que el operador puede revisar y aplicar. No hay autocorrección automática — **las propuestas en estado `pending` no tienen ningún efecto** hasta que el operador las apruebe.

### Cómo funciona

Cada fallo se registra inmediatamente en `learning_failures` (append-only). Al cerrar una tarea, BEE evalúa si hubo fricción y genera una propuesta. Cuando Architecture prepara un nuevo plan, consulta los fallos acumulados — si hay un patrón con 3+ ocurrencias, lo inyecta en su contexto y genera una propuesta adicional.

```
Ejecución
  ├─ Tool falla      → learning_failures (tool_error)
  ├─ Phase falla     → learning_failures (phase_failure)
  └─ Task completa   → evalúa fricción → learning_proposals (pending)

Próxima tarea con Architecture:
  └─ 3+ fallos del mismo tipo → inyecta en contexto + nueva propuesta

hivecode doctor → lista propuestas pendientes con detalle
```

### Ver y aplicar propuestas

```bash
# Ver propuestas pendientes
hivecode doctor

# Aplicar un cambio de prompt al agente afectado
hivecode agent edit <name>

# Agregar una skill nueva
/skill add
```

---

## Comandos CLI externos

```bash
hivecode                               # Iniciar REPL/TUI interactivo
hivecode --version                     # Versión instalada
hivecode doctor                        # Diagnóstico completo
hivecode doctor --fix                  # (reservado) correcciones automáticas — aún no implementado

hivecode agent list [--role=<rol>]     # Listar agentes
hivecode agent inspect <name>          # Ver detalles de un agente
hivecode agent edit <name>             # Editar instrucciones personales de un agente
hivecode agent configure <name>        # Configurar modelo y límites
hivecode agent reset <name>            # Restaurar instrucciones de un agente

hivecode provider list                 # Listar providers configurados
hivecode provider add [name]           # Añadir provider de IA
hivecode provider remove <name>        # Eliminar provider
hivecode provider edit [name]          # Editar provider
hivecode provider set-default <name>   # Establecer provider por defecto
hivecode provider set-model <provider> <model>  # Asignar modelo a provider
hivecode provider test [name]          # Ping con latencia

hivecode login                         # Autenticarse vía Firebase (hivecode-free)
hivecode logout                        # Cerrar sesión
hivecode whoami                        # Mostrar sesión actual
hivecode free                          # Modelos hivecode-free (requiere login)
hivecode upgrade                       # Verificar actualizaciones
hivecode exit                          # Detener el sistema
```

---
## Comandos internos del TUI (slash commands)

```
/provider list|add|set|test|status    Configurar providers de IA
/modelo   list|set|info|add|delete    Seleccionar y gestionar modelos
/mode     get|set|history             Cambiar modo Plan/Approval/Auto
/mcp      list|add|connect|load|enable|disable|test  Integrar servidores MCP
/skill    list|enable|disable|info|add Cargar y activar skills
/task     list|status|cancel|rollback Gestionar tareas
/narrative show|search|export         Buscar en el historial
/ace      status|playbook|reflector   Aprendizaje adaptativo
/github   status|whoami|set-repo|connect|disconnect  Vincular GitHub
/telegram status|connect|disconnect|edit  Integrar Telegram
/session  list|resume|new|status      Gestionar sesiones
/plan                                 Diseñar tarea sin ejecutar
/run                                  Ejecutar tarea en modo actual
/logs     list|follow                 Ver logs del sistema
/note                                 Guardar nota en scratchpad
/version                              Versión de hivecode
/doctor                               Diagnóstico del sistema
/help [comando]                       Ayuda detallada
```

### Sesiones

Una sesión nace con tu **primer mensaje**, no al abrir la TUI: abrir y cerrar sin
escribir no deja filas huéfanas en el selector. Su nombre es ese pedido — el
agente lo titula en segundo plano con una llamada corta, y si esa llamada falla
queda el texto del mensaje, así que nunca ves una sesión sin nombre.

Esa llamada va **acotada a 64 tokens y con el razonamiento desactivado**, porque
un modelo que razona se gasta el presupuesto entero pensando y devuelve una
respuesta vacía: medido con Qwen3.6-35B, sin esos dos ajustes la llamada usaba
1228 tokens y 22 s para no contestar nada; con ellos responde en 8 tokens y
≈ 0,9 s.

```
/session list                  Sesiones de este proyecto, con su título y fecha
/session resume                Elige una de la lista (TUI) · /session resume <id> por consola
/session new                   Cierra la actual; el siguiente mensaje abre otra
/session status                Detalle de la sesión activa
```

El id corto que ves (8 caracteres) es la **cola aleatoria** del id, no la cabeza:
un UUIDv7 empieza con un timestamp en milisegundos, así que la cola es lo único
que distingue una sesión de otra. `/session resume` con un fragmento que coincide
con varias sesiones te devuelve los candidatos en vez de elegir una por su cuenta.

Si el proceso se muere con una tarea a medias, al arrancar la TUI lo detecta y lo
ofrece con el badge `▶ RESUME` en el panel del enjambre: `Enter` para armarlo,
`Enter` otra vez para continuarlo desde su último punto de recuperación.

---

## Configuración de providers

Las API keys se almacenan en **Bun.secrets** (gestión segura del runtime), no en `.env` ni en `providers.api_key_encrypted` (este campo legacy se considera obsoleto). El comando `/provider add` las guarda de forma segura y las distribuye a los workers en runtime.

```bash
# Dentro del TUI:
/provider add anthropic
/provider add openai
/provider add gemini
/provider set anthropic           # activar como provider por defecto
/modelo set anthropic claude-sonnet-4-6
```

---

## Estructura del monorepo

```
packages/
├── cli/        CLI: comandos externos, REPL, launchers
├── code/       Motor: CoordinatorManager, workers, plan-parser
├── core/       Gateway HTTP/WS, HiveDB, agent loop, tools, context compiler
├── hivetui/    TUI Rust/crossterm — renderer custom, sin dependencias de Ratatui
├── mcp/        Cliente Model Context Protocol
└── skills/     Skills empaquetadas
```

### Base de datos — HiveDB

**`./hivecode`** — Directorio HiveDB central del proyecto (providers, agentes, sesiones, memoria, configuración y estado durable). Puede sobrescribirse explícitamente con `HIVE_DB_PATH`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA cache_size   = -64000;     -- 64 MB
PRAGMA mmap_size    = 268435456;  -- 256 MB
```

| Tabla | Contenido |
|-------|-----------|
| `providers` | Providers configurados (la API key real se guarda en `Bun.secrets`) |
| `models` | Modelos disponibles por provider |
| `agents` | Agente/coordinadores y sus prompts |
| `codeSessions` | Sesiones de trabajo. Se crean con el primer mensaje del usuario y llevan `title`: el nombre que le pone el agente a ese pedido |
| `codeTasks` | Tareas con modo, status, tokens |
| `code_task_phases` | Fases por coordinador |
| `code_narrative` | Historial narrativo estructurado (HiveDB index) |
| `code_recovery_points` | Recovery points por nivel de ejecución |
| `code_file_snapshots` | Snapshots para rollback |
| `code_playbook` | Reglas aprendidas por el ACE Reflector (HiveDB index) |
| `code_traces` | Trazas de ejecución de herramientas por agente |
| `learning_failures` | Log append-only de fallos (tool_error, phase_failure, timeout…) |
| `learning_proposals` | Propuestas de mejora generadas por BEE y Architecture (pending → aprobación manual) |

**Colección de memoria cross-sesión:**

| Tabla | Contenido |
|-------|-----------|
| `agent_memory` | Conocimiento destilado por el Librarian con HiveDB index |

**Colecciones por sesión:**

| Tabla | Contenido |
|-------|-----------|
| `codeTurns` | Turnos de la sesión: mensaje del usuario y respuesta del agente |
| `agent_context` | Blackboard: decisiones, constraints, observaciones (HiveDB index) |
| `agent_conflicts` | Conflictos detectados y sus resoluciones |
| `worker_activity` | Actividad por worker con `level` y timestamps |
| `checkpoints` | Snapshots de archivos para rollback por nivel |
| `adrs` | Architecture Decision Records (HiveDB index) |
| `file_risks` | Mapa de riesgo de archivos |

---

## Build y distribución

```bash
bun run build             # Skills + TUI release + bundle del CLI y workers (dist/)
bun run build:binary      # Binario standalone para Linux x64
bun run build:binary:all  # Binarios Linux, macOS y Windows
bun run lint              # Type check
bun run test              # Tests (aísla la DB y el llavero)
bun run test:integration  # Tests de integración
```

### Publicar una versión

El repositorio versiona **en lockstep**: un release es un único número en todos los `package.json`, en `Cargo.toml` y en `Cargo.lock`.

```bash
scripts/release.sh patch --dry-run   # verifica (tipos, tests Bun y Rust) sin cambiar nada
scripts/release.sh patch --push      # sube la versión, crea el tag vX.Y.Z y lo empuja
```

El tag dispara `release.yml`: verifica, compila los binarios de cada plataforma, crea la release de GitHub con `SHA256SUMS` y publica `@johpaz/hivecode` en npm. `scripts/set-version.ts` es la única fuente de verdad del número.

---

## Requisitos

| Para… | Necesitas |
|-------|-----------|
| Usar el binario de Releases | Nada más. |
| Instalar con npm | [Bun](https://bun.sh) >= 1.4.2 y Node/npm. Linux x64. |
| Compilar desde el código fuente | Bun >= 1.4.2, [Rust](https://rustup.rs) y Git. |

Un llavero del sistema (libsecret/D-Bus en Linux, Keychain en macOS, Credential Manager en Windows) para guardar las API keys. Sin él, `hivecode doctor` lo reporta como error.

### Sandbox del shell por sistema operativo

El sandbox de `shell_executor` está **apagado por defecto** (`sandbox.enabled: false`, o `HIVE_SANDBOX=1`).

| Sistema | Aislamiento | Notas |
|---|---|---|
| Linux | bubblewrap (`bwrap`) | Instálalo con tu gestor de paquetes. |
| macOS | Seatbelt (`sandbox-exec`) | Viene con el sistema. |
| Windows | **WSL2** | Ejecuta hivecode dentro de una distro WSL2: ahí es Linux y usa bwrap. |

Windows nativo no está soportado por `shell_executor` (no hay `/bin/sh`), igual que el sandbox de Claude Code. WSL1 tampoco sirve: no tiene namespaces, así que `bwrap` no funciona. Actualiza la distro con `wsl --set-version <distro> 2`.

Con `sandbox.enabled: true` y sin proveedor disponible, el comando corre **sin aislamiento** y solo queda un aviso en el log. Pon `sandbox.failIfUnavailable: true` para que falle en su lugar.

---

## Autor

**Johpaz** — [@johpaz](https://github.com/johpaz)

Hecho en Colombia con Bun y café.

---

## Licencia

**hivecode-NC-1.0** — Uso personal y educativo libre. Prohibido uso comercial sin autorización del autor.
Ver [`LICENSE`](./LICENSE) para los términos completos.
