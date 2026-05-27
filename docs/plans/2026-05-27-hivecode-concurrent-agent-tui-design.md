# hiveCode: Agente de Codigo Concurrente con TUI Nativa

Fecha: 2026-05-27  
Estado: Diseno validado para implementacion  
Alcance: `packages/code`, servicios de `packages/core` usados por el agente,
IPC local y `packages/hivetui`

## 1. Objetivo

`hiveCode` no es una CLI de ejecucion de comandos. Es un agente de codigo
completo, conversacional y concurrente. El usuario describe objetivos en el
chat; BEE interpreta la intencion, investiga el repositorio, decide si basta
una respuesta o un fix, construye planes cuando corresponde y coordina
workers especializados para ejecutar el trabajo.

La TUI Rust es la superficie principal de operacion del agente. Debe permitir
conversar, observar tareas y workers concurrentes, revisar planes, aprobar
acciones riesgosas, inspeccionar cambios y configurar el harness. La TUI no
debe contener reglas de negocio del agente ni reemplazar el runtime Bun.

El diseno visual actual se conserva como requisito del producto. La mejora
propuesta fortalece arquitectura, componentes, semantica de estados,
seguridad y rendimiento sin redisenar la identidad visual investigada.

## 2. Decisiones Principales

1. La entrada de trabajo es el chat, no comandos como `/run` o `/task create`.
2. Los comandos `/...` son para configuracion y diagnostico del sistema:
   providers, modelos, MCP, skills, herramientas, preferencias y salud.
3. `planning` es una etapa de una tarea; `auto` y `approval` son politicas de
   ejecucion. No son tres estados mutuamente excluyentes.
4. Una sesion puede contener varias tareas con etapas y politicas diferentes.
5. Una tarea puede ejecutar workers en paralelo, y varias tareas pueden estar
   activas a la vez cuando su aislamiento y politicas lo permiten.
6. Toda tarea que modifique codigo debe llegar a ejecutarse en un workspace
   aislado, preferiblemente una rama y `git worktree` temporal propios.
7. Bun posee orquestacion, herramientas, politicas, persistencia y eventos.
   Rust posee interaccion terminal, proyecciones visuales y render.
8. El IPC local por Unix domain socket se conserva; debe volverse versionado,
   secuenciado, resistente a backpressure y apto para tareas concurrentes.
9. La TUI se mejora con un kit de componentes Rust interno inspirado en las
   ideas utiles de `tuie`, sin adoptar su framework o runtime.

## 3. Situacion Actual

### Capacidades existentes que se conservan

- BEE como punto de entrada de las solicitudes de codigo.
- Coordinadores especializados y Bun Workers.
- Ejecucion paralela de fases del mismo nivel mediante `Promise.all()`.
- Modos visibles `plan`, `approval` y `auto` como experiencia ya conocida.
- Narrativa, checkpoints, riesgos, ADRs y memoria.
- TUI Rust basada en `crossterm` y `Canvas` con doble buffer.
- Socket Unix local con envelope NDJSON y fallback TCP en plataformas que lo
  requieren.

### Limites que impiden la arquitectura objetivo

- `CoordinatorManager` conserva un unico `activeTaskId`, `currentLevel` y
  callbacks globales. Varias tareas simultaneas mezclarian trazas, narrativa,
  diffs, approvals y recovery.
- El modo operativo se consulta desde un estado global compartido. Una tarea
  que entra a plan podria cambiar permisos de otra tarea activa.
- La TUI modela una unica tarea: `running`, `plan.current`, `diff` y worker
  activo son globales.
- El IPC identifica eventos por tipo pero no de manera consistente por tarea;
  Rust ignora el `seq` ya enviado en el envelope.
- La priorizacion IPC no evita que eventos de baja prioridad saturen el lector
  y retrasen alertas criticas.
- El detector de conflictos observa modificaciones recientes, pero no reserva
  un archivo antes de que dos workers intenten escribir.
- Las credenciales configuradas por rutas de la TUI pueden persistirse en
  base64 en una columna denominada `api_key_encrypted`, aunque el proyecto ya
  contiene integracion con `Bun.secrets`.
- Las pruebas Rust de la TUI presentan deriva de contrato: una prueba unitaria
  falla y la suite de integracion no compila con los campos actuales.

## 4. Modelo De Producto

### 4.1 Sesion

Una sesion representa la relacion conversacional continua del usuario con el
agente para un proyecto. No representa una sola tarea.

```typescript
interface SessionRuntime {
  sessionId: string
  projectPath: string
  selectedTaskId?: string
  preferences: {
    defaultPlanningStrategy: "direct" | "plan_first"
    defaultExecutionPolicy: "auto" | "approval"
    maxConcurrentTasks: number
    maxConcurrentMutatingTasks: number
  }
}
```

La sesion puede comenzar ejecutando fixes directos en automatico y luego
cambiar la preferencia para que nuevas solicitudes produzcan un plan primero.
Ese cambio no altera retroactivamente tareas ya activas.

### 4.2 Tarea

Una tarea nace cuando BEE determina que una solicitud requiere trabajo
trazable. Una respuesta conversacional simple no tiene que crear una tarea.

```typescript
type TaskStage =
  | "understanding"
  | "planning"
  | "ready"
  | "executing"
  | "waiting_user"
  | "reviewing"
  | "integrating"
  | "completed"
  | "failed"
  | "cancelled"

type ExecutionPolicy = "auto" | "approval"

interface TaskRuntime {
  taskId: string
  sessionId: string
  parentTaskId?: string
  stage: TaskStage
  executionPolicy: ExecutionPolicy
  contextRevision: number
  planId?: string
  workspaceId?: string
  worktreePath?: string
  branchName?: string
  priority: "interactive" | "background"
  createdBy: "user" | "bee" | "worker"
}
```

Una tarea puede generar subtareas paralelas cuando BEE o Architecture
determinan que son independientes. Cada subtarea conserva trazas, eventos y
ownership propios.

### 4.3 Plan Como Artefacto

Un plan no es solo texto que se pinta en una vista. Es un artefacto persistente
producido desde un contexto versionado.

```typescript
interface PlanArtifact {
  planId: string
  taskId: string
  contextRevision: number
  status: "draft" | "ready" | "accepted" | "obsolete" | "executing" | "completed"
  decision: AdrDocument
  phases: PlannedPhase[]
  risks: PlanRisk[]
  inspectedFiles: Array<{ path: string; contentHash: string }>
  suggestedExecutionPolicy: ExecutionPolicy
}
```

Antes de ejecutar un plan, el runtime valida los hashes relevantes. Si otra
tarea cambio archivos que invalidan sus supuestos, el plan pasa a `obsolete`;
BEE actualiza el plan o solicita decision del usuario.

## 5. Planning Y Politicas Dinamicas

### 5.1 Separacion interna

La etiqueta visible `PLAN` se conserva en la TUI, pero internamente significa
`task.stage === "planning" || task.stage === "ready"` con un plan disponible.
`AUTO` y `APPROVAL` describen como se aplicaran cambios, no si existe o no un
plan.

Ejemplos validos dentro de una misma sesion:

```text
Task A: executing  / auto       aplicando un fix acotado
Task B: planning   / approval   preparando una migracion delicada
Task C: ready      / auto       plan listo para implementarse
Task D: waiting_user            esperando aprobacion destructiva
```

### 5.2 Transiciones

```text
understanding -> executing(auto)
  Fix acotado y permitido por las politicas.

understanding -> planning
  Usuario solicita plan o BEE detecta complejidad/riesgo.

planning -> ready
  Existe un PlanArtifact valido y visible.

ready -> executing(auto)
  Usuario pide implementarlo o acepta ejecucion directa.

ready -> executing(approval)
  Usuario exige revision o BEE solicita control por riesgo.

executing(auto) -> planning
  Se detienen nuevas mutaciones en un punto seguro, se conserva contexto y
  se genera un plan antes de continuar.

executing(*) -> waiting_user
  Se requiere aprobacion, aclaracion o resolucion de conflicto.
```

### 5.3 Autoridad del agente y del usuario

- El usuario puede pedir planning en lenguaje natural en cualquier momento.
- BEE puede recomendar o iniciar planning para reducir riesgo.
- BEE puede reducir autonomia: de ejecucion automatica a una solicitud de
  aprobacion.
- BEE no puede aumentar autonomia de `approval` a `auto` para una tarea
  mutante sin aceptacion contextual del usuario.
- Una preferencia global de sesion solo define el valor inicial para nuevas
  tareas. Cada tarea activa posee su propia politica efectiva.

## 6. Interaccion En La TUI

### 6.1 Entrada principal

La barra de entrada opera como chat por defecto. El usuario escribe solicitudes
de codigo, aclaraciones, decisiones o cambios de intencion:

```text
Corrige el error de autenticacion.
Antes de tocar la migracion, arma un plan.
Implementa ese plan pero preguntame antes de modificar el schema.
Continua con el fix; deja el refactor para despues.
```

BEE interpreta estas entradas y opera sobre la tarea apropiada o crea una
nueva. La TUI no obliga al usuario a administrar tareas manualmente.

### 6.2 Comandos de configuracion

Al comenzar con `/`, la entrada cambia a configuracion del harness:

```text
/provider    configurar providers y credenciales
/model       seleccionar modelos por provider
/mcp         configurar servidores MCP y sus tools
/skill       habilitar, deshabilitar o inspeccionar skills
/tool        permisos y diagnosticos de herramientas
/mode        preferencia inicial para solicitudes nuevas
/doctor      salud del runtime, IPC, sandbox y providers
/logs        diagnostico tecnico
/help        ayuda de configuracion
```

Los comandos `/run`, `/plan`, `/approve`, `/reject`, `/task cancel` o
equivalentes no forman parte de la experiencia primaria. Pueden mantenerse
temporalmente como compatibilidad, pero no deben orientar el diseno.

### 6.3 Acciones contextuales

La operacion del agente ocurre en el contexto visual de la tarea:

- Plan listo: `Ejecutar`, `Ejecutar con aprobacion`, `Solicitar ajuste`,
  `Descartar`.
- Herramienta peligrosa: confirmar o rechazar la accion concreta mostrando
  tarea, worker, archivos e impacto.
- Conflicto de integracion: revisar diff, pedir replanificacion o posponer.
- Ejecucion activa: detener una tarea desde su panel enfocado mediante una
  accion contextual o keybinding, no mediante un comando que el usuario deba
  recordar.

## 7. Concurrencia Del Agente

### 7.1 Supervisor de tareas

La sesion debe poseer un `TaskSupervisor`, no un unico manager con tarea
activa global.

```text
SessionRuntime
  -> TaskSupervisor
       -> TaskRuntime A
            -> WorkerSupervisor A
       -> TaskRuntime B
            -> WorkerSupervisor B
       -> TaskRuntime C
            -> WorkerSupervisor C
```

Responsabilidades:

- Crear tareas a partir de decisiones de BEE.
- Asignar politica, prioridad, workspace y presupuesto de workers.
- Limitar concurrencia por provider, modelo, CPU y riesgo.
- Publicar eventos de cada tarea a la TUI.
- Suspender, reanudar y recuperar tareas de manera independiente.

### 7.2 Bun Workers

Los Bun Workers se aprovechan en dos niveles:

- Workers de agente: BEE, Architecture y coordinadores especializados por
  tarea o tomados de pools con ownership exclusivo mientras procesan una fase.
- Workers de herramienta: parseo, busqueda, tests, build y lint mediante pools
  acotados, con resultados etiquetados por `taskId` y `toolCallId`.

No debe mantenerse una unica instancia mutable de cada coordinador sirviendo
varias tareas sin contexto aislado. El scheduler puede reutilizar procesos
idle, pero nunca estado conversacional ni callbacks de tareas diferentes.

### 7.3 Aislamiento de workspace

Estado final recomendado:

- Tareas solo lectura pueden ejecutarse sobre el workspace base.
- Toda tarea que vaya a mutar codigo recibe rama y `git worktree` temporal.
- Workers internos de esa tarea operan dentro de su worktree.
- La integracion al branch objetivo es otra etapa visible, con revision o
  aprobacion segun riesgo.

Transicion practica:

- Primera entrega: varios analisis/planes concurrentes y como maximo una tarea
  mutante sobre el workspace base.
- Entrega posterior: multiples tareas mutantes concurrentes con worktrees.

### 7.4 Leases dentro de una tarea

Aunque las tareas esten aisladas entre si, varios workers de una misma tarea
pueden intentar modificar el mismo archivo. Antes de una mutacion se requiere
un lease transaccional:

```typescript
interface WorkspaceLease {
  taskId: string
  workspaceId: string
  path: string
  heldByWorker: string
  operation: "write" | "edit" | "delete"
  expiresAt: number
}
```

El lease se adquiere antes del checkpoint y antes de ejecutar la tool; se
libera al terminar o al fallar. Un conflicto ya no depende solamente de
observar escrituras ocurridas en los ultimos segundos.

## 8. Servicios Del Core

El actual `CoordinatorManager` debe reducirse progresivamente a una fachada de
compatibilidad mientras se extraen servicios con ownership claro:

```text
ConversationRouter
  BEE interpreta mensajes y decide respuesta, tarea o cambio contextual.

TaskSupervisor
  Multiples TaskRuntime en una sesion.

TaskOrchestrator
  State machine, fases, PlanArtifact y transitions de una tarea.

WorkerSupervisor
  Ciclo de vida y pools de Bun Workers por tarea.

ToolExecutionService
  Invoca herramientas, maneja pool pesado y produce trazas.

ToolPolicyGate
  Capabilities por rol, policy de tarea, approvals y sandbox.

WorkspaceManager
  Worktrees, leases, cambios e integracion.

CheckpointService
  Snapshot y rollback por tarea/workspace.

NarrativeService
  Narracion operativa persistida y proyectable a la TUI.

TuiSessionService
  IPC, snapshots, replay, backpressure y comandos de configuracion.

SecretStore
  Lectura y escritura segura de credenciales.
```

Ninguna tool debe decidir por si sola la politica completa. La tool valida su
entrada localmente, pero `ToolPolicyGate` es la autoridad comun antes de toda
ejecucion.

## 9. Narrativa Y Observabilidad

La TUI debe mostrar lo que el agente esta haciendo y por que es relevante para
la tarea, sin depender de streams de razonamiento interno del modelo.

Eventos narrables:

- BEE esta inspeccionando el contexto requerido.
- Architecture preparo un plan con riesgos concretos.
- Backend modifico un archivo bajo un checkpoint.
- Tests fallaron con un resumen verificable.
- Una accion necesita aprobacion por impacto.
- Una tarea quedo bloqueada por conflicto o por invalidacion de plan.

No se debe tratar `thinking` privado como fuente contractual de interfaz. El
core emite narrativa estructurada y segura, separada de diagnosticos internos.

## 10. Persistencia Y Ownership

La persistencia debe distinguir configuracion global, sesion conversacional y
estado de tareas:

```text
Global DB
  providers metadata, modelos, MCP, skills, memoria y configuracion.

Session DB o namespace de sesion
  mensajes de chat, selected task, eventos de sesion y preferencias.

Task records
  runtime state, PlanArtifact, fases, tool traces, approvals, narrative,
  checkpoints, leases, diffs, worktree e integracion.
```

Se recomienda introducir un log de eventos con secuencia monotona por sesion:

```typescript
interface DomainEvent {
  sessionId: string
  seq: number
  taskId?: string
  eventId: string
  kind: string
  occurredAt: string
  payload: unknown
}
```

Las tablas de lectura rapida para TUI pueden ser proyecciones derivadas. De
esta manera, una reconexion IPC solicita snapshot y eventos posteriores a
`seq`, sin reconstruir estado desde callbacks inconexos.

## 11. Protocolo IPC TUI

### 11.1 Frontera

La comunicacion permanece local:

```text
Bun TuiSessionService <-> Unix domain socket NDJSON <-> hivetui Rust
```

TCP local se mantiene solo como fallback compatible.

### 11.2 Envelope

```typescript
interface TuiEnvelope<T> {
  protocolVersion: 1
  sessionId: string
  seq: number
  priority: "critical" | "normal" | "low"
  taskId?: string
  type: string
  payload: T
}
```

Todo evento de una tarea debe incluir `taskId`. Rust conserva `seq`, detecta
huecos y puede solicitar un snapshot o replay.

### 11.3 Eventos principales

```text
session_snapshot
task_created
task_selected
task_stage_changed
task_policy_changed
task_completed
plan_ready
plan_obsolete
approval_requested
approval_resolved
worker_started
worker_activity
worker_finished
tool_started
tool_finished
file_lease_conflict
file_changed
diff_updated
checkpoint_created
checkpoint_restored
narrative_appended
system_alert
configuration_changed
```

La TUI envia intents, no mutaciones directas del estado:

```text
chat_submit
select_task
plan_action
approval_decision
stop_task
configuration_command
request_snapshot
```

### 11.4 Prioridad y backpressure

- `critical`: aprobaciones bloqueantes, errores, conflicto de lease, perdida
  de conexion e invalidacion peligrosa de un plan. No se descartan.
- `normal`: cambios de etapa, narrativa final, checkpoints y diffs activos.
- `low`: deltas de progreso, logs y actividad repetitiva. Se coalescen por
  `(taskId, workerId, type)` cuando la cola esta ocupada.

El lector Rust nunca debe esperar en una cola `low` llena antes de enrutar un
evento critico posterior. La capa de recepcion debe usar coalescing o envio no
bloqueante para eventos descartables.

## 12. Arquitectura De La TUI Nativa

### 12.1 Responsabilidad

`hivetui` es una aplicacion de proyeccion e interaccion:

- Recibe eventos y construye vistas por tarea.
- Mantiene seleccion, scroll, input, modales y shortcuts locales.
- Envia intents del operador.
- No decide routing de agentes, permisos de tools, validez de planes ni
  ownership de archivos.

### 12.2 Estado

```rust
struct AppState {
    session: SessionProjection,
    tasks: TaskStore,
    selected_task_id: Option<TaskId>,
    interaction: InteractionState,
    render: RenderState,
}

struct TaskProjection {
    stage: TaskStage,
    policy: ExecutionPolicy,
    narrative: Vec<NarrativeEntry>,
    plan: Option<PlanProjection>,
    workers: Vec<WorkerProjection>,
    diffs: Vec<DiffProjection>,
    approvals: Vec<ApprovalProjection>,
    checkpoints: Vec<CheckpointProjection>,
    alerts: Vec<AlertProjection>,
}
```

Esto reemplaza la suposicion actual de una unica tarea global.

### 12.3 Componentes internos

Se conserva `Canvas` y se construye una biblioteca nativa reusable:

```text
ui/layout
  Constraint, Row, Column, Split, Grid, Panel

ui/text
  CellWidth, StyledSpan, WrappedText, MarkdownBlock, CodeBlock, Overflow

ui/components
  Header, Badge, Tabs, Table, VirtualList, Scrollbar, Modal, Input,
  CommandPalette, DiffView, ActivityFeed, AlertBar

ui/screens
  Focus, Plan, Code, Review, Dashboard, Configuration
```

Ideas utiles de `tuie` que se pueden adoptar conceptualmente:

- constraints flexibles en lugar de `vsplit`/`hsplit` con numeros fijos;
- medicion centralizada por celdas y overflow consistente;
- composicion de tablas mediante grid;
- listas virtualizadas para narrativa, workers y logs;
- inputs y modales reutilizables.

No se incorpora `tuie` como dependencia ni se cambia la base Rust/crossterm.

### 12.4 Semantica de las vistas

- `Focus`: chat y narrativa de la tarea seleccionada, con selector liviano de
  tareas concurrentes.
- `Plan`: `PlanArtifact` activo y acciones contextuales.
- `Code`: diff, archivos, tool activity y workers de la tarea seleccionada.
- `Review`: approvals, riesgos, checkpoints e integracion del resultado.
- `Dashboard`: todas las tareas activas, bloqueadas y finalizadas recientemente,
  mas capacidad ocupada de workers.
- `Configuration`: modal/panel abierto por comandos de configuracion, sin
  desviar el chat como experiencia central.

## 13. Rendimiento

La garantia deseada no es dibujar continuamente a 60 fps; es mantener
interaccion fluida y no perder eventos importantes bajo concurrencia.

### Scheduler de frames

- Eventos de teclado, resize y alertas criticas: render inmediato.
- Streaming, actividad de workers y progreso: agrupar en el siguiente frame,
  con limite maximo de 60 frames por segundo durante actividad.
- Terminal inactiva: sin loop de redraw continuo salvo actualizaciones
  visuales estrictamente necesarias.
- Eventos de tareas no visibles: actualizar proyecciones y badges; no recalcular
  markdown/diff del panel oculto.

### Optimizaciones

- Mantener flush diferencial de `Canvas`.
- Hacer que `DirtyFlags` controle invalidacion real de regiones y caches.
- Cachear wrapping/markdown/diff por `(revision, width)`.
- Centralizar medicion Unicode por celdas; no usar `chars().count()` para
  calcular columnas visuales.
- Virtualizar narrativa, logs, archivos y workers extensos.
- Coalescer actividad `low` en IPC.

### Metricas y criterios

```text
input_to_visible_ms        p95 <= 16.7 ms durante actividad normal
critical_event_visible_ms  p95 <= 16.7 ms con cola low saturada
render_ms                  medido por frame y por pantalla
flush_ms                   medido por frame
changed_cells              medido por frame
ipc_backlog                por prioridad
ipc_coalesced_low_events   contador visible en doctor/debug
```

No se declarara compatibilidad de 60 fps hasta medir estos valores con tareas
y workers concurrentes.

## 14. Seguridad Y Recuperacion

### Credenciales

- El flujo TUI para providers debe guardar API keys mediante `Bun.secrets` o
  un almacen realmente cifrado.
- Los valores base64 legacy deben migrarse y eliminarse de SQLite tras validar
  que el secreto esta disponible.
- Ninguna narrativa, log o evento IPC puede incluir secrets.

### Herramientas

- Toda herramienta ejecuta bajo workspace asignado a la tarea.
- Herramientas destructivas requieren un `approvalId` durable, no solo
  `confirmed: true` generado dentro de un argumento.
- El policy gate registra quien solicito, quien aprobo y que se ejecuto.

### Recovery

- Checkpoints se vinculan a `taskId` y `workspaceId`.
- Un rollback no puede restaurar archivos de otra tarea o del workspace base
  si la tarea opera en un worktree.
- Ante cierre o reconexion de TUI, las tareas continúan o se pausan segun
  politica; la interfaz reconstruye estado mediante snapshot/replay.

## 15. Proceso De Implementacion

### Fase 0: Baseline y correcciones bloqueantes

Objetivo: asegurar que el sistema actual es una base confiable.

- Reparar pruebas Rust de TUI que fallan o no compilan.
- Corregir almacenamiento de API keys para el flujo configurado desde TUI.
- Inventariar eventos IPC y documentar las reglas visuales que se preservan.
- Añadir instrumentacion inicial de render e IPC sin cambiar la experiencia.

Criterios:

- Suites TUI Rust e IPC relevantes pasan.
- No se escriben nuevas API keys en base64.
- Existe baseline medible de render y entrega IPC.

### Fase 1: Modelo de dominio y protocolo

Objetivo: habilitar varias tareas sin mezclar estado.

- Introducir `TaskStage`, `ExecutionPolicy`, `PlanArtifact` y
  `ModeTransition`.
- Incorporar `taskId`, `protocolVersion` y `seq` al contrato completo TUI.
- Implementar snapshot/replay para reconexion.
- Convertir los modos actuales a compatibilidad sobre el nuevo modelo.

Criterios:

- Una sesion representa dos tareas simuladas con estados independientes.
- Rust muestra datos separados por tarea.
- Un cambio de politica en una tarea no altera herramientas de otra.

### Fase 2: Supervisor concurrente y policy gate

Objetivo: ejecutar varias tareas de lectura/planificacion en paralelo.

- Extraer `TaskSupervisor`, `TaskOrchestrator`, `WorkerSupervisor` y
  `ToolPolicyGate`.
- Etiquetar narrativa, tool traces, phases, approvals y eventos por tarea.
- Implementar limites de concurrencia y cancelacion independiente.
- Incorporar leases de archivo para workers de una misma tarea.

Criterios:

- Dos planes se construyen en paralelo sin mezclar narrativa ni workers.
- Una tarea puede esperar decision mientras otra sigue trabajando.
- Un lease bloquea escrituras simultaneas sobre el mismo archivo.

### Fase 3: Componentes TUI y vistas multitarea

Objetivo: modernizar la TUI manteniendo el diseno actual.

- Crear `ui/layout`, `ui/text` y `ui/components`.
- Migrar primero `Plan`, `Code` y `Dashboard`.
- Introducir selector de tareas y proyecciones por `taskId`.
- Migrar modales de plan/approval a acciones contextuales tipadas.

Criterios:

- No se pierde la identidad visual actual.
- Narrative, diff y workers se ven correctamente para la tarea seleccionada.
- El Dashboard muestra actividad concurrente real.

### Fase 4: Worktrees para tareas mutantes

Objetivo: permitir cambios de codigo concurrentes de forma aislada.

- Crear `WorkspaceManager` para ramas y worktrees temporales.
- Ejecutar tools mutantes en el workspace asignado.
- Mostrar integracion, conflictos y limpieza desde Review.
- Vincular checkpoints y rollback al worktree.

Criterios:

- Dos tareas mutantes operan en worktrees separados.
- Ninguna escritura paralela contamina el working tree base.
- Integracion conflictiva se presenta como decision contextual.

### Fase 5: Rendimiento y endurecimiento

Objetivo: garantizar fluidez operativa bajo carga real.

- Implementar scheduler de frames activo/idle.
- Implementar colas IPC seguras y coalescing low-priority.
- Habilitar cache/dirty rendering real y listas virtualizadas.
- Agregar pruebas de carga headless con muchas tareas/workers/eventos.

Criterios:

- Alertas criticas permanecen visibles con floods de actividad.
- Metricas de latencia satisfacen los SLO definidos.
- No hay perdida de eventos durables ni regresion visual.

## 16. Estrategia De Pruebas

### Core

- State machine de tareas y transiciones planning/policy.
- Dos tareas concurrentes con policies distintas.
- Tool policy por tarea y approval durable.
- Leases transaccionales y expiracion segura.
- Checkpoint/rollback aislado por workspace.
- Migracion y no filtracion de secrets.

### IPC

- Serializacion TypeScript/Rust para cada evento.
- Orden, secuencia, snapshot y replay.
- Flood de eventos low con entrega de critical.
- Reconexion con tareas en estados diferentes.

### TUI

- Reduccion de eventos a proyecciones por tarea.
- Navegacion entre tareas sin contaminacion de plan/diff/narrativa.
- Acciones contextuales de plan y approval.
- Layouts estrechos, Unicode, wrapping, scroll y grandes listas.
- Frames headless con concurrencia simulada.

### Integracion

- Chat produce fix directo y posteriormente un plan en la misma sesion.
- BEE solicita approval por riesgo durante ejecucion automatica.
- Dos planes concurrentes; uno se ejecuta mientras el otro espera usuario.
- Dos tareas mutantes en worktrees con integracion posterior.

## 17. Orden De Decisiones Cerradas

Quedan adoptadas estas decisiones para implementar:

- TUI Rust como interfaz primaria; la UI web queda fuera de este diseno.
- Entrada conversacional para trabajo del agente.
- Comandos restringidos a configuracion y diagnostico.
- Planning como etapa; auto/approval como politica.
- Politicas efectivas por tarea en una misma sesion.
- Supervisores y eventos por tarea para concurrencia real.
- Worktree por tarea mutante como destino arquitectonico.
- IPC local versionado y prioritario.
- Componentes nativos Rust, sin incorporar un framework TUI externo.
- Conservacion del lenguaje visual actual.

La implementacion debe comenzar por la Fase 0 y la Fase 1. Modernizar widgets
antes de estabilizar secrets, contratos y ownership multitarea produciria una
interfaz mas elaborada sobre un modelo que todavia confunde tareas concurrentes.
