# Harness y enjambre

## Rutas
El harness pesa la tarea (el enunciado y hechos del proyecto: ¿hay suite de pruebas?, ¿toca varios
módulos?, ¿hay una orden de mutar?) y elige:

- **conversation**: responde, sin cambios.
- **scoped**: un cambio acotado, con verificación determinista al final.
- **feature**: BEE delega en workers, hay Quality Gate y hasta 2 ciclos de reparación.

La ruta y sus señales quedan en el historial (`history --json`).

## Verificación
Determinista, la ejecuta el harness (no el modelo): detecta el ecosistema y corre pruebas, tipos y
compilación. Resultado `pass`, `fail` o `skipped` (p. ej. dependencias de Node sin instalar).

## Enjambre (`--swarm`)
BEE lidera con `task_delegate`, `task_delegate_group` (en paralelo, con `after` entre tareas),
`task_revise`, `task_status` y `wait_for`. Perfiles: `bee`, `scout`, `builder`, `verifier`, `spider`;
especialidades: backend, frontend, data, devops, integration, repository, security, acceptance, web.
Cada builder trabaja en su propia copia; todos comparten un único presupuesto
(`HIVECODE_BUDGET_MODEL_CALLS|TOOL_CALLS|OUTPUT_TOKENS|MINUTES`). El informe del scout se reutiliza
si el proyecto no cambió.
