# Modos de ejecución

Se eligen con `--mode` (o en la TUI) y se **aplican al ejecutar la herramienta**, no solo en el prompt.

| Modo | Herramientas que mutan | Copia de git |
|------|------------------------|--------------|
| `plan` | Rechazadas con un mensaje que el modelo lee y entiende. | No (solo lectura). |
| `approval` | Preguntan (modal en la TUI; sin terminal, se rechazan). | Sí. |
| `auto` | Se ejecutan. | Sí. |

Mutan: `fs_write`, `fs_edit`, `command_run`, `git_commit`, y toda herramienta MCP. Una tarea
programada (`cron`) solo admite `plan` y `auto`: nadie está delante para aprobar.

En `plan` el agente investiga y propone; no hay un planner aparte ni Spec Kit.
