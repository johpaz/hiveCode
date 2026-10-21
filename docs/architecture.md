# Arquitectura

## Paquetes

Monorepo Bun (`workspaces: packages/*`) más un crate Rust.

| Paquete | Responsabilidad | Piezas clave |
|---------|-----------------|--------------|
| `packages/cli` | Binario `hivecode`: comandos externos, REPL, lanzador de la TUI. | `src/index.ts`, `commands-code/repl.ts`, `commands-code/tui-launcher.ts`, `provider-store.ts` |
| `packages/code` | Motor de tareas de código: sesiones, workspaces, narrativa, checkpoints, recovery. | `workers/coordinator-manager.ts`, `workspace/manager.ts`, `narrative/scribe.ts`, `checkpoint/`, `recovery/` |
| `packages/core` | Núcleo: bucle de agente, harness, herramientas, gateway HTTP/WS, IPC, HiveDB, providers LLM. | `agent/agent-loop.ts`, `harness/profile-harness.ts`, `tools/`, `gateway/`, `ipc/`, `agent/llm-providers/` |
| `packages/hivetui` | TUI en Rust sobre `crossterm`, renderer propio (`term/canvas.rs`), sin Ratatui. | `controller.rs`, `app.rs`, `widgets/`, `state/`, `ipc/mod.rs` |
| `packages/mcp` | Cliente Model Context Protocol (stdio, SSE, WebSocket). | `manager.ts`, `transports/` |
| `packages/skills` | Skills empaquetadas y su cargador. | `bundled/`, `code/`, `loader.ts`, `bundled-data.generated.ts` |

El paquete raíz re-exporta subrutas (`exports` en `package.json`), por ejemplo `@johpaz/hivecode-core/harness/profile-harness`.

## Procesos

`hivecode` arranca **un proceso Bun** que contiene el gateway HTTP/WebSocket, el REPL y el `CoordinatorManager`. La TUI es un **segundo proceso** (el binario Rust `hivetui`) que se conecta al primero por IPC local (socket Unix; TCP loopback en Windows). Los dos se comunican con mensajes JSON delimitados por línea (ver [tui.md](./tui.md#protocolo-ipc)).

`tui-launcher.ts` marca `HIVECODE_TUI=1` en el entorno antes de lanzar la TUI. Con esa marca, las herramientas que piden confirmación no pueden usar stdin (el teclado es de la TUI): el lanzador registra un solicitante y la confirmación viaja por IPC al modal **AUTORIZAR HERRAMIENTA**; si no hay solicitante, devuelven `[APPROVAL REQUIRED]` en vez de colgarse (ver [modes.md](./modes.md#confirmación-por-herramienta)).

## Flujo de una tarea

1. El usuario escribe en la TUI. La TUI envía `submit` por IPC.
2. `repl.ts` crea la sesión si no existe (nace con el **primer mensaje**, no al abrir la TUI) y llama a `CoordinatorManager.runTask(descripción, modo, …)`.
3. `runTask` decide el workspace. Si la tarea muta archivos, `WorkspaceManager` crea un `git worktree` aislado; en modo `plan` no muta y usa el directorio del proyecto.
4. `runTask` llama a `ProfileHarness.run(...)` (la ruta canónica; `HIVECODE_LEGACY_HARNESS=1` conserva el pipeline antiguo solo para reanudar planes viejos).
5. El harness clasifica la tarea (`conversation`, `simple_change` o compleja) y arranca a **BEE** en el bucle de agente. BEE delega con `task_delegate`; cada worker corre el mismo bucle con su propio perfil.
6. Los eventos del harness salen como mensajes IPC (`worker_update`, `narrative_chunk`, `tool_call`, `tool_done`, `plan_update`, …) y la TUI los pinta.
7. Al terminar, `integrateTaskWorkspace` aplica el diff del worktree al proyecto (`git apply --3way`) y limpia worktree y rama.

## Persistencia

Todo el estado durable vive en **HiveDB** (WAL, un solo directorio). Por defecto en `~/.hivecode` (`HIVE_HOME`) o en la ruta `HIVE_DB_PATH`.

- Colecciones relevantes: `agents`, `harnessTasks`, `agentRuns` (checkpoints del bucle), `codeSessions`, `codeTasks`, `code_narrative`, `code_recovery_points`, `adrs`, `learning_failures`, `learning_proposals`, `agent_memory`.
- Las API keys **no** están en HiveDB: van al llavero del sistema vía `Bun.secrets`.
- Archivos sueltos en `~/.hivecode`: `config.json` (validado con Zod, `config/loader.ts`) y `execution_mode` (el modo persiste entre ejecuciones).

## Providers LLM

Cada provider implementa `LLMProvider.call(options)` (`agent/llm-providers/interface.ts`). Hay implementaciones para Anthropic, OpenAI, Gemini, Codex, DeepSeek, Groq, Kimi, MiniMax, Mistral, NVIDIA, OpenRouter, Qwen, opencode-go y `hivecode-free`. Los compatibles con OpenAI comparten `openai-compat-base.ts`, que también reconoce llamadas a herramientas escritas como texto (XML y el formato DSML de DeepSeek; ver [tools.md](./tools.md#llamadas-a-herramientas-escritas-como-texto)).

## Gateway

`packages/core/src/gateway` expone rutas HTTP/WS (`routes/`: agentes, auth, canales, chat, config, cron, MCP, modelos, providers, skills, tareas, herramientas, usuarios, workspace…). Arranca dentro del mismo proceso que el REPL. Los canales externos (Telegram) viven en `channels/`.

## El enjambre: instancias paralelas y dependencias

BEE reparte el trabajo; el runtime lo hace posible sin perder contexto:

- **Instancias**: `task_delegate({ worker_id: "builder#2" })` clona el perfil `builder` (máx. 3 por perfil). Cada instancia tiene su propio hilo, así que `task_revise` la reanuda con su contexto.
- **Copia privada**: una instancia escribe en un worktree propio de la tarea (`hivecode/swarm-<tarea>-<instancia>`, sembrado con todo lo que la tarea ya produjo). Al terminar, su diff se fusiona en el worktree de la tarea (de una en una) y la copia se borra. Si hay conflicto, la copia queda para inspección, se avisa con `⚠` y `task_delegate` devuelve `merge: "conflict"` con los archivos para que BEE use `task_revise`.
- **Dependencias**: `task_delegate({ after: ["T001"] })` espera a que T001 termine **antes de arrancar el run** (sin tokens ni slot) e inyecta su entrega. Si falla o queda a medias, vuelve `blocked_by`. `wait_for(ref)` hace lo mismo a mitad de un run y sustituye los `sleep` por shell.
- **Dentro de un worker**: llamadas independientes en un mismo turno corren juntas (lecturas, y `fs_write`/`fs_edit` a archivos distintos). El bloqueo de escritura es por ruta: un shell bloquea todo el workspace, dos archivos distintos no se bloquean entre sí.

Código: `core/src/agent/swarm-instances.ts`, `swarm-runtime.ts` (registro), `delegation-board.ts`, `tools/agents/index.ts`; la implementación git está en `code/src/workspace/swarm-workspaces.ts`. Se mide con `scripts/bench-run.ts` (campo `swarm` del JSON).

## Qué se probó y se quitó: los oráculos Jev/Kev

Hubo modelos pequeños (Jev en OpenRouter, Kev en HiveAgents) que decidían qué contexto, qué herramientas y qué siguiente acción recibía cada llamada, y si un lote podía ir en paralelo. **Se eliminaron.** En una medición con la misma tarea (un CRUD de 6 tareas, tres corridas):

| | Sin oráculo | Jev | Kev |
|---|---|---|---|
| Tiempo | 26,8 min | 48,5 min | 29,6 min |
| Tokens de entrada | 12,0 M | 9,7 M | 13,3 M |
| Ahorro estimado por poda | – | ~1,5 % | ~0 % |
| Respuestas perdidas o vacías | 0 | 9 | 0 |
| Consultas fallidas | – | 0 de 253 | 108 de 119 |

Por qué no sirvieron para agentes de código: cada decisión se tomaba con extractos de 650 caracteres por resultado, sin el plan ni el estado de las tareas, y daba `finish` (quitar todas las herramientas) a un BEE a mitad de planificar, con confianza superior a 0,85, cuatro veces seguidas. La latencia no era el problema (63 s en 48 min); lo eran sus decisiones. Además, su restricción de herramientas era permanente para el resto del run (un error que se corrigió antes de quitarlo) y Kev tenía un tope de 9 000 caracteres por petición que rechazaba casi todo.

Si algún día se reintroduce un modelo de decisión con contexto suficiente, debería ser **solo consejero** (nunca quitar herramientas ni decidir cuándo termina un agente) y medirse contra una corrida sin él con `scripts/bench-run.ts`. Lo que sí se conserva de aquel trabajo: el inventario del swarm (`agent/swarm-capabilities.ts`), la regla estructural de paralelismo y los avisos de bloqueo.
