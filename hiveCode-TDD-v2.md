# hiveCode — Technical Design Document v2.0
**Estado:** Documento vivo — fuente de verdad del proyecto  
**Stack:** Bun · TypeScript · SQLite · Rust (TUI)  
**Fecha:** Mayo 2026

---

## Índice

1. [Visión y principios](#1)
2. [Arquitectura general](#2)
3. [Estructura del monorepo](#3)
4. [Paquetes — diseño detallado](#4)
5. [Capa de datos — SQLite schema completo](#5)
6. [Agent Context Layer — coordinación viva](#6)
7. [Checkpoint & Rollback](#7)
8. [Protocolo IPC Bun ↔ TUI](#8)
9. [hiveTui — Diseño completo](#9)
10. [Sandbox de ejecución](#10)
11. [Build y distribución](#11)
12. [Plan de implementación incremental](#12)
13. [Criterios de aceptación](#13)

---

## 1. Visión y principios

### Qué es hiveCode

hiveCode es un agente de código local-first que orquesta múltiples workers especializados con un TUI de terminal como interfaz primaria. No es un chat con agentes. Es un **sistema de coordinación inteligente** donde Bee, el coordinador principal, tiene conciencia real del estado de cada worker a través de un contexto bidireccional vivo en SQLite.

### Los tres momentos que definen la experiencia

**Confianza:** *"El agente entendió lo que pedí y respeta mi arquitectura"*
Ver el razonamiento en tiempo real. ADRs como memoria activa del agente.

**Control:** *"Puedo detenerlo antes de que rompa algo"*
HALT con snapshot. File Risk Map cruzado con ADRs. Conflictos detectados antes del daño.

**Seguridad:** *"Puedo volver atrás en 3 segundos"*
Checkpoint & Rollback. El diferenciador que ninguna herramienta del mercado tiene.

### Principios arquitectónicos

**Local-first:** SQLite es la base de datos. Todo funciona sin conexión salvo las llamadas al LLM.

**Blackboard pattern:** los agentes no se llaman entre sí. Escriben y leen de un contexto compartido en SQLite. Bee observa el pizarrón y coordina.

**Separación de capas:** Bun orquesta, persiste y coordina. Rust renderiza y responde. SQLite es el cerebro compartido.

**Jerarquía de información:** código generado es lo más prominente. Progreso y logs son secundarios y accesibles por toggle.

**Rollback siempre disponible:** antes de cualquier escritura existe un checkpoint. Sin miedo = más autonomía al agente.

**Especialización real:** cada worker tiene contexto diferente, herramientas diferentes y criterios de éxito diferentes — no solo un system prompt diferente.

---

## 2. Arquitectura general

```
┌──────────────────────────────────────────────────────────────────────┐
│                        hiveCode Process (Bun)                        │
│                                                                      │
│  ┌──────────┐   ┌─────────────────────────────────────────────────┐  │
│  │   CLI    │──▶│              CoordinatorManager                  │  │
│  └──────────┘   │                                                 │  │
│                 │  ┌─────────┐  ┌──────────────────────────────┐  │  │
│                 │  │   Bee   │  │  Workers (Bun Workers)        │  │  │
│                 │  │  (coord)│  │  ┌──────┐ ┌────────┐         │  │  │
│                 │  └────┬────┘  │  │arch  │ │backend │ · · ·   │  │  │
│                 │       │       │  └──────┘ └────────┘         │  │  │
│                 └───────┼───────┴──────────────────────────────┘  │  │
│                         │                                          │  │
│  ┌──────────────────────▼──────────────────────────────────────┐  │  │
│  │                   SQLite (WAL mode)                          │  │  │
│  │  sessions · messages · agent_context · agent_conflicts       │  │  │
│  │  agent_awareness · checkpoints · adrs · file_risks          │  │  │
│  └─────────────────────────────────────────────────────────────┘  │  │
│                                                                      │
│  ┌──────────────┐                                                    │
│  │  IPC Server  │  Unix socket NDJSON (envelope priorizado)          │
│  └──────┬───────┘                                                    │
└─────────┼────────────────────────────────────────────────────────────┘
          │
┌─────────▼────────────────────────────────────────────────────────────┐
│                      hiveTui Process (Rust)                           │
│                                                                      │
│  ┌──────────┐  ┌─────────────────────┐  ┌──────────────────────────┐ │
│  │ IpcTask  │─▶│  AppState           │─▶│  Renderer (ratatui)      │ │
│  │ (tokio)  │◀─│  sub-states         │  │  Layout por fase activa  │ │
│  └──────────┘  └─────────────────────┘  └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Flujo de una sesión

```
1.  dev:     hivecode "implementa JWT refresh token"
2.  CLI:     crea sesión SQLite, lanza IPC server, spawn TUI
3.  TUI:     conecta socket → TuiMessage::Ready
4.  Bee:     lee HIVECODE.md + ADRs + agent_context activo
5.  Bee:     emite ReasoningChunk mientras planifica → TUI muestra thought stream
6.  Bee:     escribe decisiones en agent_context (blackboard)
7.  Workers: leen agent_context antes de actuar
8.  Workers: crean checkpoint → escriben código → emiten FileRiskUpdate
9.  TUI:     muestra workers panel + file risk map + checkpoint timeline
10. Bee:     detecta conflictos via agent_conflicts → interviene
11. dev:     aprueba / hace rollback / hace HALT
```

---

## 3. Estructura del monorepo

```
hiveCode/
├── package.json              # workspace root Bun
├── bunfig.toml
├── tsconfig.base.json
├── HIVECODE.md               # contexto persistente del proyecto
│
├── packages/
│   ├── core/                 # infraestructura base
│   ├── code/                 # orquestación de agentes
│   ├── cli/                  # binario hivecode + TUI launcher
│   └── tui/                  # TUI Rust (crate independiente)
│
├── skills/                   # skills del agente (FT5)
│   ├── core-behavior.md      # skill fija — siempre cargada
│   ├── architecture.md
│   ├── backend.md
│   ├── frontend.md
│   ├── security.md
│   ├── test.md
│   └── devops.md
│
├── adrs/                     # Architecture Decision Records
│   ├── ADR-001-stack.md
│   ├── ADR-002-sandbox.md
│   └── ADR-003-database.md
│
└── docs/
    └── TDD.md                # este documento
```

### Reglas de dependencia entre paquetes

```
core   ← no depende de nadie
code   ← depende de core
cli    ← depende de core + code
tui    ← crate Rust independiente, solo conoce el protocolo IPC
```

---

## 4. Paquetes — diseño detallado

### 4.1 packages/core

Infraestructura base. Nadie en core importa de code ni cli.

```
packages/core/src/
├── index.ts
├── gateway/
│   ├── http.ts               # servidor Elysia
│   └── mcp.ts                # MCP server integration
├── agent/
│   ├── ace-loop.ts           # Action-Context-Execute loop
│   ├── context-compiler.ts   # FT5 / carga dinámica de skills
│   └── model-adapter.ts      # abstracción multi-modelo (OpenAI, Anthropic, etc)
├── tools/
│   ├── registry.ts           # registro + FT5 indexing
│   ├── cli/                  # shell executor + sandbox (bwrap / seatbelt)
│   ├── files/                # read / write / edit / diff
│   └── search/               # ripgrep, FTS5
├── db/
│   ├── client.ts             # cliente SQLite Bun nativo, WAL mode
│   ├── schema.ts             # definición de tablas (source of truth)
│   ├── repos/                # repositorios por entidad
│   │   ├── sessions.ts
│   │   ├── messages.ts
│   │   ├── checkpoints.ts
│   │   ├── agent-context.ts  # blackboard
│   │   ├── agent-conflicts.ts
│   │   ├── agent-awareness.ts
│   │   ├── adrs.ts
│   │   └── file-risks.ts
│   └── migrations/
│       ├── 001_initial.sql
│       ├── 002_agent_context.sql
│       └── 003_checkpoints.sql
└── ipc/
    ├── server.ts             # Unix socket server
    ├── protocol.ts           # tipos TypeScript de mensajes
    └── envelope.ts           # envelope con prioridad + seq
```

### 4.2 packages/code

Lógica de orquestación. Importa de core.

```
packages/code/src/
├── index.ts
├── coordinator/
│   ├── manager.ts            # CoordinatorManager — ciclo de vida
│   ├── bee.ts                # Bee — coordinador principal
│   └── base.ts               # clase base
├── workers/
│   ├── base.ts               # clase base Worker con acceso al blackboard
│   ├── architecture.ts
│   ├── backend.ts
│   ├── frontend.ts
│   ├── security.ts
│   ├── test.ts
│   └── devops.ts
├── checkpoint/
│   ├── manager.ts            # ciclo de vida de checkpoints
│   ├── snapshot.ts           # snapshot de archivos → SQLite
│   └── rollback.ts           # restauración desde SQLite
├── adr/
│   ├── loader.ts             # carga y actualiza ADRs en SQLite
│   ├── analyzer.ts           # cruza archivos con ADRs relevantes
│   └── risk.ts               # calcula RiskLevel
├── context/
│   ├── blackboard.ts         # API del blackboard para workers y Bee
│   └── conflict-detector.ts  # detecta conflictos entre workers
└── modes/
    ├── plan.ts
    ├── approval.ts
    └── auto.ts
```

### 4.3 packages/cli

Punto de entrada. Importa de core y code.

```
packages/cli/src/
├── index.ts                  # binario hivecode
├── commands/
│   ├── start.ts              # hivecode <task>
│   ├── config.ts             # hivecode config set/get
│   └── rollback.ts           # hivecode rollback <id>
├── tui-launcher.ts           # spawn del binario Rust
├── session.ts                # ciclo de vida completo
└── config.ts                 # lectura HIVECODE.md + .hivecode/config.json
```

### 4.4 packages/tui (Rust)

Ver sección 9 para el diseño completo.

```
packages/tui/
├── Cargo.toml
└── src/
    ├── main.rs
    ├── app.rs                # event loop tokio::select!
    ├── state/
    │   ├── mod.rs            # AppState
    │   ├── session.rs
    │   ├── input.rs
    │   ├── history.rs
    │   ├── thought.rs        # ThoughtStreamState
    │   ├── workers.rs
    │   ├── filemap.rs
    │   ├── checkpoint.rs
    │   ├── adr.rs
    │   ├── modal.rs
    │   ├── logs.rs
    │   └── dirty.rs
    ├── ipc/
    │   ├── mod.rs
    │   ├── messages.rs       # BunMessage + TuiMessage
    │   └── envelope.rs
    ├── renderer/
    │   ├── mod.rs            # render() + selección de layout
    │   ├── plan.rs
    │   ├── code.rs
    │   ├── review.rs
    │   ├── focus.rs
    │   └── dashboard.rs
    ├── widgets/
    │   ├── mod.rs
    │   ├── header.rs
    │   ├── input.rs
    │   ├── history.rs
    │   ├── thought_stream.rs
    │   ├── workers_panel.rs
    │   ├── file_map.rs
    │   ├── diff_view.rs
    │   ├── checkpoint_bar.rs
    │   ├── adr_viewer.rs
    │   ├── conflict_alert.rs
    │   ├── modal.rs
    │   ├── mascot.rs
    │   └── logs.rs
    └── commands.rs
```

---

## 5. Capa de datos — SQLite schema completo

Una base de datos por sesión: `~/.hivecode/sessions/<session_id>.db`  
Abierta en **WAL mode** — lecturas concurrentes del TUI sin bloquear escrituras de Bun.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;  -- WAL hace esto seguro y más rápido

-- ═══════════════════════════════════════════════════════════════
-- SESIONES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  project_path  TEXT    NOT NULL,
  project_name  TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  mode          TEXT    NOT NULL DEFAULT 'plan', -- plan|approval|auto
  provider      TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  version       TEXT    NOT NULL,
  token_count   INTEGER DEFAULT 0,
  cost_usd      REAL    DEFAULT 0.0
);

-- ═══════════════════════════════════════════════════════════════
-- HISTORIAL DE MENSAJES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  role          TEXT    NOT NULL,  -- user|assistant|system|worker
  agent         TEXT,              -- bee|backend|frontend|etc (si es worker)
  content       TEXT    NOT NULL,
  content_type  TEXT    DEFAULT 'text',  -- text|markdown|code|diff
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

-- ═══════════════════════════════════════════════════════════════
-- AGENT CONTEXT — EL BLACKBOARD
-- Pizarrón compartido entre Bee y todos los workers
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE agent_context (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  agent         TEXT    NOT NULL,  -- bee|architecture|backend|frontend|etc
  type          TEXT    NOT NULL,
  -- Tipos posibles:
  --   decision    → "No usar Redis, usar SQLite para token blacklist"
  --   constraint  → "No tocar src/db/schema.ts sin migration script"
  --   reasoning   → "Elegí JWT sobre sessions porque el ADR-003 dice..."
  --   observation → "Frontend worker está usando Tailwind v4"
  --   question    → "¿Backend worker ya definió el endpoint de refresh?"
  --   answer      → respuesta a una question
  content       TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active',
  -- Estados:
  --   active      → vigente, los workers deben respetarlo
  --   superseded  → reemplazado por otro contexto más nuevo
  --   resolved    → una question fue respondida
  --   rejected    → Bee o el dev lo rechazó
  scope         TEXT    DEFAULT 'session',
  -- Scopes:
  --   session     → solo esta sesión
  --   project     → persiste entre sesiones del mismo proyecto
  --   global      → persiste siempre
  file_path     TEXT,              -- archivo relacionado (si aplica)
  parent_id     INTEGER REFERENCES agent_context(id),  -- para threads
  resolved_by   TEXT,              -- agente que resolvió/supersedió
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_ctx_session_active
  ON agent_context(session_id, status, type);
CREATE INDEX idx_ctx_file
  ON agent_context(session_id, file_path)
  WHERE file_path IS NOT NULL;

-- FTS5 para que los workers busquen contexto por contenido
CREATE VIRTUAL TABLE agent_context_fts USING fts5(
  content,
  agent,
  type,
  content='agent_context',
  content_rowid='id'
);

-- ═══════════════════════════════════════════════════════════════
-- AGENT CONFLICTS — conflictos entre workers
-- Bee los detecta y decide cómo resolverlos
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE agent_conflicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  agent_a       TEXT    NOT NULL,  -- primer worker en conflicto
  agent_b       TEXT    NOT NULL,  -- segundo worker en conflicto
  type          TEXT    NOT NULL,
  -- Tipos:
  --   file_collision   → ambos quieren escribir el mismo archivo
  --   decision_clash   → decisiones contradictorias en agent_context
  --   adr_violation    → un worker viola un ADR activo
  --   dependency_race  → ambos crean dependencias incompatibles
  description   TEXT    NOT NULL,
  file_path     TEXT,
  context_id_a  INTEGER REFERENCES agent_context(id),
  context_id_b  INTEGER REFERENCES agent_context(id),
  severity      TEXT    NOT NULL DEFAULT 'medium', -- low|medium|high|critical
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by   TEXT,   -- bee|human
  resolution    TEXT,   -- descripción de cómo se resolvió
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

CREATE INDEX idx_conflicts_unresolved
  ON agent_conflicts(session_id, resolved)
  WHERE resolved = FALSE;

-- ═══════════════════════════════════════════════════════════════
-- AGENT AWARENESS — conciencia de Bee sobre sus workers
-- Bee actualiza esto después de cada observación
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE agent_awareness (
  session_id        TEXT    NOT NULL REFERENCES sessions(id),
  observer          TEXT    NOT NULL,  -- siempre 'bee' en v1
  observed          TEXT    NOT NULL,  -- el worker observado
  phase             TEXT,              -- fase actual del worker
  status            TEXT,              -- waiting|running|done|failed
  last_known_action TEXT,              -- última acción observada
  last_known_file   TEXT,              -- último archivo tocado
  pending_question  INTEGER REFERENCES agent_context(id),
  -- pregunta que Bee le hizo a este worker y espera respuesta
  confidence        REAL    DEFAULT 1.0,
  -- 1.0 = conocimiento fresco, decae con el tiempo
  updated_at        INTEGER NOT NULL,
  -- Fix Bug-D: observer siempre es 'bee' en v1 → PK (session_id, observed) sería
  -- suficiente. Se mantiene (session_id, observer, observed) para extensibilidad
  -- futura (workers observándose entre sí), pero documentado aquí para no confundir.
  PRIMARY KEY (session_id, observer, observed)
);

-- ═══════════════════════════════════════════════════════════════
-- CHECKPOINTS — sistema de rollback
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE checkpoints (
  id            TEXT    PRIMARY KEY,   -- "cp_<timestamp>_<4chars>"
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  created_by    TEXT    NOT NULL,      -- bee|backend|frontend|human|halt
  description   TEXT    NOT NULL,
  file_count    INTEGER NOT NULL DEFAULT 0,
  git_stash_ref TEXT,                  -- ref del git stash si aplica
  created_at    INTEGER NOT NULL,
  restored_at   INTEGER               -- null = no restaurado aún
);

CREATE TABLE checkpoint_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id TEXT    NOT NULL REFERENCES checkpoints(id),
  file_path     TEXT    NOT NULL,
  content       BLOB    NOT NULL,      -- comprimido con ZSTD
  content_hash  TEXT    NOT NULL,      -- SHA256 del original
  operation     TEXT    NOT NULL       -- created|modified|deleted
);

CREATE INDEX idx_cp_session ON checkpoints(session_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- ADRs — Architecture Decision Records
-- Indexados para búsqueda rápida por el agente
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE adrs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path     TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'accepted',
  -- accepted|deprecated|superseded|proposed
  content       TEXT    NOT NULL,      -- markdown completo
  summary       TEXT,                  -- resumen generado por Bee
  updated_at    INTEGER NOT NULL
);

CREATE VIRTUAL TABLE adrs_fts USING fts5(
  title,
  content,
  content='adrs',
  content_rowid='id'
);

-- ═══════════════════════════════════════════════════════════════
-- FILE RISKS — mapa de riesgo por archivo
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE file_risks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  file_path     TEXT    NOT NULL,
  risk_level    TEXT    NOT NULL,   -- low|medium|high|critical
  operation     TEXT,               -- created|modified|deleted
  adr_ref       TEXT,               -- ADR que genera el riesgo
  reason        TEXT,
  agent         TEXT,               -- worker que toca el archivo
  updated_at    INTEGER NOT NULL,
  UNIQUE (session_id, file_path)
);

-- ═══════════════════════════════════════════════════════════════
-- WORKER ACTIVITY — log de actividad por worker
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE worker_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(id),
  worker        TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  status        TEXT    NOT NULL,   -- waiting|running|done|failed
  current_action TEXT,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  started_at    INTEGER,
  completed_at  INTEGER
);

-- ═══════════════════════════════════════════════════════════════
-- VISTA: estado mental de Bee (la query de conciencia)
-- ═══════════════════════════════════════════════════════════════

-- Fix Bug-C: las VIEWs SQLite no admiten parámetros.
-- Solución: exponer session_id en el SELECT para que el caller filtre
-- con WHERE session_id = ? en la query preparada.
-- Nunca consultar esta view sin filtrar por session_id.
CREATE VIEW bee_awareness AS
SELECT
  aa.session_id,                                        -- ← expuesto para filtrar
  aa.observed                                   AS worker,
  aa.phase,
  aa.status,
  aa.last_known_action,
  aa.last_known_file,
  aa.confidence,
  -- Última decisión activa del worker
  (SELECT content FROM agent_context
   WHERE session_id = aa.session_id
   AND   agent      = aa.observed
   AND   type       = 'decision'
   AND   status     = 'active'
   ORDER BY created_at DESC LIMIT 1)            AS last_decision,
  -- ¿Tiene conflictos sin resolver?
  EXISTS (
    SELECT 1 FROM agent_conflicts
    WHERE session_id = aa.session_id
    AND   (agent_a   = aa.observed OR agent_b = aa.observed)
    AND   resolved   = FALSE
  )                                             AS has_conflict,
  -- Número de conflictos activos
  (SELECT COUNT(*) FROM agent_conflicts
   WHERE session_id = aa.session_id
   AND   (agent_a   = aa.observed OR agent_b = aa.observed)
   AND   resolved   = FALSE)                    AS conflict_count
FROM agent_awareness aa
WHERE aa.observer = 'bee';
```

---

## 6. Agent Context Layer — coordinación viva

### El Blackboard Pattern

Los workers no se llaman entre sí. Escriben y leen del blackboard (tabla `agent_context`). Bee observa el pizarrón y coordina. Esto elimina el acoplamiento directo y permite que Bee detecte conflictos antes de que ocurran.

```
Worker A escribe:  "Voy a crear tabla token_blacklist"
Worker B escribe:  "Voy a crear tabla blacklisted_tokens"
Bee detecta:       ¡Colisión de nombres! → agent_conflicts
Bee resuelve:      Elige un nombre → escribe decision en agent_context
Workers leen:      Ambos ven la decisión de Bee y convergen
```

### API del Blackboard (TypeScript)

```typescript
// packages/code/context/blackboard.ts

export class Blackboard {
  constructor(private db: Database, private sessionId: string) {}

  // Escribir en el pizarrón
  async write(agent: string, type: ContextType, content: string,
              options?: { filePath?: string, parentId?: number,
                          scope?: ContextScope }): Promise<number> {
    const now = Date.now()
    const result = this.db.run(`
      INSERT INTO agent_context
        (session_id, agent, type, content, file_path, parent_id, scope,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [this.sessionId, agent, type, content,
        options?.filePath, options?.parentId,
        options?.scope ?? 'session', now, now])

    // Actualizar FTS5
    this.db.run(`
      INSERT INTO agent_context_fts(rowid, content, agent, type)
      VALUES (?, ?, ?, ?)
    `, [result.lastInsertRowid, content, agent, type])

    return result.lastInsertRowid as number
  }

  // Leer contexto relevante (lo que un worker consulta antes de actuar)
  async readRelevant(agent: string, filePath?: string,
                     query?: string): Promise<ContextEntry[]> {
    if (query) {
      // Búsqueda FTS5 por contenido
      return this.db.query(`
        SELECT ac.* FROM agent_context ac
        JOIN agent_context_fts fts ON fts.rowid = ac.id
        WHERE fts MATCH ?
        AND   ac.session_id = ?
        AND   ac.status     = 'active'
        ORDER BY ac.created_at DESC
        LIMIT 20
      `).all(query, this.sessionId) as ContextEntry[]
    }

    if (filePath) {
      // Contexto relacionado con un archivo específico
      return this.db.query(`
        SELECT * FROM agent_context
        WHERE session_id = ?
        AND   status     = 'active'
        AND   (file_path = ? OR file_path IS NULL)
        ORDER BY created_at DESC
        LIMIT 30
      `).all(this.sessionId, filePath) as ContextEntry[]
    }

    // Contexto general activo
    return this.db.query(`
      SELECT * FROM agent_context
      WHERE session_id = ?
      AND   status     = 'active'
      ORDER BY created_at DESC
      LIMIT 50
    `).all(this.sessionId) as ContextEntry[]
  }

  // Superseder un contexto anterior (nueva decisión reemplaza vieja)
  async supersede(id: number, replacedBy: string): Promise<void> {
    this.db.run(`
      UPDATE agent_context
      SET status = 'superseded', resolved_by = ?, updated_at = ?
      WHERE id = ?
    `, [replacedBy, Date.now(), id])
  }

  // Fix Bug-C: filtrar por session_id — la view expone la columna para esto
  async beeAwareness(): Promise<WorkerAwareness[]> {
    return this.db.query(
      'SELECT * FROM bee_awareness WHERE session_id = ?'
    ).all(this.sessionId) as WorkerAwareness[]
  }

  // Preguntar a otro worker (crea question en el blackboard)
  async askWorker(from: string, to: string,
                  question: string): Promise<number> {
    const id = await this.write(from, 'question', question)
    // Actualizar awareness para saber que hay pregunta pendiente
    this.db.run(`
      UPDATE agent_awareness
      SET pending_question = ?, updated_at = ?
      WHERE session_id = ? AND observer = 'bee' AND observed = ?
    `, [id, Date.now(), this.sessionId, to])
    return id
  }
}
```

### Detector de conflictos (Bee)

```typescript
// packages/code/context/conflict-detector.ts

export class ConflictDetector {
  // Fix Bug-A: ipc agregado al constructor — era referenciado pero no declarado
  constructor(private db: Database, private sessionId: string,
              private blackboard: Blackboard,
              private ipc: IpcServer) {}

  // Ejecutar antes de que cada worker empiece a escribir
  async checkBeforeWrite(agent: string, filePath: string): Promise<Conflict[]> {
    const conflicts: Conflict[] = []

    // 1. ¿Otro worker ya está tocando este archivo?
    const collision = this.db.query(`
      SELECT fr.agent, fr.operation FROM file_risks fr
      WHERE fr.session_id = ?
      AND   fr.file_path  = ?
      AND   fr.agent     != ?
      AND   fr.updated_at > ?
    `).get(this.sessionId, filePath, agent,
           Date.now() - 30_000) as any  // activo en los últimos 30s

    if (collision) {
      conflicts.push({
        type: 'file_collision',
        agentA: agent,
        agentB: collision.agent,
        filePath,
        description: `${agent} y ${collision.agent} quieren modificar ${filePath} simultáneamente`,
        severity: 'high',
      })
    }

    // 2. ¿Este archivo tiene un constraint activo en el blackboard?
    const constraint = this.db.query(`
      SELECT * FROM agent_context
      WHERE session_id = ?
      AND   type       = 'constraint'
      AND   status     = 'active'
      AND   file_path  = ?
    `).get(this.sessionId, filePath) as any

    if (constraint) {
      conflicts.push({
        type: 'adr_violation',
        agentA: agent,
        agentB: 'bee',
        filePath,
        description: `${agent} quiere modificar ${filePath} pero existe un constraint: "${constraint.content}"`,
        severity: 'critical',
        contextId: constraint.id,
      })
    }

    // Persistir conflictos encontrados
    for (const c of conflicts) {
      this.db.run(`
        INSERT INTO agent_conflicts
          (session_id, agent_a, agent_b, type, description,
           file_path, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [this.sessionId, c.agentA, c.agentB, c.type,
          c.description, c.filePath, c.severity, Date.now()])

      // Emitir al TUI via IPC
      this.ipc.emit('conflict_detected', c)
    }

    return conflicts
  }
}
```

### Worker base — cómo usa el blackboard

```typescript
// packages/code/workers/base.ts

export abstract class BaseWorker {
  constructor(
    protected name:       string,
    protected blackboard: Blackboard,
    protected detector:   ConflictDetector,
    protected ipc:        IpcServer,
  ) {}

  // Todo worker llama esto antes de tocar un archivo
  protected async safeWrite(filePath: string,
                             action: () => Promise<void>): Promise<void> {
    // 1. Leer contexto relevante del blackboard
    const context = await this.blackboard.readRelevant(this.name, filePath)

    // 2. Detectar conflictos
    const conflicts = await this.detector.checkBeforeWrite(this.name, filePath)
    if (conflicts.some(c => c.severity === 'critical')) {
      // Publicar que estoy bloqueado
      await this.blackboard.write(this.name, 'observation',
        `Bloqueado en ${filePath}: ${conflicts[0].description}`,
        { filePath })
      return  // Bee decidirá qué hacer
    }

    // 3. Registrar que voy a tocar este archivo
    await this.blackboard.write(this.name, 'observation',
      `Iniciando escritura en ${filePath}`, { filePath })

    // 4. Ejecutar la acción
    await action()

    // 5. Registrar que terminé
    await this.blackboard.write(this.name, 'observation',
      `Completada escritura en ${filePath}`, { filePath })
  }

  // Todo worker publica su razonamiento antes de decidir
  protected async think(reasoning: string,
                        filePath?: string): Promise<void> {
    await this.blackboard.write(this.name, 'reasoning', reasoning,
                                { filePath })
    // También emitir al TUI como ReasoningChunk
    this.ipc.emit('reasoning_chunk', {
      coordinator: this.name,
      content: reasoning,
      is_final: false,
    })
  }
}
```

---

## 7. Checkpoint & Rollback

### Cuándo se crea un checkpoint

1. **Automático** — antes de cualquier tool call de escritura
2. **Por fase** — al inicio de cada fase del ACE loop
3. **Por HALT** — cuando el usuario para el agente desde el TUI
4. **Manual** — `/checkpoint` desde el TUI

### CheckpointManager

```typescript
// packages/code/checkpoint/manager.ts

export class CheckpointManager {
  constructor(private db: Database, private sessionId: string,
              private ipc: IpcServer) {}

  async create(description: string, filePaths: string[],
               createdBy: string): Promise<string> {
    const id = `cp_${Date.now()}_${randomBytes(2).toString('hex')}`

    // Snapshot de archivos actuales
    const files: CheckpointFile[] = []

    // Fix Bug-E: separar archivos existentes (modified) de nuevos (created)
    // para registrar correctamente la operación de rollback

    // 1. Archivos que YA EXISTEN → snapshot del contenido previo
    for (const path of filePaths) {
      if (!existsSync(path)) continue
      const content = readFileSync(path)
      const hash    = createHash('sha256').update(content).digest('hex')
      const existing = this.db.query(
        'SELECT content_hash FROM checkpoint_files WHERE file_path = ? ORDER BY rowid DESC LIMIT 1'
      ).get(path) as any

      if (existing?.content_hash !== hash) {
        // Fix Bug-B: API correcta es Bun.zstdCompressSync (no Bun.zstd.compress)
        // Disponible desde Bun v1.2.14 — bun.com/blog/bun-v1.2.14
        files.push({
          path,
          content: Bun.zstdCompressSync(content),
          hash,
          operation: 'modified',  // existía antes → rollback = restaurar
        })
      }
    }

    // 2. Archivos que NO EXISTEN aún → el agente los va a crear
    // Rollback = eliminar el archivo. No hay contenido previo que guardar.
    for (const path of filePaths) {
      if (existsSync(path)) continue  // ya procesado arriba
      files.push({
        path,
        content: Buffer.alloc(0),     // vacío — el archivo no existía
        hash:    '',
        operation: 'created',         // rollback = delete
      })
    }

    // Persistir
    this.db.run(`
      INSERT INTO checkpoints (id, session_id, created_by, description,
                               file_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, this.sessionId, createdBy, description, files.length, Date.now()])

    for (const f of files) {
      this.db.run(`
        INSERT INTO checkpoint_files
          (checkpoint_id, file_path, content, content_hash, operation)
        VALUES (?, ?, ?, ?, ?)
      `, [id, f.path, f.content, f.hash, f.operation])
    }

    // Notificar TUI
    this.ipc.emit('checkpoint_created', {
      id,
      description,
      files: files.map(f => f.path),
      created_at: Date.now(),
    })

    return id
  }

  async rollback(checkpointId: string): Promise<void> {
    const files = this.db.query(`
      SELECT * FROM checkpoint_files WHERE checkpoint_id = ?
    `).all(checkpointId) as CheckpointFile[]

    // Fix Bug-E: operation = lo que hizo el agente, no la inversa
    // 'created'  → agente lo creó, rollback = DELETE
    // 'modified' → agente lo modificó, rollback = RESTORE contenido previo
    // 'deleted'  → agente lo borró, rollback = RESTORE contenido previo
    // El content guardado es siempre el estado PREVIO a la operación del agente
    for (const file of files) {
      switch (file.operation) {
        case 'created':
          // El archivo no existía antes — rollback = eliminarlo
          if (existsSync(file.file_path)) unlinkSync(file.file_path)
          break
        case 'modified':
        case 'deleted':
          // Fix Bug-B: API correcta es Bun.zstdDecompressSync (no Bun.zstd.decompress)
          const content = Bun.zstdDecompressSync(file.content)
          writeFileSync(file.file_path, content)
          break
      }
    }

    this.db.run(`
      UPDATE checkpoints SET restored_at = ? WHERE id = ?
    `, [Date.now(), checkpointId])

    this.ipc.emit('rollback_complete', {
      checkpoint_id: checkpointId,
      files_restored: files.length,
    })
  }
}
```

---

## 8. Protocolo IPC Bun ↔ TUI

### Transporte y formato

- **Unix Domain Socket** — path en `HIVECODE_IPC`
- **NDJSON** — un JSON por línea
- **Envelope con prioridad** — tres canales en el TUI

### Envelope

```typescript
// TypeScript (Bun)
interface IpcEnvelope {
  priority: 'critical' | 'normal' | 'low'
  seq:      number      // secuencia global
  type:     string      // discriminador del mensaje
  payload:  unknown
}
```

```rust
// Rust (TUI)
#[derive(Deserialize)]
pub struct IpcEnvelope {
    pub priority: Priority,
    pub seq:      u64,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload:  serde_json::Value,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Priority { Critical, Normal, Low }
```

### BunMessage — todos los mensajes Bun → TUI

```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BunMessage {
  // ── Ciclo de vida ──────────────────────────────────────────
  Init {
    mode: String, provider: String, model: String,
    project_name: String, project_path: String,
    session_id: String, version: String,
    token_count: u64,
    // Fix Bug-F: workers es la lista real de workers activos en esta sesión.
    // agent_count estático eliminado — los workers son dinámicos y Bee
    // despacha solo los necesarios. El TUI calcula el count desde workers.len()
    workers: Vec<String>,
  },
  Status        { running: bool, msg: String },
  StateUpdate   { new_mode: Option<String>, new_provider: Option<String>,
                  new_model: Option<String> },

  // ── Historial ──────────────────────────────────────────────
  HistoryAppend { role: String, content: String,
                  content_type: Option<String>, agent: Option<String> },
  NarrativeChunk{ coordinator: String, phase: String,
                  content: String, content_type: Option<String>,
                  stream_id: Option<String> },

  // ── Razonamiento (blackboard → TUI) ───────────────────────
  ReasoningChunk{ coordinator: String, content: String, is_final: bool },

  // ── Workers ────────────────────────────────────────────────
  ActivityUpdate{ coordinator: String, phase: String, status: String,
                  current_action: Option<String> },
  WorkersSnapshot{ workers: Vec<WorkerStatus> },

  // ── Archivos y riesgo ──────────────────────────────────────
  FileRiskUpdate{ path: String, risk: String, operation: Option<String>,
                  adr_ref: Option<String>, reason: Option<String>,
                  agent: Option<String> },
  FilesSnapshot { files: Vec<FileEntry> },

  // ── Checkpoints ────────────────────────────────────────────
  CheckpointCreated { id: String, description: String,
                      files: Vec<String>, created_at: u64 },
  RollbackComplete  { checkpoint_id: String, files_restored: u32 },
  HaltConfirmed     { snapshot_id: String },

  // ── Agent Context (conflictos visibles en TUI) ─────────────
  ConflictDetected  { agent_a: String, agent_b: String, severity: String,
                      description: String, file_path: Option<String> },
  ConflictResolved  { conflict_id: i64, resolution: String },
  ContextUpdate     { agent: String, context_type: String, content: String,
                      file_path: Option<String> },

  // ── ADRs ───────────────────────────────────────────────────
  AdrUpdate     { path: String, title: String, content: String },

  // ── UI ─────────────────────────────────────────────────────
  Suggestions        { items: Vec<String> },
  ShellOutput        { stdout: String, stderr: String, exit_code: i32 },
  LogEntry           { timestamp: String, level: String,
                       source: String, message: String },
  ShowConfigModal    { command: String, title: String,
                       fields: Vec<ModalField> },
  ShowInfoModal      { title: String, content: String },
  LayoutSuggestion   { layout: String },

  // ── Terminal ───────────────────────────────────────────────
  Suspend,
  Resume,
}
```

### TuiMessage — todos los mensajes TUI → Bun

```rust
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TuiMessage {
  Ready,
  Submit              { input: String },
  SuggestionsRequest  { query: String },
  ModeChange          { mode: String },
  ShellExecute        { command: String },
  RollbackRequest     { checkpoint_id: String },
  HaltRequest         { create_snapshot: bool },
  LayoutChange        { layout: String },
  ResolveConflict     { conflict_id: i64, resolution: String },
  ModalSubmit         { command: String, values: HashMap<String, String> },
  ModalCancel         { command: String },
  InfoModalClose,
  Suspended,
  Exit,
}
```

### Tabla de prioridades IPC

| Mensaje | Prioridad | Razón |
|---------|-----------|-------|
| `HaltConfirmed`, `RollbackComplete` | critical | Respuesta a acción del usuario |
| `CheckpointCreated` | critical | No se puede perder |
| `ConflictDetected` | critical | Requiere atención inmediata |
| `Init`, `StateUpdate` | critical | Metadata de sesión |
| `HistoryAppend`, `ActivityUpdate` | normal | Flujo normal |
| `FileRiskUpdate`, `WorkersSnapshot` | normal | Estado del sistema |
| `ReasoningChunk`, `NarrativeChunk` | normal | Streams |
| `ContextUpdate` | normal | Blackboard updates |
| `LogEntry`, `ShellOutput` | low | Puede dropear bajo presión |

---

## 9. hiveTui — Diseño completo

### 9.1 Filosofía de diseño

**No es un chat.** Es un panel de control de confianza. La metáfora correcta es k9s — estado del sistema en tiempo real con capacidad de intervención.

**Jerarquía de información:**
```
Nivel 1 — siempre visible:  código generado / workers activos
Nivel 2 — siempre visible:  checkpoints + intent actual de Bee
Nivel 3 — toggle (/think):  thought stream del agente
Nivel 4 — toggle (/logs):   logs detallados
```

**Layouts adaptativos:** el layout cambia según la fase. No es un layout fijo que el dev tiene que adaptar.

### 9.2 Cinco layouts

#### Layout::Plan — exploración

```
┌─────────────────────────────────────────────────────────────┐
│  🐝 hiveCode  ·  claude-sonnet  ·  PLAN  ·  tokens: 4.2k   │
├───────────────────────────┬─────────────────────────────────┤
│  THOUGHT STREAM           │  FILE RISK MAP                  │
│  ─────────────────        │  ──────────────                 │
│  bee: "Leyendo ADR-003    │  📁 src/auth/                   │
│  antes de planificar      │    🟡 middleware.ts  MODIFIED   │
│  cambios al schema.       │  📁 src/database/               │
│  La decisión dice que     │    🔴 schema.ts  HIGH RISK      │
│  se requiere migration    │       ↳ ADR-003 aplica          │
│  script..."               │  📁 src/components/             │
│                           │    🟢 Button.tsx  NEW           │
│  architecture: "Analizando│                                 │
│  impacto en 3 módulos..." │  ADR RELEVANTE                  │
│                           │  ADR-003: DB Schema             │
│  [Ctrl+↑↓ scroll]         │  "Migration requerida..."       │
│                           │  [Enter: ver completo]          │
├───────────────────────────┴─────────────────────────────────┤
│  CHECKPOINTS  [cp_14:21]  [cp_14:28]  [cp_14:32 ●]         │
├─────────────────────────────────────────────────────────────┤
│  🐝 │ /approve plan                              [⛔ HALT]  │
└─────────────────────────────────────────────────────────────┘
```

#### Layout::Code — generación activa

```
┌─────────────────────────────────────────────────────────────┐
│  🐝 hiveCode  ·  claude-sonnet  ·  AUTO  ·  tokens: 12.4k  │
├───────────────────────────┬─────────────────────────────────┤
│  DIFF ACTIVO              │  WORKERS                        │
│  src/auth/middleware.ts   │  ✅ architecture   DONE         │
│  ───────────────────      │  🔵 backend        CODING       │
│  + import { sign }...     │     "JWT middleware"            │
│  - const old = async...   │  🔵 frontend       CODING       │
│  + const handler = async  │     "AuthForm"                  │
│    if (!token) {          │  ⚪ security        WAITING      │
│  +   return 401()         │  ⚪ test            WAITING      │
│    }                      │                                 │
│                           │  CHECKPOINT ACTIVO              │
│  [Ctrl+↑↓ scroll]         │  cp_14:35 · 3 archivos          │
│                           │  [↩ ROLLBACK]                   │
│                           │                                 │
│                           │  ⚠ CONFLICTO                    │
│                           │  backend ↔ frontend             │
│                           │  schema.ts [resolver]           │
├───────────────────────────┴─────────────────────────────────┤
│  INTENT: backend → "Implementando JWT refresh token logic"  │
├─────────────────────────────────────────────────────────────┤
│  🐝 │ /think                                    [⛔ HALT]   │
└─────────────────────────────────────────────────────────────┘
```

#### Layout::Review — aprobación humana

```
┌─────────────────────────────────────────────────────────────┐
│  🐝 hiveCode  ·  claude-sonnet  ·  APPROVAL  ·  WAITING    │
├─────────────────────────────────────────────────────────────┤
│  ADR-003: Database Schema Changes                          │
│  Status: accepted                                          │
│  ═══════════════════════════════                           │
│  ## Contexto                                               │
│  Cada cambio al schema debe incluir migration script       │
│  usando Drizzle ORM con drizzle-kit generate...            │
│                                                            │
│  ## Decisión                                               │
│  Se usará drizzle-kit para generar migraciones             │
│  automáticamente antes de cualquier deploy...              │
│                                                            │
│  [Ctrl+↑↓ scroll · /search <query>]               4/8 ▐   │
├─────────────────────────────────────────────────────────────┤
│  ARCHIVOS A APROBAR:                                        │
│  ✅ src/auth/middleware.ts    47 líneas   riesgo bajo       │
│  ⚠️  src/database/schema.ts   12 líneas   ADR-003 aplica    │
│  ✅ src/components/Button.tsx  nuevo      riesgo bajo       │
├─────────────────────────────────────────────────────────────┤
│  🐝 │ /approve  ó  /reject  ó  /modify schema              │
└─────────────────────────────────────────────────────────────┘
```

#### Layout::Dashboard — todos los workers

```
┌─────────────────────────────────────────────────────────────┐
│  🐝 hiveCode  ·  AUTO  ·  6 workers  ·  $0.23  ·  14:38   │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│ ARCHITECTURE│   BACKEND   │   FRONTEND  │     SECURITY      │
│ ─────────── │ ──────────  │ ──────────  │ ───────────────   │
│ ✅ DONE     │ 🔵 CODING   │ 🔵 CODING   │ ⚪ WAITING         │
│             │ JWT refresh │ AuthForm    │                   │
│ Plan:       │             │             │                   │
│ ADR-003 ok  │ 3 archivos  │ 2 archivos  │                   │
│ migration   │ modificados │ nuevos      │                   │
│ incluida    │             │             │                   │
├─────────────┴─────────────┴─────────────┴───────────────────┤
│  ⚠ CONFLICTO: backend ↔ frontend · schema.ts  [resolver]   │
│  CHECKPOINTS: [14:21] [14:28] [14:35 ●]        [↩ ROLLBACK]│
├─────────────────────────────────────────────────────────────┤
│  🐝 │ /focus backend                             [⛔ HALT]  │
└─────────────────────────────────────────────────────────────┘
```

#### Layout::Focus — historial full screen

```
┌─────────────────────────────────────────────────────────────┐
│  🐝 hiveCode  ·  claude-sonnet  ·  AUTO                    │
├─────────────────────────────────────────────────────────────┤
│  👤 14:20                                                   │
│  implementa JWT refresh token con blacklist                 │
│                                                             │
│  🤖 bee  14:21                                              │
│  Analicé el codebase. ADR-003 requiere migration script    │
│  para cualquier cambio al schema. Mi plan:                  │
│  1. Tabla token_blacklist en schema.ts + migration          │
│  2. Middleware de validación en auth/                       │
│  3. Tests de integración                                    │
│  ¿Apruebo?                                                  │
│                                                             │
│  👤 14:22  sí, procede                                      │
│                                                             │
│  🤖 backend  14:23                                          │
│  Creando auth/middleware.ts...                              │
│                                                             │
│  [Ctrl+↑↓]                                        4/8  ▐   │
├─────────────────────────────────────────────────────────────┤
│  🐝 │ _                             [Ctrl+L: layout code]   │
└─────────────────────────────────────────────────────────────┘
```

### 9.3 Estado de la aplicación

```rust
pub struct AppState {
    pub session:     SessionState,
    pub input:       InputState,
    pub history:     HistoryState,
    pub thought:     ThoughtStreamState,
    pub workers:     WorkerState,
    pub filemap:     FileMapState,
    pub checkpoints: CheckpointState,
    pub conflicts:   ConflictState,
    pub context:     AgentContextState,  // blackboard visible en TUI
    pub adrs:        AdrState,
    pub modal:       ModalState,
    pub logs:        LogState,
    pub mascot:      MascotState,
    pub layout:      LayoutMode,
    pub focus:       FocusArea,
    pub dirty:       DirtyFlags,
}

// SessionState — fuente de verdad única (fix Bug 6)
pub struct SessionState {
    pub provider:  String,
    pub model:     String,
    pub mode:      ReplMode,
    pub project:   String,
    pub session_id: String,
    pub version:   String,
    pub token_count: u64,
    pub cost_usd:  f64,
    pub running:   bool,
    pub status:    String,
    // Fix Bug-F: lista dinámica de workers activos en lugar de agent_count fijo
    pub workers:   Vec<String>,
}

impl SessionState {
    pub fn apply_update(&mut self, d: &mut DirtyFlags,
                        mode: Option<String>, provider: Option<String>,
                        model: Option<String>) {
        let mut changed = false;
        if let Some(p) = provider { self.provider = p; changed = true; }
        if let Some(m) = model    { self.model    = m; changed = true; }
        if let Some(v) = mode     {
            self.mode = ReplMode::from(&v);
            changed = true;
        }
        if changed { d.header = true; }
    }
}

// InputState — cursor UTF-8 correcto (fix Bug 5)
pub struct InputState {
    pub buffer:    String,
    pub cursor:    usize,       // posición en chars
    pub history:   Vec<String>,
    pub hist_idx:  Option<usize>,
}

impl InputState {
    pub fn scroll_offset(&self, width: usize) -> u16 {
        self.cursor.saturating_sub(width.saturating_sub(2)) as u16
    }

    pub fn insert(&mut self, c: char) {
        let b = self.char_to_byte(self.cursor);
        self.buffer.insert(b, c);
        self.cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 { return; }
        self.cursor -= 1;
        let b = self.char_to_byte(self.cursor);
        self.buffer.remove(b);
    }

    fn char_to_byte(&self, n: usize) -> usize {
        self.buffer.char_indices()
            .nth(n).map(|(i, _)| i)
            .unwrap_or(self.buffer.len())
    }
}

// CheckpointState
pub struct CheckpointState {
    pub list:     VecDeque<Checkpoint>,  // cap: 50
    pub selected: Option<usize>,
}

impl CheckpointState {
    pub fn push(&mut self, cp: Checkpoint) {
        if self.list.len() >= 50 { self.list.pop_front(); }
        for c in &mut self.list { c.is_active = false; }
        let mut cp = cp; cp.is_active = true;
        self.list.push_back(cp);
    }
    pub fn selected_id(&self) -> Option<String> {
        self.selected.and_then(|i| self.list.get(i))
                     .map(|c| c.id.clone())
    }
}

// ConflictState — conflictos visibles en TUI
pub struct ConflictState {
    pub active: Vec<AgentConflict>,
    pub dismissed: Vec<i64>,  // IDs ignorados por el dev
}

// DirtyFlags — render selectivo (fix Bug 2)
pub struct DirtyFlags {
    pub header:      bool,
    pub history:     bool,
    pub thought:     bool,
    pub workers:     bool,
    pub filemap:     bool,
    pub checkpoints: bool,
    pub conflicts:   bool,
    pub input:       bool,
    pub logs:        bool,
    pub mascot:      bool,
    pub full:        bool,  // resize o cambio de layout
}
```

### 9.4 Event loop

```rust
pub async fn run(screen: &str) -> Result<()> {
    install_panic_hook();  // restaura terminal antes de panic

    let (crit_rx, norm_rx, low_rx, ipc_tx) = ipc::connect().await?;
    let mut state  = AppState::default();
    let mut term   = setup_terminal()?;
    let mut events = EventStream::new();
    let mut tick   = interval(Duration::from_millis(200));

    let _ = ipc_tx.try_send(TuiMessage::Ready);

    loop {
        if state.dirty.any() {
            term.draw(|f| renderer::render(f, &mut state))?;
            state.dirty.clear();
        }

        tokio::select! {
            biased;

            // 1. Críticos primero — checkpoint, halt, conflictos
            Some(msg) = crit_rx.recv() => {
                state.apply_critical(msg, &ipc_tx);
            }
            // 2. Teclado
            Some(Ok(Event::Key(key))) = events.next() => {
                if handle_key(&mut state, key, &ipc_tx) { break; }
            }
            // 3. Resize
            Some(Ok(Event::Resize(_, _))) = events.next() => {
                state.dirty.full = true;
            }
            // 4. Mensajes normales
            Some(msg) = norm_rx.recv() => {
                state.apply_normal(msg);
            }
            // 5. Tick mascota
            _ = tick.tick() => {
                state.mascot.tick();
                state.dirty.mascot = true;
            }
            // 6. Logs (low)
            Some(msg) = low_rx.recv() => {
                state.apply_low(msg);
            }
        }
    }

    restore_terminal(&mut term)?;
    Ok(())
}
```

### 9.5 Widgets principales

#### Input con cursor correcto (fix Bug 5)

```rust
pub fn render_input(f: &mut Frame, s: &InputState, area: Rect) {
    let w      = area.width as usize;
    let offset = s.scroll_offset(w);

    f.render_widget(
        Paragraph::new(s.buffer.as_str()).scroll((0, offset)),
        area,
    );

    let cx = area.x + (s.cursor as u16).saturating_sub(offset)
                                        .min(area.width - 1);
    f.set_cursor_position((cx, area.y));
}
```

#### Historial con scroll (fix Bug 3)

```rust
pub fn render_history(f: &mut Frame, s: &mut HistoryState, area: Rect) {
    let h     = area.height as usize;
    let total = s.entries.len();
    let start = s.offset.min(total.saturating_sub(h));

    let items: Vec<ListItem> = s.entries[start..]
        .iter().take(h)
        .map(entry_to_item)
        .collect();

    f.render_widget(List::new(items), area);

    // Scrollbar con marcadores de posición
    s.scroll_state = s.scroll_state.content_length(total).position(start);
    f.render_stateful_widget(
        Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .thumb_symbol("▐"),
        area,
        &mut s.scroll_state,
    );
}
```

#### Mascota (fix Bug 4 — único punto de render)

```rust
// renderer/mod.rs — la mascota SOLO se llama aquí
fn render_bottom(f: &mut Frame, s: &mut AppState, area: Rect) {
    let cols = Layout::horizontal([
        Constraint::Length(4),  // mascota — ancho fijo
        Constraint::Min(1),     // input
        Constraint::Length(10), // mode + HALT
    ]).split(area);

    widgets::mascot::render(f, &s.mascot, cols[0]);  // ÚNICA LLAMADA
    widgets::input::render_input(f, &s.input, cols[1]);
    render_mode_halt(f, s, cols[2]);
}
```

#### Checkpoint Bar

```rust
pub fn render_checkpoint_bar(f: &mut Frame, s: &CheckpointState, area: Rect) {
    let spans: Vec<Span> = s.list.iter().enumerate().map(|(i, cp)| {
        let label = cp.id.get(3..8).unwrap_or("?");
        let style = match (cp.is_active, s.selected == Some(i)) {
            (true,  _)     => Style::default().fg(Color::Yellow).bold(),
            (false, true)  => Style::default().fg(Color::Cyan).underlined(),
            _              => Style::default().fg(Color::DarkGray),
        };
        Span::styled(format!("[{}]", label), style)
    }).collect();

    f.render_widget(Paragraph::new(Line::from(spans)), area);
}
```

#### Conflict Alert

```rust
pub fn render_conflicts(f: &mut Frame, s: &ConflictState, area: Rect) {
    if s.active.is_empty() { return; }

    let items: Vec<ListItem> = s.active.iter().map(|c| {
        let style = match c.severity.as_str() {
            "critical" => Style::default().fg(Color::Red).bold(),
            "high"     => Style::default().fg(Color::LightRed),
            _          => Style::default().fg(Color::Yellow),
        };
        ListItem::new(format!("⚠ {} ↔ {} · {}", c.agent_a, c.agent_b,
                              c.description))
                 .style(style)
    }).collect();

    f.render_widget(
        List::new(items).block(Block::bordered().title("CONFLICTOS")),
        area,
    );
}
```

### 9.6 Atajos de teclado

| Tecla | Acción |
|-------|--------|
| `Enter` | Enviar input / confirmar modal |
| `Ctrl+C` | Exit |
| `Ctrl+H` | HALT (crea snapshot) |
| `Ctrl+T` | Toggle thought stream |
| `Ctrl+L` | Ciclar layout |
| `Ctrl+↑` / `Ctrl+↓` | Scroll historial |
| `Tab` | Cambiar foco de panel |
| `←` `→` | Mover cursor en input |
| `Ctrl+←` `Ctrl+→` | Saltar palabra |
| `↑` `↓` | Navegar historial de inputs |
| `[` `]` | Navegar checkpoints |
| `r` (en checkpoint seleccionado) | Rollback |

### 9.7 Comandos slash

```rust
pub fn dispatch(input: &str, state: &mut AppState, tx: &Sender<TuiMessage>) {
    let parts: Vec<&str> = input[1..].splitn(3, ' ').collect();
    match parts.as_slice() {
        // Layout
        ["layout", l] | ["l", l] => {
            state.layout = LayoutMode::from(*l);
            state.dirty.full = true;
        }
        ["focus", w] => {
            state.workers.focused = Some(w.to_string());
            state.layout = LayoutMode::Focus;
            state.dirty.full = true;
        }

        // Rollback
        ["rollback"] => if let Some(id) = state.checkpoints.selected_id() {
            let _ = tx.try_send(TuiMessage::RollbackRequest { checkpoint_id: id });
        },
        ["rollback", id] => {
            let _ = tx.try_send(TuiMessage::RollbackRequest {
                checkpoint_id: id.to_string()
            });
        },

        // Provider / Model (fix Bug 6)
        ["provider", "set", n] | ["p", n] => {
            let _ = tx.try_send(TuiMessage::Submit {
                input: format!("/provider set {n}")
            });
        }
        ["model", "set", n] | ["m", n] => {
            let _ = tx.try_send(TuiMessage::Submit {
                input: format!("/model set {n}")
            });
        }

        // Toggles
        ["think"] | ["t"]      => { state.thought.visible ^= true; state.dirty.full = true; }
        ["logs"]               => { state.logs.visible    ^= true; state.dirty.full = true; }

        // Control
        ["halt"] | ["stop"]    => {
            let _ = tx.try_send(TuiMessage::HaltRequest { create_snapshot: true });
        }
        ["approve"]            => {
            let _ = tx.try_send(TuiMessage::Submit { input: "/approve".into() });
        }
        ["reject"]             => {
            let _ = tx.try_send(TuiMessage::Submit { input: "/reject".into() });
        }

        // Todo lo demás va a Bun
        _ => {
            let _ = tx.try_send(TuiMessage::Submit { input: input.to_string() });
        }
    }
}
```

---

## 10. Sandbox de ejecución

Sin cambios estructurales — es uno de los componentes más sólidos.

### Capas de defensa en orden

| # | Capa | Dónde | Qué bloquea |
|---|------|-------|------------|
| 1 | Modo agente | modes/ | tool calls de escritura en modo plan |
| 2 | Blackboard constraints | agent_context | archivos marcados como protegidos |
| 3 | Regex denylist | tools/cli/index.ts | 25 patrones peligrosos |
| 4 | Validación cwd | workspace-guard.ts | salir del workspace por path |
| 5 | bwrap (Linux) | sandbox-bwrap.ts | namespaces: FS, PID, net, caps |
| 6 | seatbelt (macOS) | sandbox-seatbelt.ts | perfil SBPL por proceso |
| 7 | Límite output | index.ts | DoS por stdout > 10 MB |
| 8 | Timeout | AbortController | comandos colgados > 30s |

### Mejora planificada v1.1

Reescribir `sandbox-bwrap.ts` como crate Rust que recibe `SandboxConfig` por stdin JSON. Permite añadir `prlimit` y cgroups v2 sin tocar TypeScript.

---

## 11. Build y distribución

### Cargo.toml del TUI

```toml
[package]
name    = "hivecode-tui"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "hivecode-tui"
path = "src/main.rs"

[dependencies]
ratatui              = "0.29"
crossterm            = { version = "0.28", features = ["event-stream"] }
tokio                = { version = "1", features = ["full"] }
tokio-stream         = "0.1"
serde                = { version = "1", features = ["derive"] }
serde_json           = "1"
color-eyre           = "0.6"
tui-markdown         = "0.3"
unicode-segmentation = "1"
unicode-width        = "0.1"

[profile.release]
opt-level     = 3
lto           = true
strip         = true
codegen-units = 1
# objetivo: binario < 8 MB en Linux x64
```

### Scripts raíz

```json
{
  "scripts": {
    "build":       "bun run build:tui && bun run build:bun",
    "build:tui":   "cd packages/tui && cargo build --release",
    "build:bun":   "bun build packages/cli/src/index.ts --outfile dist/hivecode.js --target bun",
    "dev":         "bun run packages/cli/src/index.ts",
    "dev:tui":     "cd packages/tui && cargo run",
    "test":        "bun test && cd packages/tui && cargo test",
    "lint":        "bun run typecheck && cd packages/tui && cargo clippy -- -D warnings",
    "typecheck":   "tsc --noEmit -p tsconfig.base.json"
  }
}
```

### TUI Launcher

```typescript
// packages/cli/src/tui-launcher.ts
export async function launchTui(socketPath: string): Promise<void> {
  const bin = resolveBinary()
  const proc = Bun.spawn([bin, '--screen', 'repl'], {
    env: { ...process.env, HIVECODE_IPC: socketPath },
    stdin: 'inherit', stdout: 'inherit', stderr: 'pipe',
  })
  await proc.exited
}

function resolveBinary(): string {
  const candidates = [
    join(__dirname, '../tui/target/release/hivecode-tui'),
    '/usr/local/bin/hivecode-tui',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('hivecode-tui not found. Run: cd packages/tui && cargo build --release')
}
```

---

## 12. Plan de implementación incremental

Cada paso produce algo funcional antes de continuar.

### Fase 0 — Fundamentos Rust (1 semana)

| Paso | Qué construir | Rust aprendido |
|------|--------------|----------------|
| 0.1 | Cargo.toml + hello world ratatui | Cargo, crates, `Result<T>` |
| 0.2 | Setup/teardown terminal + panic hook | RAII, closures |
| 0.3 | Módulos de estado vacíos compilando | `mod`, structs, `pub` |
| 0.4 | Demo mode sin backend (datos mock) | `Default`, constructores |

### Fase 1 — Input correcto (1 semana)

| Paso | Bug resuelto | Rust aprendido |
|------|-------------|----------------|
| 1.1 | `InputState` con cursor UTF-8 | `String`, `char_indices` |
| 1.2 | Widget input con scroll horizontal | `Paragraph::scroll` |
| 1.3 | Teclas básicas + Ctrl+←→ | `match`, `KeyCode` |
| 1.4 | Historial de inputs (↑↓) | `VecDeque` |

### Fase 2 — Layout base (1 semana)

| Paso | Bug resuelto | Rust aprendido |
|------|-------------|----------------|
| 2.1 | Header con SessionState | references, métodos |
| 2.2 | Mascota single render point | layout, `Constraint` |
| 2.3 | Historial con scroll + scrollbar | `Vec`, slices |
| 2.4 | `StateUpdate` actualiza header | ownership, `Option` |

### Fase 3 — IPC real (1 semana)

| Paso | Qué | Rust aprendido |
|------|-----|----------------|
| 3.1 | Unix socket connect | `tokio::net` |
| 3.2 | Deserializar `BunMessage::Init` | `serde`, tagged enums |
| 3.3 | `tokio::select!` 3 canales prioridad | `mpsc`, `biased` |
| 3.4 | Modal no bloqueante | enums con datos, `HashMap` |

### Fase 4 — Checkpoint & Rollback (2 semanas)

| Paso | Qué | Resultado |
|------|-----|-----------|
| 4.1 | `CheckpointState` + widget timeline | UI de checkpoints |
| 4.2 | `CheckpointManager` en Bun + SQLite | Backend del rollback |
| 4.3 | `RollbackRequest` TUI → Bun → archivos | Rollback funcional |
| 4.4 | HALT con snapshot automático | Safety net completo |

### Fase 5 — Agent Context visible (2 semanas)

| Paso | Qué | Resultado |
|------|-----|-----------|
| 5.1 | `Blackboard` API + tablas SQLite | Cerebro compartido |
| 5.2 | Workers usan `BaseWorker.safeWrite` | Coordinación real |
| 5.3 | `ConflictDetector` + `agent_conflicts` | Detección automática |
| 5.4 | `ConflictState` en TUI + widget | Visibilidad de conflictos |
| 5.5 | `ThoughtStreamState` + widget | Reasoning transparency |
| 5.6 | `FileMapState` + widget riesgo/ADR | File Risk Map |

### Fase 6 — Layouts adaptativos (2 semanas)

| Paso | Qué |
|------|-----|
| 6.1 | Layout::Plan completo |
| 6.2 | Layout::Code con diff view |
| 6.3 | Layout::Review con ADR viewer |
| 6.4 | Layout::Dashboard multi-worker |
| 6.5 | Layout::Focus historial |
| 6.6 | `DirtyFlags` render selectivo |

### Fase 7 — Pulido (1 semana)

- Comandos slash completos
- Tests unitarios: `InputState`, `CheckpointState`, `SessionState`, `Blackboard`
- Demo mode pulido
- `cargo clippy` limpio
- Binario < 8 MB en release

---

## 13. Criterios de aceptación

### TUI

- [ ] Input escribe sin lag en terminales 80×24 y 220×50
- [ ] Cursor siempre visible con emojis y caracteres multibyte
- [ ] Historial scrolleable con scrollbar lateral
- [ ] Header actualiza provider/model/mode sin restart
- [ ] Mascota aparece exactamente una vez
- [ ] Modal no bloquea el event loop
- [ ] Layout cambia automáticamente según la fase del agente

### Checkpoint & Rollback

- [ ] Checkpoint creado antes de cada tool call de escritura
- [ ] Timeline visible con los últimos 10 checkpoints en el TUI
- [ ] Rollback restaura archivos en < 3 segundos
- [ ] HALT crea snapshot antes de detener

### Agent Context (Blackboard)

- [ ] Bee tiene visibilidad del estado de todos los workers via `bee_awareness` view
- [ ] Conflictos file_collision detectados antes de que ocurran
- [ ] Conflictos visibles en el TUI con severidad y descripción
- [ ] Workers leen constraints del blackboard antes de tocar archivos críticos
- [ ] ADR violations detectadas y mostradas en TUI con referencia al ADR

### Protocolo IPC

- [ ] Mensajes critical procesados antes que normal y low
- [ ] Demo mode arranca sin errores sin `HIVECODE_IPC`
- [ ] TUI no crashea si Bun cierra el socket

### Build

- [ ] Binario Rust en release < 8 MB
- [ ] `cargo clippy -- -D warnings` sin advertencias
- [ ] `cargo test` pasa
- [ ] `bun test` pasa en core y code

---

## 14. Addendum — Canales de acceso al swarm

### 14.1 El problema actual

Los tres canales existentes (TUI, hive-ui, Telegram) tienen cada uno su propia conexión al core. Eso significa tres implementaciones del mismo protocolo, tres lugares donde arreglar un bug, y ninguna garantía de que los tres vean el mismo estado.

```
Estado actual (fragmentado):
  TUI        → Unix socket IPC  → core  (propio)
  hive-ui    → WebSocket        → ???   (sin conectar al swarm real)
  Telegram   → grammy polling   → ???   (handleMessage sin rutear al swarm)

Estado objetivo (unificado):
  TUI        ─┐
  hive-ui    ─┤→ ChannelGateway → core → swarm → SQLite
  Telegram   ─┘
```

### 14.2 ChannelGateway — la capa unificadora

Un único punto de entrada en `packages/core/channels/` que todos los canales usan. Los canales no hablan con el swarm directamente — hablan con el gateway.

```
packages/core/channels/
├── gateway.ts        # ChannelGateway — orquesta todos los canales
├── adapter.ts        # IChannelAdapter — interfaz que cada canal implementa
├── types.ts          # ChannelMessage, ChannelEvent — tipos compartidos
├── adapters/
│   ├── ipc.ts        # TUI — Unix socket NDJSON (ya existe, migrar aquí)
│   ├── websocket.ts  # hive-ui — WebSocket con Elysia
│   └── telegram.ts   # Telegram — grammy → gateway
└── broadcast.ts      # fan-out de eventos a todos los canales suscritos
```

**La interfaz del adaptador:**

```typescript
// packages/core/channels/adapter.ts

export interface IChannelAdapter {
  id:       string          // 'tui' | 'web' | 'telegram:<chat_id>'
  type:     ChannelType     // 'tui' | 'web' | 'telegram'

  // El canal envía un comando al swarm
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void

  // El gateway envía un evento al canal
  send(event: ChannelEvent): Promise<void>

  // Ciclo de vida
  connect():    Promise<void>
  disconnect(): Promise<void>
}

export type ChannelMessage =
  | { type: 'submit';    input: string;      session_id: string }
  | { type: 'approve';   session_id: string  }
  | { type: 'reject';    session_id: string  }
  | { type: 'halt';      session_id: string  }
  | { type: 'rollback';  checkpoint_id: string; session_id: string }
  | { type: 'mode';      mode: string;       session_id: string }

// ChannelEvent es un superset de BunMessage — el mismo protocolo
// que ya definimos en §8, compartido entre TUI, web y Telegram
export type ChannelEvent = BunMessage
```

**El gateway:**

```typescript
// packages/core/channels/gateway.ts

export class ChannelGateway {
  private adapters = new Map<string, IChannelAdapter>()

  register(adapter: IChannelAdapter): void {
    this.adapters.set(adapter.id, adapter)
    adapter.onMessage(msg => this.route(msg))
  }

  // Fan-out: un evento del swarm llega a todos los canales suscritos
  async broadcast(event: ChannelEvent, sessionId: string): Promise<void> {
    const promises = [...this.adapters.values()]
      .filter(a => a.subscribedTo(sessionId))
      .map(a => a.send(event).catch(err =>
        console.warn(`Canal ${a.id} falló:`, err)
      ))
    await Promise.allSettled(promises)
  }

  // Rutear un ChannelMessage al swarm
  private async route(msg: ChannelMessage): Promise<void> {
    // CoordinatorManager procesa el mensaje independientemente del canal
    await coordinatorManager.handle(msg)
  }
}
```

### 14.3 hive-ui (React + Vite)

**Estado actual:** UI completa con Chat, Dashboard, LogPanel, PhaseTimeline, FlowCanvas, DiffViewer, ThinkingPanel, Mascot. WebSocket client en `lib/ws.ts`. Sin conexión real al swarm.

**Lo que falta:** conectar el WebSocket server de Elysia al ChannelGateway.

#### Adaptador WebSocket

```typescript
// packages/core/channels/adapters/websocket.ts

export class WebSocketAdapter implements IChannelAdapter {
  id   = 'web'
  type = 'web' as const

  constructor(private server: ElysiaWS) {}

  send(event: ChannelEvent): Promise<void> {
    this.server.send(JSON.stringify(event))
    return Promise.resolve()
  }

  onMessage(handler: MessageHandler): void {
    this.server.on('message', (ws, raw) => {
      const msg = JSON.parse(raw.toString()) as ChannelMessage
      handler(msg)
    })
  }
}
```

#### Qué conectar en hive-ui

Cada componente existente ya tiene su contraparte en el protocolo de eventos:

| Componente React | Evento del gateway | Datos de SQLite |
|-----------------|-------------------|-----------------|
| `ThinkingPanel.tsx` | `ReasoningChunk` | `agent_context` tipo `reasoning` |
| `PhaseTimeline.tsx` | `ActivityUpdate` | `worker_activity` |
| `LogPanel.tsx` | `LogEntry` | `messages` |
| `DiffViewer.tsx` | `CheckpointCreated` | `checkpoint_files` |
| `FlowCanvas.tsx` | `WorkersSnapshot` + `ContextUpdate` | `agent_awareness` + `agent_conflicts` |
| `Chat.tsx` | `HistoryAppend` + `NarrativeChunk` | `messages` |
| `Dashboard.tsx` | `Status` + `StateUpdate` | `sessions` + `worker_activity` |

#### FlowCanvas — el caso especial

`FlowCanvas.tsx` con React Flow es el componente con más potencial sin explotar. Hoy probablemente muestra un flujo estático. Con los datos del blackboard puede mostrar el **grafo de coordinación vivo**:

```typescript
// Nodos del grafo — uno por agente activo
const nodes: Node[] = workers.map(w => ({
  id:   w.name,
  type: w.status === 'running' ? 'workerActive' : 'workerIdle',
  data: {
    label:         w.name,
    currentAction: w.last_known_action,
    hasConflict:   w.has_conflict,
    phase:         w.phase,
  }
}))

// Edges — conexiones del blackboard
// Una arista aparece cuando un worker leyó una decisión de otro
const edges: Edge[] = contextUpdates
  .filter(c => c.type === 'decision' && c.resolved_by)
  .map(c => ({
    id:     `${c.agent}-${c.resolved_by}`,
    source: c.agent,
    target: c.resolved_by!,
    label:  'influenció',
    style:  { stroke: c.status === 'active' ? '#f59e0b' : '#6b7280' }
  }))

// Aristas de conflicto — rojas
const conflictEdges: Edge[] = conflicts.map(c => ({
  id:     `conflict-${c.id}`,
  source: c.agent_a,
  target: c.agent_b,
  type:   'conflict',
  style:  { stroke: '#ef4444', strokeDasharray: '5,5' }
}))
```

Esto convierte FlowCanvas en una visualización en vivo del grafo de agentes — quién está hablando con quién, qué conflictos hay, cómo fluye el contexto.

### 14.4 Telegram

**Estado actual:** grammy con long polling, 15+ comandos, inline keyboards, approval flow con timeout 30min, `handleMessage()` para texto libre. Sin conectar al swarm real.

**Lo que falta:** enrutar `handleMessage()` a través del ChannelGateway, y aprovechar el markdown nativo de Telegram.

#### Adaptador Telegram

```typescript
// packages/core/channels/adapters/telegram.ts

export class TelegramAdapter implements IChannelAdapter {
  id:   string        // 'telegram:<chat_id>'
  type = 'telegram' as const

  constructor(private bot: Bot, private chatId: number) {
    this.id = `telegram:${chatId}`
  }

  async send(event: ChannelEvent): Promise<void> {
    const msg = this.formatEvent(event)
    if (!msg) return
    await this.bot.api.sendMessage(this.chatId, msg.text, {
      parse_mode:  'MarkdownV2',
      reply_markup: msg.keyboard,
    })
  }

  // Traducir ChannelEvents al formato Telegram
  private formatEvent(event: ChannelEvent): TelegramMessage | null {
    switch (event.type) {
      case 'narrative_chunk':
        return { text: this.escapeMarkdown(event.content) }

      case 'activity_update':
        const emoji = { running: '🔵', done: '✅', failed: '❌', waiting: '⚪' }
        return {
          text: `${emoji[event.status]} *${event.coordinator}*\n${event.phase}`
        }

      case 'checkpoint_created':
        return {
          text: `📸 Checkpoint creado: \`${event.id}\`\n_${event.description}_\n${event.files.length} archivos`
        }

      case 'conflict_detected':
        return {
          text: `⚠️ *Conflicto detectado*\n${event.agent_a} ↔ ${event.agent_b}\n${event.description}`,
          keyboard: new InlineKeyboard()
            .text('Resolver', `resolve:${event.description}`)
        }

      // Approval request — el caso estrella de Telegram
      // El inline keyboard ya existente se conecta aquí
      case 'show_info_modal':
        return {
          text: `📋 *${this.escapeMarkdown(event.title)}*\n\n${this.escapeMarkdown(event.content)}`,
          keyboard: new InlineKeyboard()
            .text('✅ Aprobar', 'approve')
            .text('❌ Rechazar', 'reject')
        }

      default:
        return null
    }
  }
}
```

#### Conectar handleMessage() al gateway

```typescript
// En el bot de grammy — el cambio es mínimo

// Antes (sin conectar):
async function handleMessage(ctx: Context): Promise<void> {
  // procesamiento local sin rutear al swarm
}

// Después (conectado al gateway):
async function handleMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Registrar el adaptador si no existe para este chat
  if (!gateway.hasAdapter(`telegram:${chatId}`)) {
    gateway.register(new TelegramAdapter(bot, chatId))
  }

  // Enviar al swarm via gateway — mismo flujo que TUI y web
  await gateway.route({
    type:       'submit',
    input:      ctx.message?.text ?? '',
    session_id: currentSession.id,
  })
}
```

#### Por qué Telegram es valioso para hiveCode

El markdown de Telegram renderiza perfectamente los outputs del swarm:

```
Los planes en markdown → listas numeradas nativas de Telegram
Los ADRs → blockquotes + código formateado
Los diffs → bloques de código con syntax
Los status updates → emojis + negrita

Inline keyboards existentes:
  [✅ Aprobar plan]  [❌ Rechazar]
  [⏸ Pausar]        [🔄 Cambiar modo]
```

El approval flow con timeout de 30min que ya tienes es exactamente lo que `Layout::Review` hace en el TUI — la misma lógica, canal diferente. Con el gateway ambos llaman al mismo `coordinatorManager.handle({ type: 'approve' })`.

#### Webhook vs long polling

Para producción cambiar a webhook es trivial con grammy:

```typescript
// Long polling (desarrollo — ya funciona)
bot.start()

// Webhook (producción — un cambio)
Bun.serve({
  fetch: webhookCallback(bot, 'bun'),
  port:  3001,
})
```

No hay que cambiar nada más — grammy abstrae la diferencia.

### 14.5 Diferenciación de canales — qué hace cada uno mejor

| Capacidad | TUI (Rust) | hive-ui (React) | Telegram |
|-----------|-----------|-----------------|----------|
| Streaming en tiempo real | ✅ óptimo | ✅ WebSocket | ⚠️ polling/webhook |
| Visualización de grafo de agentes | ❌ | ✅ React Flow | ❌ |
| Diff de código | ✅ diff_view widget | ✅ DiffViewer.tsx | ⚠️ bloque de código |
| Approval con timeout | ✅ Layout::Review | ✅ modal | ✅ inline keyboard (ya existe) |
| Acceso móvil | ❌ | ✅ responsive | ✅ nativo |
| Rollback | ✅ checkpoint_bar | ✅ UI botón | ⚠️ comando /rollback |
| Notificaciones proactivas | ❌ | ❌ | ✅ sendNotification (ya existe) |
| Razonamiento visible | ✅ ThoughtStream | ✅ ThinkingPanel | ⚠️ texto plano |
| Markdown ADRs | ✅ tui-markdown | ✅ nativo React | ✅ MarkdownV2 |

**Regla de uso:**
- TUI → dev trabajando activamente en la terminal
- hive-ui → monitoreo, visualización de flujo, revisión de diffs en pantalla grande
- Telegram → aprobaciones en movimiento, notificaciones, control remoto

### 14.6 Estructura de paquetes actualizada

```
packages/
├── core/
│   └── src/
│       └── channels/             # NUEVO
│           ├── gateway.ts
│           ├── adapter.ts
│           ├── broadcast.ts
│           ├── types.ts
│           └── adapters/
│               ├── ipc.ts        # TUI (migrado desde core/ipc/)
│               ├── websocket.ts  # hive-ui
│               └── telegram.ts   # Telegram bot
│
├── tui/                          # Rust — sin cambios de arquitectura
│
├── ui/                           # hive-ui (React + Vite)
│   └── src/
│       ├── lib/
│       │   └── ws.ts             # CONECTAR al WebSocketAdapter
│       └── components/           # ya existen, solo necesitan datos reales
│           ├── FlowCanvas.tsx    # conectar a WorkersSnapshot + ContextUpdate
│           ├── DiffViewer.tsx    # conectar a CheckpointCreated
│           ├── ThinkingPanel.tsx # conectar a ReasoningChunk
│           └── ...
│
└── telegram/                     # bot grammy
    └── src/
        ├── bot.ts                # CONECTAR handleMessage al gateway
        ├── commands/             # ya existen — conectar al gateway
        └── adapters/
            └── telegram.ts      # mover aquí desde core/channels/adapters/

```

### 14.7 Criterios de aceptación — Canales

**ChannelGateway:**
- [ ] Un mensaje enviado desde cualquier canal llega al mismo `CoordinatorManager`
- [ ] Un evento del swarm llega simultáneamente a todos los canales suscritos
- [ ] Si un canal falla al recibir, los demás no se ven afectados (`Promise.allSettled`)

**hive-ui:**
- [ ] `ThinkingPanel` muestra `ReasoningChunk` en tiempo real
- [ ] `PhaseTimeline` refleja `ActivityUpdate` de todos los workers
- [ ] `DiffViewer` muestra el diff real del checkpoint activo
- [ ] `FlowCanvas` visualiza el grafo de agentes con nodos y aristas vivos
- [ ] Chat envía mensajes al swarm y recibe respuestas reales

**Telegram:**
- [ ] Texto libre enrutado al swarm via `handleMessage → gateway`
- [ ] Approval request genera inline keyboard con timeout de 30 min
- [ ] `/rollback` ejecuta `gateway.route({ type: 'rollback', checkpoint_id })`
- [ ] `sendNotification` se dispara en `CheckpointCreated` y `ConflictDetected`
- [ ] Markdown de planes y ADRs renderiza correctamente en Telegram