# Port a Rust sobre el SDK de Hive Agents

Objetivo: un solo binario `hivecode` en Rust, sin Bun/Node, construido sobre `hive-agent-core`
(`../hiveRust/hiveSDK-Rust/crates/hive-core`). El TS actual sigue siendo la referencia hasta que
cada etapa pase paridad; no se borra nada antes.

## Workspace

| Crate | Rol | Estado |
|-------|-----|--------|
| `crates/hivecode-host` | Bucle anfitrión del motor del SDK (sans-I/O): sesión durable, proveedor nativo, herramientas con sandbox, eventos de progreso. | Etapa 1 hecha (un agente, un turno) |
| `crates/hivecode-app` | Binario `hivecode`. Hoy solo `run` y `--version`. | Etapa 1 parcial |
| `packages/hivetui` | TUI Rust existente (habla NDJSON con el proceso TS). | Sin tocar |

## Qué hay (verificado)

- `hivecode run [--headless] --model M [--base-url U | --preset ID] [--root DIR] [--allow PROG]... <tarea>`.
  Clave solo por `HIVECODE_API_KEY`. `--headless` emite NDJSON (`text`, `tool_start`, `tool_done`, `done`).
- Un turno completo: modelo → herramienta (`fs_*`, `command_run` con lista de programas permitidos,
  sin shell) → modelo → respuesta, con sesión y operaciones persistidas en HiveDB (`~/.hivecode/data/rust`).
- Modos `plan` / `approval` / `auto` (`--mode`, o el archivo `~/.hivecode/execution_mode` compartido con el TS; sin archivo, `plan`). `plan` rechaza las herramientas que mutan y se lo dice al modelo; `approval` pregunta por cada una en la terminal (sin terminal, rechaza); `auto` ejecuta. La restricción se aplica al ejecutar, no filtrando el catálogo que ve el modelo (cambiar las herramientas a mitad de sesión rompería la reapertura de la sesión durable).
- Pruebas `crates/hivecode-host/tests/turn.rs` (4: turno con herramienta y los tres modos): servidor OpenAI-compatible falso (SSE); comprueba que
  la herramienta corre dentro del sandbox y que su resultado llega al modelo. Sin llamadas reales.
- `cargo fmt`, `clippy -D warnings` y `cargo test --workspace` limpios. Release linux-x64: **29 MB**
  (el binario Bun es de 153 MB).

## Qué NO hay todavía

Todo lo demás de la lista de etapas: selección de herramientas/skills, compactación, git y worktrees, coordinador y 12 workers, `ProfileHarness`, narrativa/ADR/
checkpoints, TUI en proceso, subcomandos (`init`, `doctor`, `provider`, `mcp`, …), canales,
importador de `~/.hivecode` y el corte. Sin ejecución contra un proveedor real.

## Etapas y puertas de paridad

0. Contrato (este documento) y snapshot de salidas TS.
1. Motor y proveedores: sesiones, compactación, selección de tools/skills, aprobación, modos.
2. Herramientas de código: fs, shell con sandbox, git, code-indexer, speckit, cron, web, MCP.
3. Enjambre: coordinador, workers, plan-parser, blackboard, supervisor, recuperación, checkpoints,
   worktrees (`workspace/leases|manager`), sobre la cola durable y el presupuesto raíz del SDK.
4. Harness de perfiles: `ProfileHarness`, `adaptive-scheduler`, `loadout-learning`, narrativa, ADR.
5. TUI y CLI en proceso.
6. Datos, empaquetado y corte (retirar TS solo con paridad verde y aprobación).

Cada etapa se cierra con: tests Rust, comparación con el TS sobre las mismas tareas semilla
(`scripts/bench-seed-hivecode.ts`, `bench-run.ts`) y reporte de lo no probado.
