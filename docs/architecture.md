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

`tui-launcher.ts` marca `HIVECODE_TUI=1` en el entorno antes de lanzar la TUI. Con esa marca, las herramientas que piden confirmación por stdin no pueden hacerlo (el teclado es de la TUI) y devuelven un error `[APPROVAL REQUIRED]` en vez de colgarse (ver [modes.md](./modes.md#confirmación-por-herramienta)).

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

## Oráculos JEV/KEV (opcionales)

Modelos pequeños que deciden qué entra al prompt: `jev-planner.ts` poda historial, herramientas, skills y reglas antes de cada llamada, decide si un lote de llamadas puede correr en paralelo y poda resultados viejos entre iteraciones. Si el oráculo no está disponible devuelven `null` y el llamador sigue por el camino clásico. No conceden permisos.
