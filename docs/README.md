# Documentación de hivecode

Referencia técnica del proyecto, escrita contra el código. Cuando algo cambie en el código, cambia aquí también.

| Documento | De qué trata |
|-----------|--------------|
| [architecture.md](./architecture.md) | Vista general: paquetes, procesos, flujo de una tarea de punta a punta y dónde vive cada dato. |
| [modes.md](./modes.md) | Los modos `plan`, `approval` y `auto`: qué bloquean, cómo se aprueba y cómo se transita entre ellos. |
| [harness.md](./harness.md) | `ProfileHarness`, los seis perfiles, delegación (`task_delegate`/`task_revise`), especialidades, workspaces con `git worktree`. |
| [rutas-por-costo.md](./rutas-por-costo.md) | Propuesta: qué tareas justifican el enjambre completo y cuáles van por una ruta corta con verificación determinista. |
| [agent-loop.md](./agent-loop.md) | El bucle de agente nativo: contexto, llamadas al modelo, herramientas, detección de bucles, checkpoints, reanudación. |
| [tools.md](./tools.md) | Catálogo de herramientas por familia, permisos por perfil, sandbox del shell y formato de llamadas de cada provider. |
| [skills.md](./skills.md) | Skills empaquetadas, formato `SKILL.md`, carga y selección. |
| [tui.md](./tui.md) | La TUI en Rust: vistas, teclas, modales, protocolo IPC con Bun y modo headless. |
| [development.md](./development.md) | Ejecutar desde fuente, pruebas, variables de entorno, depuración con tmux, publicación. |
| [inventario.md](./inventario.md) | CLI de inventario de productos: comandos, validaciones y archivo de datos. |

## Mapa rápido

```
usuario ─▶ TUI (Rust) ──IPC──▶ REPL (Bun) ─▶ CoordinatorManager ─▶ ProfileHarness
                                                                       │
                                            BEE ── task_delegate ──▶ scout / planner / builder / verifier / spider
                                              │                              │
                                       agent loop (core)  ◀──────────────────┘   cada worker corre el mismo bucle
                                              │
                          herramientas · skills · MCP · HiveDB · providers LLM
```
