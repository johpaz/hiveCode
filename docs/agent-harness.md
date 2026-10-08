# Harness de agentes

hiveCode sigue el modelo operativo de Hive: un coordinador (BEE) en el loop nativo que **delega a workers en
paralelo**, juzga la evidencia que vuelve y se apoya en un **oráculo de decisión** (Jev / Kev) para decidir qué
entra al prompt. No hay un DAG ejecutado por código.

## Perfiles

| Agente | Perfil | Rol |
|---|---|---|
| `bee` | `orchestrate` | Único interlocutor del usuario. Delega con `task_delegate`, juzga y consolida. |
| `scout` | `read_only` | Investigación sin modificar nada. |
| `planner` | `read_only` | Convierte un objetivo complejo en spec, plan y tareas con dueño (Spec Kit). No implementa. |
| `builder` | `write_workspace` | Implementa una tarea acotada. |
| `verifier` | `verify` | Quality Gate: reproduce los criterios de aceptación y revisa el diff. |
| `spider` | `web_automation` | Búsqueda, scraping y automatización de navegador. |

Definidos en `packages/core/src/agent/agent-profiles.ts`.

## Delegación

- `task_delegate(worker_id, task_description, acceptance?)` ejecuta a un worker y devuelve su handoff más la
  evidencia contra los **criterios de aceptación**. Un criterio con `checkTool` se decide sin LLM; el resto lo
  juzga BEE con la evidencia (`acceptance_met`: `true` / `false` / `null`).
- **Paralelo**: varias llamadas `task_delegate` en el mismo paso corren a la vez cuando son workers distintos y
  como máximo uno puede escribir el workspace (los demás son de solo lectura), o cada escritor tiene su propio
  workspace. Esa regla estructural (`structuralParallelism`, `agent/jev-planner.ts`) decide **sin oráculo**;
  con Jev/Kev activo, además se les pregunta si las operaciones son independientes. Los lotes de lecturas
  independientes también van en paralelo. Máximo 3 workers simultáneos.
- **Fan-in**: BEE es el fan-in. Si una entrega no cumple, `task_revise(task_id, feedback)` la devuelve al mismo
  worker, en el mismo hilo (`delegationThreadId`), con su entrega anterior y la retroalimentación.
- Cada delegación es un `TaskDoc` (`task_status` la consulta). El worker hereda `approvedExecution` del padre.

Diferencia con Hive: Hive continúa los jobs en una cola durable del gateway y despierta a BEE con un turno de
fan-in. hiveCode corre en un solo proceso, así que ese fan-in ocurre dentro del turno de BEE.

## Tareas largas (`ProfileHarness`)

`harness/profile-harness.ts` solo impone lo que debe cumplirse decida lo que decida el modelo: enrutado,
aprobaciones, presupuesto de reparación y reanudación.

1. `conversation`: BEE responde.
2. `simple_change`: BEE delega a `builder` (sin Spec Kit).
3. Tarea compleja:
   1. BEE delega el plan a `planner` → `specs/<feature>/{spec,plan,tasks}.md`.
   2. Política `approval`: gate de aprobación de la especificación (`plan` se detiene aquí).
   3. BEE ejecuta: delega las tareas listas en paralelo, juzga y usa `task_revise`; delega el Quality Gate a
      `verifier` y termina con `VERDICT: PASS|FAIL`. Ante `FAIL`, hasta 2 ciclos de reparación.
   4. BEE converge (`speckit_converge`); en `approval`, segundo gate de aprobación.

`AdaptiveScheduler` (`harness/adaptive-scheduler.ts`) ya no gobierna esta ejecución; sigue ahí por
`classifyTask`, `speckit_tasks_sync` y la cola `jobQueue`.

## Oráculo de decisión: Jev → Kev → clásico

Un modelo pequeño responde preguntas cerradas (`noul`, `choice`) sin generar texto. Decide qué historial,
tools, skills, notas y reglas entran al prompt (`planJevContext`), qué resultados viejos se omiten entre
iteraciones (`planJevIteration`) y si un lote de tools puede ir en paralelo (`jevWantsParallel`).

Prioridad, en `resolveOracles` (`agent/jev-decisions.ts`):

1. **Jev** (`typesafe/jev-1.13`, API Decisions de OpenRouter): provider `openrouter` habilitado, activo y con key.
2. **Kev** (`POST <base>/v1/systemone`, `model: "kev"`, LLM de HiveAgents): provider `hiveagents` habilitado,
   activo y con key. Sin coste por decisión.
3. **Clásico**: sin oráculo, el compilador y el loop corren como siempre.

`askJev` prueba los oráculos en ese orden: si Jev falla o está en cooldown se intenta Kev, y si ambos fallan
devuelve `null` y el turno sigue por el camino clásico. Kev sirve un contexto de 8192 tokens: una petición de
más de `KEV_MAX_REQUEST_CHARS` se salta Kev en vez de pedirla. `recordOracleOverruled` aparta a un oráculo
durante 5 minutos tras 3 decisiones que el runtime tuvo que corregir.
