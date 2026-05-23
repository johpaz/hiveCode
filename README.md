# hivecode

**Multi-AI Coding Swarm — Consola-first. Enfocado en código. Multi-proveedor.**

`hivecode` es un sistema de ingeniería de software autónoma impulsado por un enjambre de coordinadores IA especializados. **BEE** actúa como punto de entrada único: recibe la tarea, clasifica la intención, y orquesta los workers en paralelo por niveles de dependencia. El sistema aprende con cada sesión — el conocimiento se destila en `agent_memory` (SQLite) y se inyecta automáticamente en sesiones futuras.

> **Runtime:** Bun >= 1.3.13
> **Base de datos:** SQLite WAL — única fuente de verdad
> **TUI:** Rust + crossterm, renderer custom (`packages/hivetui/`)
> **Licencia:** hivecode-NC-1.0 (no comercial)

---

## Inicio rápido

```bash
# Clonar e instalar
git clone https://github.com/johpaz/hive-code.git hivecode
cd hivecode
bun install

# Arrancar (gateway + TUI Ratatui)
bun run dev
# o bien: hivecode repl

# Primera vez: configurar un provider
/provider add anthropic
# Introduce la API key cuando se solicite
```

---

## Interfaz: TUI

La interfaz es un **terminal Rust compilado** (`packages/hivetui/`) con renderer custom sobre `crossterm`. Comunica con el proceso Bun vía Unix socket IPC con colas de prioridad (critical / normal / low).

```
╭──────────────────────────────────────────────────────────────╮
│  hivecode  ·  plan  │  approval  │  auto                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Tarea: implementa autenticación JWT con refresh token       │
│                                                              │
│  ⬢ Architecture     ████████████ ✓ 8s      [nivel 0]        │
│  ⬢ Backend          ███████░░░░░ 65%        [nivel 1] ─┐     │
│  ⬢ Frontend         ████░░░░░░░░ 38%        [nivel 1]  │ ⬡   │
│  ⬢ DBA              ██████████░░ 85%        [nivel 1] ─┘     │
│  ⬢ IntegrationAgent pending                [nivel 3]        │
│  ⬢ CodeReviewer     pending                [nivel 4]        │
│                                                              │
╰──────────────────────────────────────────────────────────────╯
│ > _                                                          │
╰──────────────────────────────────────────────────────────────╯
```

Para compilar el TUI:
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
  ▼                                                       ▼
BEE responde o aplica                          Nivel 0: Architecture
el fix directamente                              ADR + contratos TypeScript
                                                         │
                                             Nivel 1 (paralelo):
                                             Backend + Frontend + DBA
                                             Security (transversal)
                                                         │
                                             Nivel 2: Test
                                                         │
                                             Nivel 3: IntegrationAgent
                                               (cruza contratos entre módulos)
                                                         │
                                             Nivel 4: CodeReviewer
                                               (modelo máximo, veredicto final)
                                                         │
                                      ┌──────────────────┴──────────────────┐
                                      │ APROBADO                            │ RECHAZADO
                                      ▼                                     ▼
                               Librarian (post-sesión)            Workers relanzados
                               Destila sesión → agent_memory      con constraints del reviewer
```

Si un worker agota sus iteraciones sin completar, **ForensicAgent** se activa automáticamente antes de cualquier relanzamiento — analiza la causa raíz y recomienda `relanzar_con_constraint`, `reasignar` o `escalar_al_humano`.

### Workers del enjambre — definición completa

Cada worker es un **Bun Worker independiente** (proceso JS separado con su propio heap). Se comunican exclusivamente por paso de mensajes — nunca entre sí directamente. El blackboard en SQLite es el único medio de coordinación.

---

#### BEE — Coordinador Principal
Único punto de entrada. Recibe la tarea del usuario, lee el contexto del proyecto con herramientas, consulta `agent_memory` de sesiones anteriores, y toma la decisión de ruteo. Escribe su razonamiento en el blackboard (`agent_context` type=`decision`). Observa el estado de todos los workers vía la vista `bee_awareness` y resuelve conflictos:
- Severidad `low`/`medium` → resuelve autónomamente y continúa
- Severidad `critical` o violación de ADR → emite **HALT** y escala al humano

**Herramientas:** lectura completa del proyecto + escritura (puede aplicar fixes directamente)

---

#### Architecture — Diseñador de Sistemas
Solo se activa cuando BEE clasifica la tarea como `architecture`. Lee el proyecto, cruza con ADRs activos y con los registros de `agent_memory` tipo `pattern`, `antipattern` y `contract` del proyecto. Produce:
- Un **ADR** (Architecture Decision Record) con contexto, opciones y decisión
- Un **plan de fases con niveles de dependencia** — los workers del mismo nivel pueden ejecutarse en paralelo
- **Contratos TypeScript** entre módulos (interfaces que backend, frontend y DBA deben respetar)

**Herramientas:** solo lectura + `write_decision`

---

#### Backend — Ingeniero de Servidor
Implementa APIs, lógica de negocio y acceso a datos. Antes de escribir cualquier archivo consulta el blackboard para leer las decisiones de Architecture y constraints activos. Al terminar escribe en el blackboard los endpoints que definió con sus contratos exactos (tipo, rutas, respuestas) para que IntegrationAgent los valide.

**Herramientas:** read + write completo + git + build/test/lint + shell

---

#### Frontend — Ingeniero de Interfaz
Implementa componentes UI y consume las APIs definidas por Backend. Antes de escribir componentes que llamen a APIs, consulta el blackboard para leer los endpoints disponibles. Si un endpoint que necesita aún no está en el blackboard, escribe una pregunta dirigida a Backend y continúa con las partes independientes.

**Herramientas:** read + write completo + git + build/test/lint

---

#### DBA — Administrador de Base de Datos
Diseña el schema de datos del proyecto: tablas, columnas, tipos, índices, constraints y migrations. Lee las entidades de dominio definidas por Architecture del blackboard. Escribe el schema resultante como decisión en el blackboard (scope=`schema`) — esa es la fuente de verdad que Backend y IntegrationAgent consultan.

**Herramientas:** read + write de migrations + shell SQLite de diagnóstico (solo lectura de BD)

---

#### Security — Auditor Transversal
Corre **en paralelo con los niveles 1 y 2**, no como una fase secuencial. Lee el blackboard y los archivos del workspace de forma continua. Categorías que siempre audita: inyecciones SQL/command, secrets hardcodeados, autenticación débil, dependencias vulnerables (bun.lock), XSS, exposición de datos en respuestas. Delega a sub-agentes especializados (`sast-agent`, `dependency-audit-agent`, `secrets-scan-agent`) en paralelo.

Cuando detecta un hallazgo:
- **CRITICAL** → escribe un constraint en el blackboard que bloquea al worker afectado
- **HIGH/MEDIUM/LOW** → escribe una observación que el CodeReviewer considerará

**No modifica código. Herramientas:** solo lectura

---

#### Test — Ingeniero de Calidad
Escribe y ejecuta tests después de que los workers de implementación completaron su nivel. Al conocer exactamente qué implementó cada worker (vía el blackboard), puede escribir casos de prueba que cubran los casos de borde reales. Si un test falla, escribe el fallo en el blackboard como observación dirigida al worker responsable.

**Herramientas:** read + write + test runner

---

#### DevOps — Infraestructura y CI/CD
Configura pipelines de CI/CD, Dockerfiles, scripts de deploy y herramientas de build. Se activa cuando la tarea involucra infraestructura o automatización de despliegue.

**Herramientas:** read + write + git + shell completo

---

#### IntegrationAgent — Validador de Costuras
Su responsabilidad exclusiva es encontrar incompatibilidades entre módulos **antes** del CodeReviewer. Lee el blackboard completo y cruza:
- Endpoints definidos por Backend vs endpoints consumidos por Frontend (tipos, rutas, métodos)
- Schema definido por DBA vs queries usadas por Backend (nombres de tablas y columnas)
- Tipos TypeScript exportados por Backend vs importados por Frontend
- Cobertura de tests vs endpoints y funciones implementadas

Escribe cada incompatibilidad en el blackboard. Las bloqueantes las registra en `agent_conflicts`. **No modifica código.**

**Herramientas:** solo lectura + `write_decision`

---

#### CodeReviewer — Gate de Calidad Final
Siempre usa el **modelo de mayor capacidad disponible**, independientemente del modelo configurado para los otros workers. Lee todo el blackboard, los diffs contra checkpoints, hallazgos de Security, resultados de Test, y hallazgos de IntegrationAgent. Emite uno de tres veredictos:

- `APROBADO` — el trabajo cumple todos los criterios
- `APROBADO_CON_OBSERVACIONES` — aprobado, pero con puntos de mejora para próximas sesiones
- `RECHAZADO: {razones específicas}` — no puede pasar a producción sin correcciones

Si rechaza, BEE relanza los workers afectados con los constraints del rechazo en el blackboard. **No modifica código.**

**Herramientas:** solo lectura + `check_types` + `code_test`

---

#### ForensicAgent — Reflexión Forzada *(on-demand)*
Se activa **exclusivamente** cuando un worker alcanza su límite de iteraciones sin completar. El `CoordinatorManager` nunca relanza un worker que falló por límite sin esperar el análisis del ForensicAgent.

Analiza el historial completo del worker fallido en el blackboard y produce un análisis en tres partes:
1. **Qué intentó** — cada enfoque en orden cronológico
2. **Por qué falló** — causa raíz: `error_de_implementacion`, `conflicto_con_constraint`, `limitacion_del_entorno` o `problema_de_especificacion`
3. **Recomendación** — exactamente una de tres:
   - `relanzar_con_constraint: {constraint específico}` → el manager escribe el constraint en el blackboard y relanza
   - `reasignar_a: {worker alternativo}` → la tarea no corresponde a este worker
   - `escalar_al_humano: {opciones disponibles}` → requiere decisión humana

**No modifica código. Herramientas:** solo lectura del blackboard y workspace

---

#### Librarian — Memoria Compuesta *(on-demand, post-sesión)*
Se activa solo cuando el CodeReviewer emitió `APROBADO` o `APROBADO_CON_OBSERVACIONES`. Lee el blackboard completo de la sesión y **destila** — no transcribe — el conocimiento accionable en registros de `agent_memory` (`~/.hivecode/memory.db`).

También incrementa `confirmed_count` de registros existentes que la sesión validó, y depreca registros cuyo `refuted_count` superó al `confirmed_count + 2`. El conocimiento no se borra — se depreca con trazabilidad.

**No modifica código de producción ni el blackboard de sesión.**

---

### Paralelismo real por niveles

El `CoordinatorManager` agrupa las fases definidas por Architecture en niveles de dependencia. Todos los workers de un nivel se inician **en el mismo tick** con `Promise.all()` — sin esperar a que el anterior termine. El siguiente nivel solo comienza cuando todos los del nivel anterior reportaron `done`.

```
Nivel 0 ──► architecture                        (secuencial, diseño)
              │
Nivel 1 ──►  backend ──┐
             frontend  ├─ Promise.all() — inician simultáneamente
             dba    ───┘
             security  ← corre transversalmente durante niveles 1 y 2
              │
Nivel 2 ──► test                                (conoce la implementación real)
              │
Nivel 3 ──► integration                         (cruza los contratos)
              │
Nivel 4 ──► reviewer                            (modelo máximo, veredicto final)
              │
Post-sesión ► librarian                         (solo si APROBADO)
```

La tabla `worker_activity` en SQLite registra `started_at` y `completed_at` con `level` para cada worker. La métrica de aceptación del paralelismo: los `started_at` de workers dentro del mismo nivel no deben diferir en más de 500ms.

---

## Memoria compuesta entre sesiones

El **Librarian** destila el conocimiento de cada sesión aprobada en la tabla `agent_memory` (`~/.hivecode/memory.db`). El **Context Compiler** consulta esta tabla por FTS5 antes de despachar cada worker.

Tipos de conocimiento persistido:

| Tipo | Qué registra |
|------|-------------|
| `pattern` | Enfoque que funcionó y fue aprobado por el CodeReviewer |
| `antipattern` | Enfoque que causó fallos o fue rechazado |
| `contract` | Interfaz establecida entre módulos |
| `convention` | Convención del proyecto descubierta durante la sesión |
| `forensic_lesson` | Lección de fallos analizados por el ForensicAgent |

Los registros tienen `confirmed_count` / `refuted_count` — el sistema depreca automáticamente conocimiento que ya no aplica.

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
├── hivetui/    TUI Ratatui (Rust) — interfaz de terminal
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
├── backend.worker.js
├── frontend.worker.js
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
