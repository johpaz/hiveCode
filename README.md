# hivecode

**Multi-AI Coding Swarm — Consola-first. Enfocado en código. Multi-proveedor.**

`hivecode` es un sistema de ingeniería de software autónoma impulsado por un enjambre de coordinadores IA especializados. **BEE** actúa como punto de entrada único: recibe la tarea, clasifica la intención, y orquesta los workers en paralelo por niveles de dependencia. El sistema aprende con cada sesión — el conocimiento se destila en `agent_memory` (SQLite) y se inyecta automáticamente en sesiones futuras.

> **Runtime:** Bun >= 1.3.13
> **Base de datos:** SQLite WAL — única fuente de verdad
> **TUI:** Rust + crossterm, renderer custom (`packages/hivetui/`)
> **Licencia:** hivecode-NC-1.0 (no comercial)

**Documentación técnica:**
- [`docs/harness.md`](./docs/harness.md) — arquitectura completa del harness, las 4 capas del sistema, Learning Harness y comparación con Google ADK / Antigravity CLI.
- [`docs/workers.md`](./docs/workers.md) — referencia detallada de los 13 coordinadores, 2 workers on-demand, 18 sub-agentes y tabla completa de herramientas por rol.

---

## Inicio rápido

```bash
# Clonar e instalar
git clone https://github.com/johpaz/hive-code.git hivecode
cd hivecode
bun install

# Arrancar (gateway + TUI)
bun run dev
# o bien: hivecode repl

# Primera vez: configurar un provider
/provider add anthropic
# Introduce la API key cuando se solicite
```

---

## Interfaz: TUI

La interfaz es un **terminal Rust compilado** (`packages/hivetui/`) con renderer custom propio sobre `crossterm` — sin dependencias de Ratatui ni Tui-rs. Se comunica con el proceso Bun vía Unix socket IPC con colas de prioridad (`critical / normal / low`).

### Navegación por tabs (teclas 1–5)

| # | Tab | Contenido |
|---|-----|-----------|
| 1 | **FOCUS** | ThoughtStream (razonamiento BEE en tiempo real, solo modo PLAN) + FilMap de riesgo o ADRs |
| 2 | **PLAN** | ADRs activos + strip de aprobación interactiva (APPROVAL mode) |
| 3 | **CODE** | Diff activo o filemap ÷ panel lateral de workers (se adapta: 60/40 ↔ 40/60 con 3+ workers activos) |
| 4 | **REVIEW** | Hallazgos del CodeReviewer + filemap de riesgo + veredicto (APROBADO / RECHAZADO) |
| 5 | **DASHBOARD** | Grid de tarjetas de workers con estado, progreso, iteraciones y tokens |

La tab activa se enruta automáticamente según el estado de Bun (PLAN → Focus, CODE → Code, REVIEW → Review). El usuario puede fijarla pulsando 1–5.

### Layout general

```
╭─ ⬡ FOCUS[1]  ⬡ PLAN[2]  ⬡ CODE[3]  ⬡ REVIEW[4]  ⬡ DASHBOARD[5] ──── HH:MM:SS  $0.04 ─╮
│                                                                                            │
│  [contenido del tab activo — ver tabla arriba]                                             │
│                                                                                            │
│  ── checkpoint_bar ─────────────────────────────────────────────── [nivel 1 ✓ · nivel 2…] │
│  ── conflict_bar ──────────────────────────────────────── [⚠ conflict: api_shape_mismatch] │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│  > escribe tu tarea aquí_                                    (•ᴗ•) hive  [AUTO]  [tokens]  │
╰────────────────────────────────────────────────────────────────────────────────────────────╯
```

### Paneles y widgets

| Widget | Descripción |
|--------|-------------|
| `header` | Tabbar ⬡ + reloj + costo acumulado de sesión |
| `statusbar` | Modo activo (plan/approval/auto), tokens totales, mensaje de estado de Bun |
| `thought_stream` | Stream de razonamiento en tiempo real del BEE (solo PLAN mode) |
| `workers_panel` | Lista vertical de workers con barra de progreso, iteraciones y nivel |
| `dashboard_layout` | Grid de tarjetas de worker: estado, %, tokens por worker |
| `history` | Historial scroll + navegación horizontal por entrada larga |
| `checkpoint_bar` | Barra de checkpoints de recuperación por nivel; indica cuáles completaron |
| `conflict_bar` | Alerta cuando `agent_conflicts` tiene entradas sin resolver |
| `mascot` | BEE animada en el input: `(•ᴗ•)` auto · `\(^•^)/` plan · `(?•?)` approval |
| `input` | Línea de entrada con autocompletado de slash commands |

### Overlays y modales

| Widget | Activación |
|--------|-----------|
| `command_popup` | Tecla `/` — lista de comandos disponibles con navegación |
| `config_modal` | `/config` — editar providers, modelo, modo, API key |
| `info_modal` | `?` — ayuda contextual del tab activo |

### IPC con Bun

El TUI se conecta a un Unix socket (`~/.hivecode/tui.sock`) al arrancar. Los mensajes entrantes se procesan por prioridad:

- **CRITICAL** — `forensic_alert`, `approval_required`: se procesan antes que cualquier otra cosa
- **NORMAL** — `worker_update`, `history_append`, `diff_update`, `task_status`, `status`
- **LOW** — `memory_update`, `librarian_progress`, `thinking_chunk`

El TUI también funciona en modo headless (`HIVETUI_HEADLESS=1`) para testing: emite frames como NDJSON a stdout en lugar de pintar la terminal.

### Compilar el TUI

```bash
cd packages/hivetui && cargo build --release
```

---

## Modos de operación

| Modo | Qué hace | Comando rápido |
|------|----------|---------------|
| `plan` | BEE diseña el ADR y la lista de fases. **Ningún archivo se modifica.** | `/mode set plan` |
| `approval` | Checkpoint interactivo entre cada nivel. Muestra archivos a crear/modificar y pide confirmación. | `/mode set approval` |
| `auto` | Ejecución completa sin intervención. | `/mode set auto` |

---

## Arquitectura del enjambre

### BEE — El Senior Dev orquestador

**BEE** es el único punto de entrada para todas las solicitudes. Clasifica cada mensaje en 4 acciones:

| Acción BEE | Cuándo | Ejemplo |
|------------|--------|---------|
| `respond` | Saludo, pregunta, explicación — sin trabajo técnico | "hola", "¿qué hace este proyecto?" |
| `fix` | Bug simple en ≤ 3 archivos, sin diseño arquitectónico | "el login falla con email en mayúsculas" |
| `dispatch` | Feature puntual donde el coordinador es obvio | "agrega un test para el módulo auth" |
| `architecture` | Implementación multi-módulo, nuevas entidades, ADR necesario | "implementa notificaciones en tiempo real" |

### Flujo completo — Orquestación por niveles

```
Usuario escribe cualquier mensaje
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  BEE — Senior Dev  (siempre primero)                       │
  │  Lee el proyecto, clasifica, consulta agent_memory         │
  └─────────────────────────────────────────────────────────────┘
        │
  ┌─────┴─────────────────────────────────────────────────┐
  │                                                       │
  ▼                                                       ▼
"respond" / "fix"                               "dispatch" / "architecture"
  │                                                       │
  ▼                                              Nivel 0: ProductManager
BEE responde o aplica                            PRD + historias de usuario
el fix directamente.                             + criterios de aceptación
SIN activar ningún worker.                       (siempre, antes de todo diseño)
                                                         │
                                                Nivel 1: Architecture
                                                ADR + contratos TypeScript
                                                Plan de fases por tipo de proyecto
                                                         │
                                         Nivel 2 (paralelo — según tipo):
                                         Backend + Frontend        (web fullstack)
                                         Backend + Mobile          (app móvil)
                                         Backend + DataScientist   (ML/IA)
                                         los tres juntos           (fullstack ML)
                                         Security (transversal — siempre)
                                                         │
                                         Nivel 3 (paralelo):
                                         QAEngineer + DBA
                                                         │
                                         Nivel 4 (paralelo):
                                         Integration + DevOps
                                                         │
                                         Nivel 5: CodeReviewer
                                           (modelo máximo, veredicto final)
                                                         │
                                  ┌──────────────────────┴──────────────────┐
                                  │ APROBADO                                │ RECHAZADO
                                  ▼                                         ▼
                           Librarian (post-sesión)                Workers relanzados
                           Destila sesión → agent_memory          con constraints del reviewer
```

> **Modo inicial:** `auto`. BEE ejecuta el pipeline completo sin pausas. En modo `plan` solo muestra el ARNÉS sin ejecutar nada. En modo `approval` hace checkpoint entre cada nivel esperando confirmación del operador.

Si un worker agota sus iteraciones sin completar, **ForensicAgent** se activa automáticamente antes de cualquier relanzamiento — analiza la causa raíz y recomienda `relanzar_con_constraint`, `reasignar` o `escalar_al_humano`.

### Los 12 workers del enjambre

Cada worker es un **Bun Worker independiente** (proceso JS separado con su propio heap). Se comunican exclusivamente por paso de mensajes — nunca entre sí directamente. El blackboard en SQLite es el único medio de coordinación.

---

#### BEE — Coordinador Principal
Único punto de entrada. Recibe la tarea del usuario, lee el contexto del proyecto con herramientas, consulta `agent_memory` de sesiones anteriores, y toma la decisión de ruteo. Escribe su razonamiento en el blackboard (`agent_context` type=`decision`). Observa el estado de todos los workers vía la vista `bee_awareness` y resuelve conflictos:
- Severidad `low`/`medium` → resuelve autónomamente y continúa
- Severidad `critical` o violación de ADR → emite **HALT** y escala al humano

**Herramientas:** lectura completa del proyecto + escritura (puede aplicar fixes directamente)

---

#### 1. ProductManager
Solo se activa cuando BEE clasifica como `architecture` y la tarea es una feature de alto nivel sin especificación previa. Traduce requisitos ambiguos de negocio en un PRD estructurado: objetivo, historias de usuario, criterios de aceptación verificables, y constraints técnicos conocidos. Lo escribe en el blackboard como `type=decision` — Architecture lo usa como punto de partida, QAEngineer usa los criterios de aceptación para los tests.

**No inventa detalles de implementación. Herramientas:** solo lectura + `write_decision`

---

#### 2. Architecture — Diseñador de Sistemas
Se activa después de ProductManager (si hubo) o directamente cuando BEE clasifica como `architecture`. Lee el PRD del blackboard, los ADRs activos y los registros de `agent_memory` tipo `pattern` y `contract`. Produce:
- Un **ADR** con contexto, opciones evaluadas y decisión justificada
- Un **plan de fases con niveles de dependencia** — determina qué engineers del nivel 1 se despachan según el tipo de proyecto (web, mobile, ML, fullstack)
- **Contratos TypeScript** entre módulos

**Herramientas:** solo lectura + `write_decision`

---

#### 3. BackendEngineer — Ingeniero de Servidor
Implementa APIs, lógica de negocio y acceso a datos. Lee el plan de Architecture y los contratos del blackboard. Al terminar escribe los endpoints implementados con sus contratos exactos para que Frontend, Mobile y DataScientist los consuman. Si va a modificar archivos de schema, verifica si existe un ADR que requiera migration script previo.

**Herramientas:** read + write completo + git + build/test/lint + shell

---

#### 4. FrontendEngineer — Ingeniero de Interfaz Web
Implementa componentes UI y consume las APIs de Backend. Si un endpoint que necesita aún no está definido en el blackboard, escribe una pregunta dirigida a Backend y continúa con las partes independientes. Al terminar documenta qué componentes creó y qué endpoints consume para que CodeReviewer valide la consistencia.

**Herramientas:** read + write completo + git + build/test/lint

---

#### 5. MobileEngineer — Ingeniero de Apps Móviles
Implementa aplicaciones React Native, iOS (Swift/SwiftUI) o Android (Kotlin/Jetpack Compose) según el stack definido por Architecture. Es fundamentalmente distinto a FrontendEngineer — maneja APIs de plataforma nativa, compiladores nativos y ciclos build-test-debug autónomos. Lee los contratos de API de Backend del blackboard. Si un endpoint que necesita no está definido, escribe la solicitud en el blackboard y continúa con las partes independientes.

**Herramientas:** read + write + build + test + shell (expo, pod install, gradle, etc.)

---

#### 6. DataScientist — Científico de Datos / IA
Implementa modelos ML, pipelines de datos y agentes de IA. Es fundamentalmente distinto a BackendEngineer — maneja PyTorch, scikit-learn, transformers y MLOps. Coordina con BackendEngineer vía blackboard para definir el contrato del endpoint de predicciones antes de que el backend lo implemente. Reporta métricas concretas (F1, AUC, accuracy) en el blackboard, no narrativas vagas.

**Herramientas:** read + write + run_script + shell

---

#### 7. SecurityAuditor — Auditor de Seguridad
Opera en **dos modos simultáneos**:
- **Transversal** durante el nivel de engineers: corre en paralelo con Backend/Frontend/Mobile/DataScientist, detecta hallazgos CRITICAL y escribe constraints en el blackboard antes de que los workers afectados continúen
- **Dedicado** en el nivel de QA: análisis completo del código producido

Categorías que siempre audita: inyecciones SQL/command, secrets hardcodeados, autenticación débil, dependencias vulnerables, XSS, exposición de datos. **No modifica código.**

**Herramientas:** solo lectura + `check_dependencies`

---

#### 8. QAEngineer — Ingeniero de Calidad
Escribe y ejecuta tests después de que todos los engineers del nivel anterior completaron. Lee los criterios de aceptación del PRD de ProductManager (si existe) para escribir casos verificables. El Context Compiler le inyecta `forensic_lessons` de sesiones anteriores para evitar repetir casos que ya causaron problemas. Si un test falla, escribe el fallo en el blackboard dirigido al worker responsable.

**Herramientas:** read + write + test runner

---

#### 9. DevOpsEngineer — Infraestructura y CI/CD
Configura pipelines de CI/CD, Dockerfiles, Terraform y configuraciones de monitoreo. Se activa después de QA y Security porque necesita conocer el estado final del código. Lee el blackboard para entender qué cambios hicieron los otros workers y actualiza la infraestructura para soportarlos.

**Herramientas:** read + write + git completo (incluyendo `git_create_pr`, `git_rollback`) + shell

---

#### 10. CodeReviewer — Gate de Calidad Final
Siempre usa el **modelo de mayor capacidad disponible**, independientemente del modelo configurado para los otros workers. Lee todo el blackboard, los diffs contra checkpoints, hallazgos de Security, resultados de QA, e incompatibilidades de Integration. El Context Compiler le inyecta toda la `agent_memory` del proyecto — llega con el historial completo de lo que funcionó y lo que no.

Emite uno de tres veredictos:
- `APROBADO` — el trabajo cumple todos los criterios
- `APROBADO_CON_OBSERVACIONES` — aprobado, con puntos de mejora para próximas sesiones
- `RECHAZADO: {razones específicas}` — no puede pasar a producción sin correcciones

Si rechaza, BEE relanza los workers afectados con los constraints del rechazo. **No modifica código.**

**Herramientas:** solo lectura + `check_types` + `code_test`

---

#### 11. ForensicAgent — Reflexión Forzada *(on-demand)*
Se activa **exclusivamente** cuando un worker alcanza su límite de iteraciones sin completar. El `CoordinatorManager` nunca relanza un worker que falló por límite sin esperar el análisis del ForensicAgent.

Analiza el historial completo del worker fallido en el blackboard y produce:
1. **Qué intentó** — cada enfoque en orden cronológico
2. **Por qué falló** — causa raíz: `error_de_implementacion`, `conflicto_con_constraint`, `limitacion_del_entorno` o `problema_de_especificacion`
3. **Recomendación** — exactamente una de tres:
   - `relanzar_con_constraint: {constraint}` → el manager escribe el constraint y relanza
   - `reasignar_a: {worker}` → la tarea no corresponde a este worker
   - `escalar_al_humano: {opciones}` → requiere decisión humana

**No modifica código. Herramientas:** solo lectura del blackboard y workspace

---

#### 12. Librarian — Memoria Compuesta *(on-demand, post-sesión)*
Se activa solo cuando CodeReviewer emitió `APROBADO` o `APROBADO_CON_OBSERVACIONES`. Lee el blackboard completo y **destila** — no transcribe — el conocimiento accionable en `agent_memory` (`~/.hivecode/memory.db`). Escribe patrones, antipatrones, contratos, convenciones y lecciones forenses. Incrementa `confirmed_count` de registros que la sesión validó y depreca los que ya no aplican (`refuted_count > confirmed_count + 2`). El conocimiento no se borra — se depreca con trazabilidad.

**No modifica código de producción. Herramientas:** solo lectura + `write_memory`

---

### Paralelismo real por niveles

El `CoordinatorManager` agrupa las fases definidas por Architecture en niveles de dependencia. Todos los workers de un nivel se inician **en el mismo tick** con `Promise.all()`. El siguiente nivel solo comienza cuando todos los del nivel anterior reportaron `done`.

```
Nivel 0  ─► product_manager             (siempre — sin PRD no hay arquitectura posible)
              │
Nivel 1  ─► architecture                (diseño, ADR, plan de fases, contratos)
              │
              ├─ Tipo web fullstack:
              │   backend ──┐
Nivel 2  ─►  │   frontend  ├─ Promise.all()  +  security (transversal)
              │
              ├─ Tipo mobile:
              │   backend ──┐
Nivel 2  ─►  │   mobile    ├─ Promise.all()  +  security (transversal)
              │
              └─ Tipo ML:
                  backend ──────┐
Nivel 2  ─►      data_scientist ├─ Promise.all()  +  security (transversal)
                  frontend ─────┘ (si hay UI)
              │
Nivel 3  ─► test + dba                  (paralelo — QA conoce la implementación real)
              │
Nivel 4  ─► integration + devops        (paralelo — valida contratos y genera PR)
              │
Nivel 5  ─► reviewer                    (modelo máximo, veredicto final)
              │
Post-sesión ► librarian                 (solo si APROBADO)
```

La tabla `worker_activity` registra `started_at` y `completed_at` con `level`. Métrica de aceptación: `started_at` de workers en el mismo nivel no deben diferir en más de 500ms.

---

## Memoria compuesta entre sesiones

El **Librarian** destila el conocimiento de cada sesión aprobada en la tabla `agent_memory` (`~/.hivecode/memory.db`). El **Context Compiler** consulta esta tabla por FTS5 antes de despachar cada worker, con filtrado por dominio: cada worker recibe solo el tipo de conocimiento relevante para su rol.

| Worker | Tipos de memoria que recibe |
|--------|----------------------------|
| Architecture | `pattern`, `contract` |
| SecurityAuditor | `antipattern` |
| QAEngineer | `forensic_lesson` |
| CodeReviewer | todos los tipos |
| demás workers | filtrado por relevancia semántica (FTS5) |

Tipos de conocimiento persistido:

| Tipo | Qué registra |
|------|-------------|
| `pattern` | Enfoque que funcionó y fue aprobado por el CodeReviewer |
| `antipattern` | Enfoque que causó fallos o fue rechazado |
| `contract` | Interfaz establecida entre módulos |
| `convention` | Convención del proyecto descubierta durante la sesión |
| `forensic_lesson` | Lección de fallos analizados por el ForensicAgent |

Los registros tienen `confirmed_count` / `refuted_count`. El sistema depreca automáticamente conocimiento que ya no aplica (`refuted_count > confirmed_count + 2`). El conocimiento no se borra — se depreca con trazabilidad completa.

---

## Learning Harness — Autocorrección

El sistema detecta sus propios fallos durante la ejecución y genera propuestas de mejora que el operador puede revisar y aplicar. No hay autocorrección automática — **las propuestas en estado `pending` no tienen ningún efecto** hasta que el operador las apruebe.

### Cómo funciona

Cada fallo se registra inmediatamente en `learning_failures` (append-only). Al cerrar una tarea, BEE evalúa si hubo fricción y genera una propuesta. Cuando Architecture prepara un nuevo plan, consulta los fallos acumulados — si hay un patrón con 3+ ocurrencias, lo inyecta en su contexto y genera una propuesta adicional.

```
Ejecución
  ├─ Tool falla      → learning_failures (tool_error)
  ├─ Phase falla     → learning_failures (phase_failure)
  └─ Task completa   → evalúa fricción → learning_proposals (pending)

Próxima tarea con Architecture:
  └─ 3+ fallos del mismo tipo → inyecta en contexto + nueva propuesta

hivecode doctor → lista propuestas pendientes con detalle
```

### Ver y aplicar propuestas

```bash
# Ver propuestas pendientes
hivecode doctor

# Aplicar un cambio de prompt al agente afectado
hivecode agent edit <name>

# Agregar una skill nueva
/skill add
```

---

## Comandos CLI externos

```bash
hivecode repl                          # Iniciar TUI interactivo
hivecode start [--daemon]              # Iniciar gateway en background
hivecode stop                          # Detener gateway
hivecode status                        # Estado del sistema
hivecode doctor                        # Diagnóstico completo
hivecode doctor --fix                  # Correcciones automáticas

hivecode agent list                    # Listar agentes
hivecode agent inspect <name>          # Ver detalles de un agente

hivecode provider list                 # Listar providers configurados
hivecode provider add <name>           # Añadir provider
hivecode provider test <name>          # Ping con latencia

hivecode task debug <id>               # Inspeccionar tarea con fases, trazas y narrativo
```

---

## Comandos internos del TUI (slash commands)

```
/provider list|add|set|test|status    Configurar providers de IA
/modelo   list|set|info               Seleccionar modelo
/mode     get|set|history             Cambiar modo Plan/Approval/Auto
/mcp      list|add|enable|disable     Integrar servidores MCP
/skill    list|enable|disable|info    Cargar y activar skills
/task     list|status|cancel|rollback Gestionar tareas
/narrative show|search|export         Buscar en el historial
/doctor                               Diagnóstico del sistema
/help [comando]                       Ayuda detallada
```

---

## Configuración de providers

Las API keys se almacenan **cifradas en SQLite** (`providers.api_key_encrypted`). No se usan `.env`.

```bash
# Dentro del TUI:
/provider add anthropic
/provider add openai
/provider add gemini
/provider set anthropic           # activar como provider por defecto
/modelo set anthropic claude-sonnet-4-6
```

---

## Estructura del monorepo

```
packages/
├── cli/        CLI: comandos externos, REPL, launchers
├── code/       Motor: CoordinatorManager, workers, plan-parser
├── core/       Gateway HTTP/WS, SQLite, agent loop, tools, context compiler
├── hivetui/    TUI Rust/crossterm — renderer custom, sin dependencias de Ratatui
├── ui/         Componentes CLI (@clack)
├── mcp/        Cliente Model Context Protocol
└── skills/     Skills empaquetadas
```

### Base de datos — dos databases SQLite

**`~/.hivecode/data/hivecode.db`** — Global (providers, agents, config):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA cache_size   = -64000;     -- 64 MB
PRAGMA mmap_size    = 268435456;  -- 256 MB
```

**`~/.hivecode/memory.db`** — Memoria cross-sesión:

| Tabla | Contenido |
|-------|-----------|
| `agent_memory` | Conocimiento destilado por el Librarian con FTS5 |

**`~/.hivecode/sessions/<id>.db`** — Por sesión:

| Tabla | Contenido |
|-------|-----------|
| `agent_context` | Blackboard: decisiones, constraints, observaciones (FTS5) |
| `agent_conflicts` | Conflictos detectados y sus resoluciones |
| `worker_activity` | Actividad por worker con `level` y timestamps |
| `checkpoints` | Snapshots de archivos para rollback por nivel |
| `adrs` | Architecture Decision Records (FTS5) |

**`~/.hivecode/data/code.db`** — Narrativo de código:

| Tabla | Contenido |
|-------|-----------|
| `code_sessions` | Sesiones de trabajo |
| `code_tasks` | Tareas con modo, status, tokens |
| `code_task_phases` | Fases por coordinador |
| `code_narrative` | Historial narrativo estructurado (FTS5) |
| `code_recovery_points` | Recovery points por nivel de ejecución |
| `code_file_snapshots` | Snapshots para rollback |
| `code_playbook` | Reglas aprendidas por el ACE Reflector (FTS5) |
| `code_traces` | Trazas de ejecución de herramientas por agente |
| `learning_failures` | Log append-only de fallos (tool_error, phase_failure, timeout…) |
| `learning_proposals` | Propuestas de mejora generadas por BEE y Architecture (pending → aprobación manual) |

---

## Build y distribución

```bash
bun run build          # Bundle + workers
bun run build:binary   # Binario standalone
bun run lint           # Type check
bun test               # Tests unitarios
bun run test:integration  # 68 tests de integración
```

Artefactos del build:

```
dist/
├── hivecode.js               # Entry point
├── bee.worker.js
├── architecture.worker.js
├── product-manager.worker.js
├── backend.worker.js
├── frontend.worker.js
├── mobile.worker.js
├── data-scientist.worker.js
├── dba.worker.js
├── security.worker.js
├── test.worker.js
├── devops.worker.js
├── integration.worker.js
├── reviewer.worker.js
├── librarian.worker.js       # On-demand: post-sesión aprobada
└── forensic.worker.js        # On-demand: análisis de fallos
```

---

## Requisitos

- [Bun](https://bun.sh) >= 1.3.13
- [Rust](https://rustup.rs) + [crossterm](https://crates.io/crates/crossterm) (para compilar el TUI en `packages/hivetui/`)
- Git

---

## Autor

**Johpaz** — [@johpaz](https://github.com/johpaz)

Hecho en Colombia con Bun y café.

---

## Licencia

**hivecode-NC-1.0** — Uso personal y educativo libre. Prohibido uso comercial sin autorización del autor.
Ver [`LICENSE`](./LICENSE) para los términos completos.
