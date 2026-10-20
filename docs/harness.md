# Harness: perfiles, delegación y workspaces

## ProfileHarness

`packages/core/src/harness/profile-harness.ts`. Es el orquestador canónico de tareas largas. Los modelos corren en el bucle de agente compartido ([agent-loop.md](./agent-loop.md)); **BEE orquesta ahí dentro** delegando con `task_delegate`. El harness solo sostiene lo que debe cumplirse decida lo que decida el modelo: enrutamiento, puertas de aprobación, presupuesto de reparación y reanudación durable.

```ts
new ProfileHarness().run({
  objective, sessionId, workspace,
  policy: "plan" | "approval" | "auto",
  provider?, model?,
  approve?: (gate: "specification" | "convergence", evidence) => Promise<"approve" | "cancel">,
  onEvent?, signal?, resumeTaskId?, parentTaskId?, history?,
})
```

### Clasificación

`classifyTask` (`harness/adaptive-scheduler.ts`) decide con expresiones regulares sobre el objetivo:

| Clase | Criterio | Ruta |
|-------|----------|------|
| `conversation` | Sin verbos de mutación. | BEE responde directo. |
| `simple_change` | Verbo de mutación (`implementa`, `fix`, `agrega`, `crea`, `refactor`…). | BEE delega en `builder`, sin Spec Kit. |
| `complex` | Arquitectura, migración, feature nueva, refactor amplio, sitio/app web, "crear un proyecto/app…" o más de 600 caracteres. | Spec Kit completo. |

### Etapas de una tarea compleja

Cada tarea es un documento `harnessTasks` con `stage` (`understanding → planning → ready → executing → reviewing → completed`, o `waiting_user`, `failed`, `cancelled`).

1. **Planning.** BEE delega el plan al `planner` (y opcionalmente una investigación al `scout`, en paralelo). El planner produce `spec.md`, `plan.md`, `tasks.md` bajo `specs/<feature>/` y responde con `FEATURE_DIR: specs/...`. Si falta, el harness busca el directorio más reciente en `specs/`; si no hay ninguno, falla.
2. **Plan listo.** En `policy: "plan"` termina aquí (`status: ready`).
3. **Puerta `specification`** (solo `approval`): `waiting_user` hasta que `approve("specification", plan)` responda `approve`; `cancel` termina la tarea como `cancelled`.
4. **Executing.** BEE lee `tasks.md`, delega cada tarea al worker de su *lane* (`scout`, `builder`, `spider`) con criterios de aceptación. Las tareas independientes se delegan en el **mismo paso** para correr en paralelo (tope `MAX_PARALLEL_WORKERS = 3`, un solo `builder` por conjunto de archivos). Esta fase corre con `approvedExecution = true`.
5. **Quality Gate.** BEE delega al `verifier`, que reproduce cada criterio y revisa el diff y debe terminar con `VERDICT: PASS` o `VERDICT: FAIL`.
6. **Reparación.** Si es `FAIL`, hasta `DEFAULT_MAX_REPAIR_CYCLES = 2` ciclos con `task_revise`/`builder` y nuevo Quality Gate. Si no converge, la tarea falla con `Quality gate did not converge`.
7. **Convergencia.** BEE llama `speckit_converge` y responde con un resumen compacto.
8. **Puerta `convergence`** (solo `approval`): sin aprobación explícita, la tarea queda `waiting_user`.

Los vereditos se reconocen con `VERDICT|VEREDICTO|STATUS|ESTADO: PASS|APPROVED|APROBADO|CUMPLE` (y los equivalentes de fallo); si aparecen ambos, gana el fallo.

### Reanudación y errores

El `stage` y `nextAction` se persisten tras cada transición. `resumeTaskId` retoma una tarea sin rehacer el plan (`planId` guarda el `FEATURE_DIR`). Un error se escribe en `blocker` y la tarea queda `failed` (o `cancelled` si la señal de abortar estaba activa).

El historial de la sesión se antepone al mensaje de BEE (`sessionHistoryPreamble`, máx. 12 000 caracteres, 1 500 por turno, los turnos más nuevos primero), porque cada tarea abre un hilo nuevo.

## Perfiles

Definidos en `agent/agent-profiles.ts` (`CORE_AGENT_DEFINITIONS`). Se aseguran en HiveDB con `ensureCoreAgentProfiles`; el harness les asigna el workspace, el provider y el modelo de la sesión (salvo que el agente tenga `model_selection: "custom"`).

| Perfil | Permiso | Turnos máx. | Herramientas principales |
|--------|---------|-------------|--------------------------|
| **bee** | `orchestrate` | 30 | Lectura, `task_delegate`, `task_revise`, `task_status`, `speckit_artifact_read`, `speckit_validate`, `speckit_converge`, `report_progress`, `save_note` |
| **scout** | `read_only` | 18 | Solo lectura (`fs_read`, `fs_list`, `fs_glob`, `search_in_files`, `find_imports`, `parse_ast`, `git_status/diff/log`, `search_knowledge`, `get_project_context`, `web_search`, `web_fetch`) |
| **planner** | `read_only` | 24 | Lectura + `speckit_init`, `speckit_artifact_read/write`, `speckit_validate`, `save_note` |
| **builder** | `write_workspace` | 40 | Lectura + `fs_write`, `fs_edit`, `fs_delete`, `shell_executor`, `check_types`, `code_test`, `code_build`, `run_script` |
| **verifier** (Quality Gate) | `verify` | 24 | Lectura + shell, tests, build, navegador (`browser_*`), `speckit_validate`, `speckit_converge`. No cambia código |
| **spider** | `web_automation` | 30 | `web_search`, `web_fetch`, `api_request`, notas y el set completo `browser_*` (Obscura vía MCP) |

Todos reciben además `spawn_agent`. `reviewer` se fusionó con `verifier` (conserva el id del gate de calidad para no romper datos persistidos).

El harness ejecuta a BEE con al menos `DEFAULT_MAX_HARNESS_STEPS = 40` pasos, para que quepa el planning Spec Kit completo.

## Delegación

`tools/agents/index.ts` y `agent/delegation.ts`.

- **`task_delegate`** `{ worker_id, task_description, acceptance[], specialty?, paths?, context_refs?, ref?, task_id? }`: ejecuta un worker acotado y devuelve su *handoff* más la evidencia contra los criterios. Varias llamadas en un mismo paso corren a la vez cuando sus workspaces no chocan; BEE es el *fan-in*.
- **`acceptance`**: `[{ id, description, checkTool? }]`. Un criterio con `checkTool` lo decide una herramienta de forma determinista (sin LLM); el resto los juzga BEE desde la evidencia. Sin criterios se usa "la tarea está hecha como se describió y el handoff nombra la evidencia".
- **`task_revise`**: devuelve una tarea al worker, en su propio hilo, con feedback concreto. Acepta `ref` (p. ej. `T003`) en lugar del `task_id`.
- **`task_status`**: estado de una delegación.
- **`spawn_agent`**: subagente efímero para una subtarea independiente. Hereda solo herramientas y skills del padre, no puede crear otra generación y se destruye al terminar; la evidencia queda en HiveDB.

### Concurrencia

`agent/execution-limits.ts`: `withExecutionSlot` limita las llamadas activas a modelo/herramienta **por sesión** (por defecto 4; `HIVE_MAX_AGENT_CONCURRENCY`, de 1 a 32). Esperar a un hijo no consume plaza. Además, un solo *writer* por workspace a la vez.

### Especialidades

`agent/specialties.ts`. Son *loadouts* (instrucciones y skills), **no** agentes residentes.

| Dueño | Especialidades |
|-------|----------------|
| builder | `backend`, `frontend`, `data`, `devops`, `integration` |
| planner | `architecture` |
| scout | `repository` |
| verifier | `security`, `acceptance` |
| spider | `web` |

Si no se pide una, `selectSpecialty` elige por expresiones regulares sobre la tarea (por defecto `integration` en builder). El nombre se normaliza: `scout/repository` o `scout:repository` se aceptan como `repository`. Pedir una que el dueño no tiene da error y lista las válidas.

## Workspaces aislados

`packages/code/src/workspace/manager.ts` (`WorkspaceManager`).

- **No mutante** (modo `plan`, conversación): usa el directorio del proyecto, sin worktree.
- **Mutante**: `git worktree add -B hivecode/task-<slug> /tmp/hivecode-worktrees/<slug>` más una referencia base `refs/hivecode/baselines/<slug>`. Requiere un repo git con al menos un commit.
- **`diff`**: marca los archivos nuevos con `git add -N` y compara con la referencia base. Excluye siempre los respaldos `*.hive-bak.<ts>` que dejan `fs_write`/`fs_edit`, `node_modules/` y el scratch de verificación (ver abajo), aunque el builder no haya escrito `.gitignore`.
- **`integrate`**: aplica el diff al proyecto con `git apply --3way`. Resultados: `integrated`, `noop`, `conflict`, `failed`. En `approval` se muestra el diff para aprobarlo antes de integrar.
- **`cleanup`**: borra worktree y rama.

El worktree de la sesión se acepta como alcance válido de `get_project_context` (`isWorktreeOf` en `agent/project-context.ts`); sin eso, los builders fallaban con "Session and workspace do not match".

Los comandos del shell del sandbox usan un `HOME` y `TMPDIR` fuera del workspace (`os.tmpdir()/hivecode-home/<hash>`), para que cachés como `.bun`, `.npm` o `.tools` no acaben dentro del proyecto.

Los prompts del Builder y del Quality Gate les piden dejar sus archivos temporales en `$TMPDIR`. Como red de seguridad, el diff descarta además el scratch que dejaron corridas reales: `.qg/`, `.smoke/`, `.scratch/`, `.tmp/`, `.cache/`, `.verify-*` y cualquier `*.log` **sin versionar** (`WORKSPACE_NOISE` en `workspace/manager.ts`). Dotfiles legítimos como `.gitignore` o `.github/` sí se integran. Un scratch con otro nombre sí se integraría: no hay forma de saber qué archivos son "del proyecto".

**Cancelar.** `/halt` no integra ni borra el worktree: queda en `/tmp/hivecode-worktrees/<tarea>` con su rama y el mensaje de cancelación da la ruta. Se elimina a mano con `git worktree remove --force <ruta>` y `git branch -D <rama>`; no hay limpieza automática de worktrees cancelados.
