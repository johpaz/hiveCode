# Arquitectura

hivecode es un workspace de Rust sobre el motor del SDK (`hive-agent-core`, sans‑I/O: el anfitrión
ejecuta las acciones que el motor pide —llamar al modelo, ejecutar una herramienta— y le devuelve el
resultado).

| Crate | Rol |
|-------|-----|
| `hivecode-host` | Bucle anfitrión: sesión durable, proveedor, herramientas con sandbox, modos, presupuesto. |
| `hivecode-workspace` | `git worktree` por tarea: preparar, diff contra la línea base, integrar (`git apply --3way`), revertir. |
| `hivecode-tools` | Herramientas extra: git, verificación, índice de código, MCP, ADR. |
| `hivecode-verify` | Qué significa «verificar» en cada ecosistema (Rust, Python, Node, Go, Java, .NET, …). |
| `hivecode-index` | Índice del código: símbolos, importaciones, dependientes, pruebas de un archivo. |
| `hivecode-swarm` | BEE y los workers, delegación en grupo, tablero `wait_for`, presupuesto compartido. |
| `hivecode-harness` | Pesa la tarea, elige ruta, verifica y repara; Quality Gate. |
| `hivecode-store` | Historial de corridas, informes y parches en HiveDB. |
| `hivecode-config` | Proveedores, claves (llavero / archivo `0600`) y `mcp.json`. |
| `hivecode-adr` | Decisiones de arquitectura (`adrs/*.md`) y riesgo de tocarlas. |
| `hivecode-skills` | Skills `SKILL.md` incluidas, del usuario y del proyecto. |
| `hivecode-app` | El binario `hivecode`: CLI, TUI, cron. |
| `packages/hivetui` | La TUI (proyecto Rust aparte, incrustada en el binario). |

## Flujo de una tarea

1. `run` abre la sesión y registra la corrida (`running`).
2. En `approval`/`auto` la tarea trabaja en su `git worktree` (`<tmp>/hivecode-worktrees/<id>`).
3. El harness pesa la tarea y elige ruta: conversación, cambio acotado o feature.
4. El agente (o BEE con su enjambre) trabaja; las herramientas pasan por el modo y el sandbox.
5. Verificación determinista; si falla, hasta dos ciclos de reparación en la ruta feature.
6. Se integra el diff al proyecto (sin cachés ni basura) y se guarda el parche para `rollback`.
7. La corrida queda `completed`, `failed` (con el error) o `running` si el proceso se cortó
   (`history` la marca «interrumpida»; `--recover` la retoma).

## Persistencia

Una HiveDB en `<home>/data/rust` compartida con las sesiones del SDK: colecciones
`hivecode_runs_v1`, `hivecode_findings_v1`, `hivecode_patches_v1`, `hivecode_delegations_v1`. Las
tareas programadas viven en `<home>/data/cron`. `<home>` es `$HIVE_HOME` o `~/.hivecode`.
