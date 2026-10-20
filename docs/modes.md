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

> **Limitación conocida.** `CoordinatorManager` solo cablea `approve` cuando le llega `onApprovalCheckpoint`, y el REPL lo pasa únicamente fuera de la TUI (`!quiet`). Dentro de la TUI, `approval` se usa a través del modal ("Aprobar fase por fase"); las puertas `specification` y `convergence` no abren hoy un modal propio. La confirmación por herramienta (siguiente sección) sí tiene su modal; falta conectar estas dos puertas al mismo mecanismo.

## Confirmación por herramienta

`CONFIRM_REQUIRED_TOOLS` = `fs_write`, `fs_edit`, `fs_delete`, `git_commit`, `cron.delete`, `agent_archive`. En modo `approval`, antes de ejecutar una de ellas el bucle pide autorización, salvo que la ejecución ya esté aprobada (`approvedExecution`, que el harness pone en la fase de ejecución de una tarea compleja tras su puerta). Hay tres caminos, por orden:

1. **TUI (modal).** Si el lanzador registró un solicitante (`registerToolApprovalRequester`), el bucle envía `tool_approval_request` y espera `tool_approval_response`. La TUI abre el modal **AUTORIZAR HERRAMIENTA** con el agente, la herramienta y sus argumentos: `↩`/`y` autoriza, `Esc`/`n` rechaza, `↑↓` desplaza un detalle largo. Solicitudes simultáneas se muestran de una en una, y si hay un formulario o Configuración abiertos esperan en cola a que se cierren. Código: `agent/tool-approval.ts` y `widgets/tool_approval_modal.rs`.
2. **Consola con TTY.** `¿Ejecutar <tool>? (y/N)` por stdin.
3. **Sin nadie que pueda contestar** (`canPromptForConfirmation()` es `false`: `HIVECODE_TUI=1` sin solicitante, o stdin sin TTY): la herramienta devuelve un error y no espera.

```json
{ "ok": false,
  "error": "[APPROVAL REQUIRED] '<tool>' necesita confirmación del usuario y aquí no hay forma de pedirla.",
  "hint": "No reintentes. Informa al usuario que esta acción espera su aprobación (o que cambie a modo auto)." }
```

**Rechazos.** Un rechazo vuelve al modelo como `[CANCELADO] Usuario canceló '<tool>'` con la indicación de no repetirla ni buscar otra vía. Si dentro de la misma tarea se vuelve a pedir **la misma herramienta con los mismos argumentos**, se rechaza sin preguntar otra vez. Abortar la tarea o cerrar la TUI deniega lo que estuviera pendiente. En una prueba real con deepseek, el builder no intentó escribir por shell tras el rechazo y BEE cerró informando "no completado — aprobación denegada", sin tocar el proyecto.

## Transiciones

- `plan → auto` / `plan → approval`: por el modal o con `/approve auto` / `/approve review`.
- `Shift+Tab` envía `mode_change` por IPC; el REPL guarda el modo (`onModeChange` → `saveMode`).
- **Cambiar de modo durante una tarea no afecta a esa tarea.** `run.ts` fija el modo de la tarea (`setExecutionMode`) mientras dura y lo restaura al terminar, y el bucle lee ese valor; `Shift+Tab` solo cambia la etiqueta y el modo de la **siguiente** tarea (comprobado: durante una tarea en `auto`, `execution_mode` sigue en `auto` aunque la cabecera muestre `PLAN`).
- Una tarea lanzada con `/approve review` desde `plan` se ejecuta con política `approval`, aunque la cabecera siga mostrando `PLAN` hasta que cambies de modo.
- `/halt` (o `/stop`) cancela la tarea activa: aborta a los workers, restaura el modo y **no integra nada**. Si la tarea tenía worktree, queda sin borrar y el mensaje indica su ruta y su rama (`hivecode/task-*`) para que puedas inspeccionarlo o eliminarlo con `git worktree remove`.
