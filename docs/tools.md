# Herramientas

Código en `packages/core/src/tools/`. Cada herramienta tiene `name`, `description`, `parameters` (JSON Schema) y `execute(args, ctx)`. `tools/index.ts` las reúne en `createAllTools`. El modelo no ve todo el catálogo: el compilador de contexto carga un *loadout* mínimo y el resto se descubre con `search_knowledge` ([agent-loop.md](./agent-loop.md#contexto)).

## Catálogo por familia

| Familia | Archivo | Herramientas |
|---------|---------|--------------|
| Sistema de archivos | `filesystem/` | `fs_read`, `fs_write`, `fs_edit`, `fs_delete`, `fs_exists`, `fs_list`, `fs_glob`, `search_in_files` |
| Shell | `cli/` | `shell_executor` (con sandbox opcional) |
| Código y git | `code/` | `git_status`, `git_diff`, `git_log`, `git_blame`, `git_branch`, `git_commit`, `git_create_pr`, `git_rollback`, `code_search`, `code_build`, `code_test`, `code_test_parallel`, `code_lint`, `code_diff_create`, `parse_ast`, `find_imports`, `check_types`, `run_script` |
| Contexto | `core/` | `search_knowledge`, `get_project_context`, `notify`, `save_note`, `report_progress` |
| Delegación y memoria | `agents/` | `task_delegate`, `task_revise`, `task_status`, `task_delegate_code`, `spawn_agent`, `agent_create`, `agent_find`, `agent_archive`, `get_available_models`, `memory_write`/`write_memory`, `memory_read`, `memory_list`, `memory_search`, `memory_delete`, `bus_publish`, `bus_read`, `project_updates` |
| Spec Kit | `speckit/` | `speckit_init`, `speckit_artifact_read`, `speckit_artifact_write`, `speckit_validate`, `speckit_tasks_sync`, `speckit_converge` |
| Narrativa y decisiones | `narrative/` | `read_narrative`, `append_narrative`, `search_narrative`, `read_decisions`, `write_decision`, `get_task_context` |
| Web | `web/` | `web_search`, `web_fetch`, `browser_screenshot`, `browser_capture_clipboard`, `browser_preview_html` y el set `browser_*` de Obscura (MCP): `browser_navigate`, `browser_snapshot`, `browser_interactive_elements`, `browser_click`, `browser_fill`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_wait_for`, `browser_evaluate`, `browser_tab_new`, `browser_tab_close`… |
| APIs | `api/` | `api_request` |
| Programación | `cron/` | `cron.create`, `cron.list`, `cron.update`, `cron.pause`, `cron.resume`, `cron.delete`, `cron.trigger`, `cron.history` |

Además, los servidores MCP configurados aportan herramientas propias; `mcp/tool-sync.ts` las sincroniza al índice de herramientas.

## Dónde trabajan las herramientas de código

Las herramientas de `code/` (`code_build`, `code_test`, `code_lint`, `check_types`, `run_script`, `code_test_parallel`, `code_diff_create`, `parse_ast` y los `git_*`) resuelven su `path` **dentro del workspace de la tarea** (`workingDirectory`, igual que las de archivos): un `path` relativo cuenta desde la raíz del worktree y uno que apunte fuera se rechaza. Antes ejecutaban en `process.cwd()`, que es el proyecto real aunque la tarea viviera en un worktree aislado: los tests de un builder corrían contra el árbol equivocado, `git commit` tocaba el repositorio del usuario y un `code_build({ command: "cat > informe.md <<EOF…" })` escribía fuera del aislamiento (lo hizo un verifier en una corrida real, y luego copió el archivo a mano al worktree). Sin workspace configurado (un chat sin tarea) se conserva el comportamiento anterior.

## Permisos por perfil

Cada perfil declara su lista de herramientas (`agent-profiles.ts`); fuera de ella no se le ofrecen. La tabla está en [harness.md](./harness.md#perfiles). Encima actúa el modo de ejecución: en `plan` se retiran las de escritura aunque el perfil las tenga ([modes.md](./modes.md)).

## Sistema de archivos

- `workspace-guard.ts` y `fs-bounds.test.ts`: las rutas deben quedar dentro del workspace de la tarea.
- `fs_write` y `fs_edit` dejan un respaldo `<archivo>.hive-bak.<timestamp>` (`backup.ts`). El `WorkspaceManager` los excluye del diff.
- `fs_write`, `fs_edit` y `fs_delete` requieren autorización en `approval` ([modes.md](./modes.md#confirmación-por-herramienta)).

## `shell_executor` y sandbox

El sandbox está **apagado por defecto** (`sandbox.enabled: false` o `HIVE_SANDBOX=1`).

| Sistema | Proveedor | Archivo |
|---------|-----------|---------|
| Linux | bubblewrap (`bwrap`) | `sandbox-bwrap.ts` |
| macOS | Seatbelt (`sandbox-exec`) | `sandbox-seatbelt.ts` |
| Windows | no soportado nativamente; usa WSL2 | — |

Con `sandbox.enabled: true` y sin proveedor, el comando corre **sin aislamiento** y queda un aviso en el log; `sandbox.failIfUnavailable: true` lo convierte en error. `HIVE_SANDBOX_MODE` elige `auto-allow` o `permissions`.

`buildSandboxEnv` (en `cli/index.ts`) fija `HOME` y `TMPDIR` bajo `os.tmpdir()/hivecode-home/<hash>`. Así, `bun`, `npm` y herramientas similares escriben sus cachés fuera del workspace del proyecto; con `bwrap`, `HOME` es `/tmp`.

`code/command-validator.ts` valida los comandos antes de ejecutarlos.

## Spec Kit

`speckit_*` implementan el flujo de especificación: `speckit_init` crea `specs/<feature>/`, `speckit_artifact_write/read` escriben y leen `spec.md`, `plan.md`, `analysis.md`, `tasks.md`; `speckit_validate` comprueba que cumplen la plantilla; `speckit_tasks_sync` pasa las tareas a la cola durable; `speckit_converge` cierra la feature con las brechas y evidencias. Lo usan el Planner (escribe), BEE (valida y converge) y el Quality Gate.

## Resultados

Los resultados de las herramientas se acotan (`capToolResult`) y se formatean en TOON (`utils/toon.ts`) antes de volver al modelo. Telemetría: cada llamada emite `tool_call` y `tool_done` por IPC (`agent/tool-telemetry.ts`); `args_summary` se trunca a 120 caracteres.

## Llamadas a herramientas escritas como texto

Algunos modelos no usan el canal estructurado de llamadas y escriben las llamadas en el contenido. `extractToolCallsFromText` (`agent/llm-providers/openai-compat-base.ts`) las recupera y las quita del texto que ve el usuario:

- **DSML** (DeepSeek): bloques `<｜DSML｜function_calls>` con `<｜DSML｜invoke name="…">` y `<｜DSML｜parameter name="…" string="true|false">`. `string="true"` es texto literal (se conserva el código de los archivos tal cual); `string="false"` se interpreta como JSON. La etiqueta de cierre del bloque es opcional. La salida real de deepseek-flash se aparta de esa forma, y el parser lo tolera: barra `｜` o `|` repetida (`<｜｜DSML｜｜ invoke>`), espacio tras la barra, y envoltorio `function_calls`, `tool_calls` o solo `calls`.
- **Mistral** y derivados: formato nativo con marcadores.
- **XML** y **JSON** en el texto, como respaldo.

Si el parser DSML encuentra llamadas, se usan y no se prueban los demás. Si el marcado no se puede interpretar, la respuesta se marca como `droppedToolMarkup` y el bucle pide repetir la llamada ([agent-loop.md](./agent-loop.md#una-llamada-escrita-como-texto-que-no-se-ejecutó)). Con `HIVE_LLM_RAW_LOG=<archivo>` se guardan las respuestas con este marcado (y si se interpretaron), para detectar variantes nuevas ([development.md](./development.md#variables-de-entorno)).

## Añadir una herramienta

1. Crea el archivo en la familia que corresponda y expórtala desde su `index.ts`, con `name`, `description` (incluye sinónimos en español: se usa para la búsqueda), `parameters` y `execute`.
2. Si muta el workspace, añádela a `WORKSPACE_MUTATION_TOOLS` en `agent-loop.ts`; si debe bloquearse en `plan`, a `PLAN_BLOCKED_TOOLS`; si requiere confirmación, a `CONFIRM_REQUIRED_TOOLS` (`execution-mode.ts`).
3. Añádela a las listas de los perfiles que deban tenerla (`agent-profiles.ts`).
4. Cubre con una prueba junto al código (`*.test.ts`).
