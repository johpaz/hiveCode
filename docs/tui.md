# La TUI

`packages/hivetui`. Binario Rust sobre `crossterm` con renderer propio (`term/canvas.rs`, `renderer/`); no usa Ratatui. El lanzador está en `packages/cli/src/commands-code/tui-launcher.ts`.

## Estructura del crate

| Carpeta | Contenido |
|---------|-----------|
| `src/main.rs`, `app.rs` | Arranque, bucle principal, modo headless. |
| `src/controller.rs` | Entrada de teclado y ratón; convierte teclas en cambios de estado y mensajes IPC. |
| `src/ipc/mod.rs` | Cliente IPC y tipos serde de los mensajes. |
| `src/state/` | Estado de la aplicación: `session`, `history`, `input`, `modal`, `plan`, `review`, `diff`, `workers`, `swarm`, `roster`, `thought`, `logs`, `checkpoint`, `conflicts`, `harness`… |
| `src/widgets/` | Pantallas y componentes: `focus_layout` (Mesa), `plan_layout`, `code_layout`, `review_layout`, `office` y `office_scene` (Enjambre), `header`, `statusbar`, `tabbar`, `input`, `command_popup`, `settings_hub`, `config_modal`, `info_modal`, `plan_approval_modal`, `agent_card`, `activity_toast`. |
| `src/term/`, `src/ui/` | Canvas de celdas, estilos, tema, Markdown, tablas, listas virtuales, hit-testing. |

## Vistas

La tecla `1`–`5` (con el input vacío) fija la vista y desactiva el enrutado automático hasta la siguiente tarea.

| # | Vista | Contenido |
|---|-------|-----------|
| 1 | **ENJAMBRE** | La oficina: un puesto por perfil, su herramienta en vuelo, esperas y agentes bloqueados por un MCP apagado. `Alt+↑/↓` selecciona, `Enter` abre CÓDIGO. |
| 2 | **PLAN** | Spec, plan y fases. En modo `plan`, `Enter` aprueba (`/approve auto`). |
| 3 | **MESA** | Conversación con BEE y, a la derecha, su razonamiento en vivo. Con trabajo en curso, un cargador con agentes y herramientas activas. |
| 4 | **CÓDIGO** | Diff activo o mapa de archivos y panel lateral de workers. |
| 5 | **REVISIÓN** | Hallazgos del Quality Gate, mapa de riesgo y veredicto. |

La vista se enruta sola según el estado de la tarea (`state.tab_locked` lo impide tras elegir a mano). Otras superficies: ficha del agente (`i` o `/ficha <agente>`), registro (`/logs`), configuración (`F2`).

## Teclas

| Tecla | Acción |
|-------|--------|
| `Shift+Tab` | Cicla el modo `plan → approval → auto` y avisa al REPL. |
| `Tab` | Alterna el modo de navegación del historial. |
| `Esc` | Sale de navegación, cierra modales, limpia la selección. |
| `1`–`5` | Cambia de vista (input vacío). |
| `F2`, `Ctrl+S` | Abre Configuración. |
| `/` | Menú de comandos. |
| `?` | Ayuda contextual de la vista. |
| `Ctrl+U` | Borra la línea de entrada. |
| `Ctrl+L` | Copia la entrada seleccionada del historial al input. |
| `Ctrl+Y`, `Ctrl+Shift+C` | Copia al portapapeles. |
| Arrastrar con el ratón | Selecciona texto **dentro del panel donde empezó el arrastre** (nunca toma el panel de al lado) y lo copia al soltar. Un clic sin arrastrar solo elige la entrada. Funciona igual en todas las vistas, MESA incluida. |
| `Y` en una ventana informativa | Copia su valor (por ejemplo `/start CÓDIGO` al vincular Telegram) o, si no tiene uno, todo el texto. |
| `Ctrl+↑/↓` | Mueve la selección en el historial. |
| `Ctrl+←/→` | Salta por palabras. |
| `↑/↓` | Historial del input; con el input vacío, navega listas en las vistas Código, Revisión, Plan y Enjambre. |
| `PgUp/PgDn` | Desplaza Mesa, Plan, Enjambre o el historial. |
| `Alt+A / Alt+R / Alt+M` | En modo `approval`: aprobar, rechazar o modificar (pide confirmación). |
| `Alt+H` | En modo `auto`: detener la tarea (pide confirmación). |
| `[` / `]` | En Revisión: hallazgo anterior / siguiente. |
| `Alt+↑/↓`, `←/→` | Enjambre: selecciona puesto y cambia la ficha. |

Una `Ctrl+<letra>` sin atajo se ignora (no escribe la letra), salvo que también lleve `Alt`. Las mayúsculas se escriben con normalidad: `Shift+S` no abre Configuración.

## Configuración (`F2`)

Se abre también desde la pantalla de bienvenida (los modales se dibujan sobre ella). Un formulario abierto desde el hub, como "Agregar Provider" (`A`), vuelve al hub al cerrarlo con `Esc` o al enviarlo; el hub se refresca tras cada envío.

Pestañas: **Providers**, **Models**, **Agents**, **MCP**, **Skills**, **GitHub**, **Telegram**. `Tab`/`Shift+Tab` cambian de pestaña, `↑/↓` de fila, `Enter` actúa sobre la fila, `Espacio` activa/desactiva (Skills, MCP), `A` añade, `D` borra, `E` edita (Providers), `L` carga y `T` prueba (MCP).

En **Providers**, cada fila muestra el estado de la clave: `✓` guardada, `?` falta, `~` login de navegador (`hivecode-free`). `Enter` sobre una fila sin clave abre un formulario con un único campo enmascarado; el id del provider elegido viaja en `provider_activate`, que guarda la clave en `Bun.secrets` y activa el provider sin volver a preguntarlo. Si ya tiene clave, se activa directamente. El hub queda abierto y la tabla se refresca sola.

## Modales

| Widget | Activación / propósito |
|--------|------------------------|
| `command_popup` | `/`: lista de comandos con navegación. |
| `settings_hub` | `F2`/`Ctrl+S`. |
| `config_modal` | Formularios de Bun (`show_config_modal`), p. ej. la API key. |
| `info_modal` | `?` o `show_info_modal`; `↑/↓` desplaza, `Esc` cierra. |
| `plan_approval_modal` | Tras un plan en `plan`/`approval`: ejecutar automáticamente, fase por fase, agregar contexto, cancelar. Ver [modes.md](./modes.md#aprobación-del-plan-modal). |
| `ReviewConfirm` | Confirmación de `Alt+A/R/M`. |
| `tool_approval_modal` | **AUTORIZAR HERRAMIENTA** (una herramienta de `approval` pide permiso) y las puertas del harness **APROBAR ESPECIFICACIÓN Y PLAN** / **APROBAR RESULTADO** (`kind: "gate"`). `↩`/`y` aprueba, `Esc`/`n` rechaza o cancela, `↑↓`/`PgUp`/`PgDn` desplazan. Se ajusta al contenido; las puertas pueden ocupar casi toda la pantalla. |
| `resume_badge` | `▶ RESUME` en el enjambre: `Enter` arma, `Enter` otra vez reanuda una tarea interrumpida. |

## Protocolo IPC

Transporte: socket Unix (o TCP loopback en Windows), mensajes JSON de una línea envueltos en un sobre con prioridad y sesión (`ipc/envelope.ts`). Tipos en `packages/core/src/ipc/protocol.ts`; el lado Rust los refleja con serde.

### Bun → TUI (`BunMessage`)

| Prioridad | Mensajes |
|-----------|----------|
| **critical** | `init`, `conflict_alert`, `conflict_resolved`, `file_risk_update`, `forensic_alert`, `security_status_update`, `halt_state`, `tool_approval_request` |
| **normal** | `history_append`, `assistant_chunk`/`assistant_done`, `thought_chunk`, `plan_draft_update`, `plan_update`, `plan_approval_request`, `task_update`, `worker_update`, `activity_update`, `narrative_chunk`, `tool_call`/`tool_done`, `esperando`, `status`, `state_update`, `session_changed`, `error`, `dashboard_snapshot`, `show_config_modal`, `show_info_modal`, `suspend`/`resume`… |
| **low** | `log_entry`, `checkpoint_created`, `checkpoint_rollback`, `context_update`, `adr_update`, `file_diff`, `workers_snapshot`, `files_snapshot`, `memory_update`, `librarian_progress`, `review_verdict_update`, `resume_available`, `phase_retry` |

Los `critical` se envían de inmediato; los `low` pueden ir con retraso. `tool_call` y `tool_done` siempre vienen en pareja con el mismo `call_id`.

### TUI → Bun (`TuiMessage`)

`ready`, `submit` (texto del input, incluye `/approve …`, `/reject`, `/halt`), `mode_change`, `modal_submit`, `modal_cancel`, `info_modal_close`, `suspended`, `exit`, `rollback`, `task_resume`, `request_settings`, `provider_activate`, `tool_approval_response` (`{ request_id, approve }`, también para las puertas), entre otros definidos en `protocol.ts`.

## Revisión de cambios (`Alt+A/R/M`)

Estas teclas aprueban, rechazan o piden modificar **cambios de archivos** en modo `approval`. No son las puertas `specification`/`convergence` del harness ni la autorización por herramienta, que tiene su propio modal.

## Modo headless

`HIVETUI_HEADLESS=1` hace que el binario emita fotogramas como NDJSON por stdout en vez de pintar la terminal. Es lo que usan las pruebas e2e de la TUI.

## Compilar y probar

```bash
cd packages/hivetui
cargo build            # debug
cargo build --release  # el que se embebe en el binario distribuido
cargo test             # pruebas unitarias del controlador, estado y widgets
```

Cuando cambies una tecla en `controller.rs`, añade una prueba junto a las existentes (ahí están las de `S`, `Ctrl+U` y las `Ctrl+<letra>` sin atajo).
