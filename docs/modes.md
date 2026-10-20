# Modos de ejecución

Definidos en `packages/core/src/agent/execution-mode.ts`. El modo vigente se guarda en `~/.hivecode/execution_mode` y **persiste entre ejecuciones**: si cierras la TUI en `auto`, la próxima vez arranca en `auto`. Sin archivo, el modo es `plan`.

| Modo | Intención | Escritura |
|------|-----------|-----------|
| `plan` | Investigar y planificar. | Bloqueada. |
| `approval` | Planificar, pedir visto bueno y ejecutar. | Permitida; `fs_write`, `fs_edit`, `fs_delete`, `git_commit`… requieren confirmación. |
| `auto` | Ejecutar de punta a punta sin pausas. | Permitida. |

Cambio de modo: `Shift+Tab` en la TUI (cicla `plan → approval → auto`), `/mode set plan|approval|auto`, o `hivecode mode set …`.

## Plan

`PLAN_BLOCKED_TOOLS` se filtra del catálogo que ve el modelo (`filterToolsByMode`) y además se rechaza en ejecución (`canExecuteTool`): `fs_write`, `fs_edit`, `fs_delete`, `shell_executor`, `code_lint`, `code_test`, `code_build`, `git_commit`, `git_push`, todo `cron.*` que muta, `agent_create`, `agent_archive`, `task_delegate_code`, `memory_delete`.

Delegar en `plan` **sí** está permitido (Scout, Planner y Spider investigan), pero el hijo hereda el mismo modo y no puede escribir.

Detalles de implementación:

- Una tarea en `plan` no es mutante: `CoordinatorManager` no crea worktree ni integra nada, así que funciona en directorios que no son un repo git.
- El harness no pasa por el viejo Architecture, así que `runTask` emite por su cuenta `plan_update` con una sola fase (`Ejecutar plan`, coordinador `bee`) y guarda la narrativa. La TUI descarta planes sin fases, por eso hay una.
- Con ese `plan_update` el REPL abre el **modal de aprobación** (`plan_approval_request`).

## Aprobación del plan (modal)

`repl.ts` mantiene `pendingPlanTask`. Tras un plan en `plan` o `approval` aparece el modal con cuatro opciones:

| Opción | Efecto |
|--------|--------|
| Ejecutar automáticamente | Ejecuta la tarea en modo `auto`. Equivale a Enter vacío o `/approve auto`. |
| Aprobar fase por fase | Ejecuta en modo `approval` con `execute: true`, es decir, `runTask(task, ["--approval"])`, sin volver a planificar. Equivale a `/approve review`. |
| Agregar contexto | Deja la tarea pendiente; el siguiente texto que escribas se añade como "Contexto adicional del usuario" y se ejecuta en `auto`. |
| Cancelar plan | `/reject`, `n` o `no`: descarta la tarea pendiente. |

`/halt` o `/stop` cancelan la tarea activa (`cancelTask`); los archivos parciales se conservan.

## Puertas de aprobación del harness

`ProfileHarness` define dos puertas (`HarnessApprovalGate`), solo en `approval` y solo para tareas complejas:

- `specification`: tras el plan Spec Kit, antes de implementar.
- `convergence`: tras el Quality Gate, antes de cerrar.

La decisión llega por `options.approve`. Si no hay `approve` cableado, la tarea queda en `waiting_user` (con `nextAction` persistido) y es retomable.

> **Limitación conocida.** `CoordinatorManager` solo cablea `approve` cuando le llega `onApprovalCheckpoint`, y el REPL lo pasa únicamente fuera de la TUI (`!quiet`). Dentro de la TUI, `approval` se usa a través del modal ("Aprobar fase por fase"); las puertas `specification` y `convergence` no abren hoy un modal propio. Añadirlo exige dos mensajes nuevos en el protocolo IPC (solicitud y respuesta).

## Confirmación por herramienta

`CONFIRM_REQUIRED_TOOLS` = `fs_write`, `fs_edit`, `fs_delete`, `git_commit`, `cron.delete`, `agent_archive`. En modo `approval`, el bucle pide `¿Ejecutar <tool>? (y/N)` por stdin, salvo que la ejecución ya esté aprobada (`approvedExecution`, que el harness pone en la fase de ejecución tras su puerta).

Si no hay quién pueda contestar (`canPromptForConfirmation()` es `false`: dentro de la TUI, `HIVECODE_TUI=1`, o stdin sin TTY), la herramienta devuelve:

```json
{ "ok": false,
  "error": "[APPROVAL REQUIRED] '<tool>' necesita confirmación del usuario y aquí no hay forma de pedirla.",
  "hint": "No reintentes. Informa al usuario que esta acción espera su aprobación (o que cambie a modo auto)." }
```

Antes de esto, la tarea se quedaba colgada esperando un `y` que nadie podía teclear.

## Transiciones

- `plan → auto` / `plan → approval`: por el modal o con `/approve auto` / `/approve review`.
- `Shift+Tab` envía `mode_change` por IPC; el REPL guarda el modo (`onModeChange` → `saveMode`).
- El bucle de agente lee `getExecutionMode()` en cada llamada de herramienta, así que un cambio durante una tarea puede afectar a las llamadas siguientes de esa misma tarea. Esta transición no tiene cobertura de pruebas todavía; no dependas de ella.
