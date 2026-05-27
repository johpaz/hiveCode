# El Harness de hiveCode

## ¿Qué es un AI Harness?

Un **AI Harness** (arnés de IA) es la infraestructura que rodea a los modelos de lenguaje y les da capacidad de operar. No es el agente que "piensa" — es todo lo demás: el ciclo de vida, los permisos, la ejecución de herramientas, la memoria entre sesiones, la comunicación entre procesos y la recuperación ante fallos.

La analogía es precisa: un arnés de escalada no escala la montaña, pero le da al escalador seguridad, control y herramientas para hacerlo. Sin harness, un LLM es solo un generador de texto. Con harness, es un agente autónomo que puede actuar sobre el mundo real.

### Qué resuelve un harness

| Problema | Sin harness | Con harness |
|----------|------------|------------|
| El LLM pide ejecutar una herramienta | Imposible — el LLM no tiene acceso | El harness la ejecuta y devuelve el resultado |
| El contexto supera el límite de tokens | El LLM corta o alucina | El harness compacta el contexto preservando lo esencial |
| Dos agentes modifican el mismo archivo | Colisión silenciosa | El harness detecta la colisión antes de que ocurra |
| El agente falla por tercera vez en lo mismo | Loop infinito | El harness activa el ForensicAgent |
| La sesión se interrumpe a mitad | Todo se pierde | El harness retoma desde el último checkpoint |
| El agente necesita saber qué aprendió antes | Cada sesión empieza de cero | El harness inyecta memoria relevante del proyecto |

---

## Las 4 capas del harness de hiveCode

hiveCode implementa un harness completo en 4 capas apiladas. Cada capa resuelve un nivel distinto del problema de orquestación.

```
┌─────────────────────────────────────────────────────────────────┐
│  CAPA 4 — Harness de Memoria                                    │
│  Librarian · Reflector · ContextCompiler                        │
│  Aprende entre sesiones, inyecta conocimiento acumulado         │
├─────────────────────────────────────────────────────────────────┤
│  CAPA 3 — Harness de Sincronización                             │
│  Blackboard · ConflictDetector · IpcEmitter                     │
│  Coordina 13 workers paralelos sin colisiones                   │
├─────────────────────────────────────────────────────────────────┤
│  CAPA 2 — Harness de Coordinación                               │
│  CoordinatorManager                                             │
│  Agrupa workers por nivel de dependencia, Promise.all()         │
├─────────────────────────────────────────────────────────────────┤
│  CAPA 1 — Harness Individual                                    │
│  WorkerHandler                                                  │
│  Loop LLM → tool_call → tool_result → LLM para un agente       │
└─────────────────────────────────────────────────────────────────┘
```

---

### Capa 1 — Harness Individual (`worker-handler.ts`)

Envuelve a **un único agente LLM**. Gestiona el ciclo `LLM → tool_call → tool_result → LLM` de forma iterativa hasta que el agente produce una respuesta final o agota sus iteraciones.

**Responsabilidades:**
- Construir el mensaje inicial con el contexto compilado
- Llamar al LLM del provider configurado (Anthropic, OpenAI, Gemini, Ollama)
- Enviar `TOOL_CALL` al CoordinatorManager y esperar `TOOL_RESULT`
- Compactar el historial de mensajes cuando supera el 75% del límite de contexto
- Retornar `CoordinatorResult` con narrativa, archivos modificados y tokens usados

**Compactación de contexto** — cuando los tokens acumulados superan el umbral:
1. Preserva: system prompt + primer mensaje de usuario + últimos 4 mensajes
2. Compacta: todos los resultados de tool calls intermedios en un resumen estructurado
3. Continúa el loop sin perder el hilo de la tarea

**Archivos clave:**
- `packages/code/src/workers/worker-handler.ts` — implementación del loop
- `packages/code/src/workers/types.ts` — contratos `CoordinatorTask` y `CoordinatorResult`

---

### Capa 2 — Harness de Coordinación (`coordinator-manager.ts`)

Orquesta los **13 workers especializados** del enjambre. Agrupa las fases definidas por Architecture en niveles de dependencia y ejecuta cada nivel en paralelo con `Promise.all()`. El siguiente nivel solo comienza cuando todos los del nivel anterior reportaron `done` o `failed`.

**Responsabilidades:**
- Arrancar y detener los workers (`startAll()`, `stopAll()`)
- Despachar tareas a workers específicos (`dispatchPhase()`)
- Ejecutar herramientas en nombre de los workers (`handleToolCall()`)
- Gestionar el pool de 4 tool-workers para herramientas pesadas
- Aplicar checkpoints de recovery antes de cada nivel
- Activar ForensicAgent cuando un worker agota sus iteraciones
- Activar Librarian cuando el CodeReviewer aprueba

**Ciclo de vida de una tarea:**

```
runTask(description, mode)                  ← modo inicial siempre: "auto"
  │
  ├── BEE clasifica: respond | fix | dispatch | architecture
  │
  ├── respond / fix
  │     └── resuelve directamente · no activa ningún worker · retorna
  │
  └── dispatch / architecture
        │
        ├── ProductManager (Nivel 0 — siempre primero)
        │     └── PRD completo · sin esto no puede haber Architecture
        │
        ├── Architecture (Nivel 1)
        │     └── ParsedPlan → groupPhasesByLevel()
        │
        ├── Para cada nivel (2, 3, …):
        │     ├── saveRecoveryPoint()   ← checkpoint antes de cada nivel
        │     ├── Promise.all(levelPhases.map(dispatchPhase))
        │     └── Si fallo → ForensicAgent → relanzar con constraint
        │
        └── finalizeTask()
              ├── Learning Harness: evaluateTaskPhases() → writeProposal() si hay fricción
              ├── updateTaskStatus("completed")
              └── ACE Reflector (si N tareas acumuladas)
```

**Modos de sesión** — BEE conoce el modo activo y adapta su comportamiento:

| Modo | Comportamiento |
|------|---------------|
| `auto` *(inicial)* | BEE ejecuta sin pedir confirmación. Úsalo para desarrollo normal. |
| `plan` | BEE produce un plan y espera `APPROVED` antes de despachar workers. |
| `approval` | Cada fase individual requiere aprobación del operador antes de ejecutar. |

El modo `auto` es el estado de arranque. BEE lee el modo desde `SessionMode` en el `CoordinatorTask` recibido y puede cambiar a `plan` o `approval` si el operador lo indica via TUI.

**Pool de tool-workers** — herramientas pesadas no bloquean el hilo principal:

```
Tool call llega al CoordinatorManager
  │
  ├── ¿Es heavyTool? (code_search, parse_ast, code_build)
  │     └── Sí: executeInToolWorker() → pool de 4 Bun Workers dedicados
  │
  └── No: executeToolByName() en el hilo principal
```

**Archivos clave:**
- `packages/code/src/workers/coordinator-manager.ts` — 1600+ líneas, núcleo del harness
- `packages/code/src/workers/tool-bridge.ts` — `getToolsForCoordinator()`, mapeo de tools por rol

---

### Capa 3 — Harness de Sincronización

Permite que **13 workers paralelos** trabajen en el mismo codebase sin colisionar. Usa SQLite como bus de mensajes compartido — todos los workers leen y escriben en la misma base de datos de sesión.

#### Blackboard (`blackboard.ts`)

La "pizarra compartida" de la sesión. Cada worker escribe sus decisiones, y BEE las lee para tomar decisiones de coordinación.

```typescript
// Worker escribe una decisión
blackboard.write("backend", "decision", "Implementando auth con JWT — endpoint POST /auth/login")

// BEE lee el estado de todos los workers
const awareness = await blackboard.beeAwareness()
// → { backend: "running", frontend: "idle", security: "blocked_by_question" }

// Worker A pregunta a Worker B (mediado por BEE)
await blackboard.askWorker("frontend", "backend", "¿El token viene en header Authorization o en cookie?")
```

**Tipos de entrada en el blackboard:**

| Tipo | Quién escribe | Qué registra |
|------|--------------|-------------|
| `decision` | BEE, Architecture | Decisión de routeo o constraint |
| `reasoning` | Cualquier worker | Razonamiento intermedio |
| `observation` | Cualquier worker | Hallazgo sin bloqueo |
| `question` | Worker → BEE | Pregunta dirigida a otro worker |
| `constraint` | BEE | Restricción que un worker no puede violar |

#### ConflictDetector (`conflict-detector.ts`)

Se activa antes de que cualquier worker escriba un archivo. Detecta 4 tipos de colisión:

| Tipo | Condición | Severidad |
|------|-----------|-----------|
| `file_collision` | Otro worker tocó este archivo en los últimos 30s | high |
| `decision_clash` | Dos decisions contradictorias en el blackboard | medium |
| `adr_violation` | La escritura viola un constraint del ADR activo | critical |
| `dependency_race` | El archivo depende de uno que aún está siendo modificado | medium |

Si la severidad es `low`/`medium`, BEE resuelve autónomamente y continúa. Si es `critical`, emite HALT y escala al operador.

#### IpcEmitter (`ipc-emitter.ts`)

Interfaz mínima que permite a los subsistemas emitir eventos sin acoplarse al transporte. En producción el adaptador es el gateway (Unix socket `~/.hivecode/tui.sock`). En tests es un spy.

**Archivos clave:**
- `packages/code/src/context/blackboard.ts`
- `packages/code/src/context/conflict-detector.ts`
- `packages/code/src/context/ipc-emitter.ts`
- `packages/core/src/ipc/server.ts` — servidor del Unix socket

---

### Capa 4 — Harness de Memoria

Cierra el ciclo de aprendizaje: el conocimiento de cada sesión aprobada se destila y se inyecta en sesiones futuras.

#### Flujo completo de memoria

```
Sesión termina (CodeReviewer: APROBADO)
  │
  ▼
Librarian lee el blackboard completo de la sesión
  │
  ▼ (destila, no transcribe)
agent_memory.db (FTS5)
  ├── pattern       — enfoque que funcionó
  ├── antipattern   — enfoque que falló
  ├── contract      — interfaz entre módulos establecida
  ├── convention    — convención del proyecto descubierta
  └── forensic_lesson — lección de un fallo analizado

  ▼ (próxima sesión)
ContextCompiler.compile(agent, task)
  ├── FTS5 query por relevancia semántica
  ├── Filtra por tipo según el rol del worker (ver tabla en README)
  └── Inyecta como sección "# PROJECT MEMORY" en el system prompt
```

#### Depreciación de conocimiento

Los registros tienen `confirmed_count` / `refuted_count`. Cuando una sesión valida un patrón, incrementa `confirmed_count`. Cuando lo refuta, incrementa `refuted_count`. Si `refuted_count > confirmed_count + 2`, el registro se marca como `deprecated` — pero nunca se borra. La trazabilidad se preserva.

**Archivos clave:**
- `packages/code/src/workers/librarian.worker.ts` — destilación post-sesión
- `packages/core/src/agent/context-compiler.ts` — inyección en workers
- `packages/core/src/agent/reflector.ts` — ACE Reflector (reglas de playbook)

---

## Learning Harness — Autocorrección

El **Learning Harness** es la quinta capa implementada sobre las cuatro anteriores. Cierra el ciclo de mejora continua: el sistema detecta sus propios fallos durante la ejecución, los registra, y genera propuestas de mejora que el operador puede aprobar y aplicar.

### El problema que resuelve

Las capas 1–4 del harness gestionan la ejecución y el aprendizaje entre sesiones, pero no capturan **qué falló dentro de una sesión**. Si un tool falla repetidamente, si una fase siempre necesita reintento, o si un coordinador sistemáticamente produce outputs que el CodeReviewer rechaza, esta información se perdía.

El Learning Harness convierte esos fallos en señal estructurada.

### Tablas nuevas

**`learning_failures`** — log append-only de cada fallo detectado:

```sql
CREATE TABLE learning_failures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT REFERENCES code_tasks(id),
  phase_id        TEXT REFERENCES code_task_phases(id),
  agent           TEXT NOT NULL,         -- "backend", "frontend", etc.
  failure_type    TEXT NOT NULL,         -- "tool_error" | "phase_failure" | "invalid_output" | "plan_drift" | "timeout"
  error_message   TEXT NOT NULL,
  context_summary TEXT,
  resolved        INTEGER DEFAULT 0,
  resolution      TEXT,
  created_at      TEXT DEFAULT (...)
);
```

Esta tabla **nunca se actualiza** — solo se agregan filas. Cada fallo es un registro inmutable.

**`learning_proposals`** — propuestas generadas por el sistema:

```sql
CREATE TABLE learning_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agent  TEXT NOT NULL,           -- agente que generó la propuesta
  proposal_type TEXT NOT NULL,           -- "skill_adjust" | "new_skill" | "prompt_change" | "phase_order"
  description   TEXT NOT NULL,
  failure_ids   TEXT NOT NULL DEFAULT '[]',  -- JSON array de IDs de learning_failures
  status        TEXT DEFAULT 'pending',   -- "pending" | "approved" | "rejected"
  created_at    TEXT DEFAULT (...)
);
```

Las propuestas en estado `pending` **no tienen ningún efecto en el sistema**. Son solo observaciones. El operador decide si aplicarlas.

### Los 4 puntos de enganche

El harness se engancha en 4 puntos del código existente. Todos son fire-and-forget — ninguno bloquea el flujo de ejecución.

#### Punto 1 — BEE post-task (`coordinator-manager.ts`, `finalizeTask()`)

Antes de marcar una tarea como `completed`, BEE evalúa las fases de la tarea y genera una propuesta si detectó fricción:

```
Task completa
  │
  ▼
evaluateTaskPhases(taskId)
  ├── Sin fallos → continúa normalmente
  └── Con fallos → getFailurePatterns() → writeProposal(sourceAgent="bee")
  │
  ▼
updateTaskStatus("completed")
```

#### Punto 2a — Phase failure (`coordinator-manager.ts`, `executePhaseLoop()`)

Cuando una fase termina con `status === "failed"`, antes de retornar `false`:

```typescript
this.scribe.writeFailure({
  taskId, phaseId: null, agent: phase,
  failureType: "phase_failure",
  errorMessage: result.blockerDescription
})
```

#### Punto 2b — Tool failure (`coordinator-manager.ts`, `handleToolCall()`)

Después de ejecutar cualquier herramienta, si `success === false`:

```typescript
this.scribe.writeFailure({
  taskId, phaseId: null, agent: name,
  failureType: "tool_error",
  errorMessage: outputSummary,
  contextSummary: `tool=${toolName} args=...`
})
```

#### Punto 3 — Architecture como evaluador (`coordinator-manager.ts`, `compileWorkerContext()`)

Cuando el contexto se compila para el agente `architecture`, se consultan los patrones de fallo acumulados. Si hay patrones con ≥ 3 ocurrencias del mismo tipo, se inyectan en el system prompt y se genera una propuesta:

```
compileWorkerContext("architecture", ...)
  │
  ├── Skills (capa existente)
  ├── Playbook rules (capa existente)
  ├── Agent memory (capa existente)
  ├── Project narrative (capa existente)
  └── NUEVO: getFailurePatterns(minOccurrences=3)
        ├── Sin patrones → nada
        └── Con patrones:
              ├── Inyecta "# PATRONES DE FALLO CONOCIDOS" en el contexto
              └── writeProposal(sourceAgent="architecture") por cada patrón
```

Architecture llega a la sesión ya informado de qué falló antes y puede diseñar el plan evitando esos errores.

### Ciclo completo

```
Task ejecuta
  │
  ├── Tool falla → writeFailure(type="tool_error")       [Punto 2b]
  ├── Phase falla → writeFailure(type="phase_failure")   [Punto 2a]
  │
  ▼
Task completa → evaluateTaskPhases()
  └── Fricción detectada → writeProposal(source="bee")   [Punto 1]

Próxima tarea con Architecture:
  └── getFailurePatterns(min=3) → inyectar + writeProposal(source="architecture")  [Punto 3]

Operador ejecuta: hivecode doctor
  └── Lista propuestas pending con detalle

Operador aprueba:
  ├── Cambio de prompt → hivecode agent edit <name>
  └── Nueva skill      → /skill add
```

### Aplicar propuestas aprobadas

Las propuestas aprobadas se aplican con los comandos que ya existen:

```bash
# Ver propuestas pendientes
hivecode doctor

# Aplicar cambio de prompt a un agente
hivecode agent edit backend

# Agregar una skill nueva
/skill add
```

No hay mecanismo automático de aplicación — el operador es quien decide. El Learning Harness solo alimenta la cola de propuestas; la decisión de aplicarlas es siempre humana.

---

## Comunicación entre capas

### Mensajes manager ↔ worker

Cada worker Bun se comunica con el CoordinatorManager exclusivamente por paso de mensajes (sin shared memory):

```typescript
// Manager → Worker
type ManagerToWorkerMessage =
  | { type: "TASK"; task: CoordinatorTask }        // nueva tarea con contexto completo
  | { type: "TOOL_RESULT"; toolCallId: string; result: string }  // resultado de herramienta

// Worker → Manager
type WorkerToManagerMessage =
  | { type: "RESULT"; result: CoordinatorResult }          // tarea terminada
  | { type: "TOOL_CALL"; toolName: string; toolArgs: any; toolCallId: string }  // necesita tool
  | { type: "THINKING"; content: string; streamId: string }  // stream de razonamiento
```

### CoordinatorTask — qué recibe cada worker

```typescript
interface CoordinatorTask {
  taskId: string
  phaseId: number
  phase: PhaseName
  description: string
  narrative: string            // historial narrativo de la sesión
  mode: SessionMode            // "plan" | "approval" | "auto"
  projectPath: string
  secrets: Record<string, string>    // API keys inyectadas por el manager
  provider: string
  model: string
  tools: Tool[]                      // herramientas permitidas para este rol
  compiledContext: string            // skills + playbook + memory + failure patterns
  conversationHistory?: ConversationTurn[]  // solo para BEE
}
```

### IPC con la TUI

El CoordinatorManager emite eventos hacia la TUI Rust a través del Unix socket `~/.hivecode/tui.sock`. Los eventos tienen 3 niveles de prioridad:

| Prioridad | Eventos |
|-----------|---------|
| **CRITICAL** | `forensic_alert`, `approval_required` |
| **NORMAL** | `worker_update`, `history_append`, `diff_update`, `task_status` |
| **LOW** | `memory_update`, `librarian_progress`, `thinking_chunk` |

---

## Comparación con harnesses externos

| Dimensión | Claude Code Harness | Google ADK + Antigravity (agy) | hiveCode Harness |
|-----------|--------------------|---------------------------------|--------------------|
| **Agentes simultáneos** | 1 | N (jerárquico, dinámico) | 13 (fijos + on-demand) |
| **Coordinación** | Lineal | Árbol jerárquico | Multinivel con dependency graph |
| **Blackboard** | No | No | SQLite FTS5 compartido |
| **Memoria cross-sesión** | MEMORY.md (archivos) | Ninguna nativa | SQLite FTS5 + destilación |
| **Recovery** | Manual | No | Automático (CheckpointManager + ForensicAgent) |
| **Tool execution** | Secuencial | Por agente | Pool de 4 workers paralelos |
| **Detección de colisiones** | No | No | ConflictDetector pre-escritura |
| **Autocorrección** | No | No | Learning Harness (este doc) |
| **Evaluación en producción** | No | Parcial (solo desarrollo) | Continua (cada sesión) |

**Nota sobre Google ADK / Antigravity CLI (`agy`):** El ADK ofrece un harness de evaluación durante el desarrollo (trajectory evaluation, response quality, tool trajectory), pero no cubre producción. Una vez que los agentes están en producción, se pierde visibilidad sobre quality drift y fallos acumulados. El Learning Harness de hiveCode resuelve exactamente este gap — captura fallos en ejecución real y los convierte en propuestas de mejora.

---

## Extensión del harness

### Agregar un nuevo tipo de fallo

El enum `failure_type` en `learning_failures` acepta: `tool_error`, `phase_failure`, `invalid_output`, `plan_drift`, `timeout`. Para agregar uno nuevo:

1. Agregar el valor al CHECK constraint en `schema.ts`
2. Llamar `this.scribe.writeFailure({ failureType: "nuevo_tipo", ... })` en el punto de enganche correspondiente

### Agregar un nuevo coordinador

1. Crear `packages/code/src/workers/nuevo.worker.ts` siguiendo la estructura de cualquier worker existente
2. Agregar el nombre a `COORDINATOR_NAMES` en `coordinator-manager.ts`
3. Agregar la URL del worker al mapa de workers en `startAll()`
4. Definir las herramientas permitidas en `getToolsForCoordinator()` en `tool-bridge.ts`

### Cambiar el umbral de propuestas de Architecture

El umbral de ocurrencias para que Architecture genere una propuesta está en `compileWorkerContext()`:

```typescript
const patterns = this.scribe.getFailurePatterns({ minOccurrences: 3 })
```

Cambia `3` por el valor que necesites.

---

## Archivos clave del harness

| Archivo | Capa | Rol |
|---------|------|-----|
| `packages/code/src/workers/coordinator-manager.ts` | 2, 5 | Núcleo del harness: lifecycle, dispatch, tools, learning |
| `packages/code/src/workers/worker-handler.ts` | 1 | Loop LLM individual |
| `packages/code/src/workers/types.ts` | 1, 2 | Contratos: Task, Result, Messages |
| `packages/code/src/context/blackboard.ts` | 3 | Pizarra compartida SQLite |
| `packages/code/src/context/conflict-detector.ts` | 3 | Detección pre-escritura |
| `packages/code/src/context/ipc-emitter.ts` | 3 | Eventos hacia TUI |
| `packages/code/src/narrative/scribe.ts` | 2, 5 | Persistencia: fases, trazas, learning |
| `packages/code/src/narrative/schema.ts` | 2, 5 | Schema SQLite del motor de código |
| `packages/core/src/agent/context-compiler.ts` | 4 | Inyección de memoria en workers |
| `packages/code/src/workers/librarian.worker.ts` | 4 | Destilación post-sesión |
| `packages/code/src/workers/forensic.worker.ts` | 2 | Análisis de fallos por límite de iteraciones |
| `packages/code/src/workers/bee.worker.ts` | 2 | Coordinador principal, punto de entrada |
