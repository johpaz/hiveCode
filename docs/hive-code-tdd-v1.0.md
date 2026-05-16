# Hive-Code — Technical Design Document (TDD)
**Versión:** 1.0.0 | **Fecha:** Mayo 2026 | **Autor:** @johpaz
**Estado:** DOCUMENTO VIVO — fuente de verdad del sistema

---

## ÍNDICE

1. Visión y Principios
2. Mapa del Sistema
3. Stack Tecnológico y APIs de Bun
4. Bee — El Coordinador Central
5. Agent Loop
6. Context Compiler y ACE
7. Schema de Base de Datos
8. Tools Nativas
9. Evaluación de Subagentes
10. Recovery ante Fallos
11. Grafo de Dependencias del Codebase
12. Memoria Semántica del Desarrollador
13. Gestión de Tokens y Costos
14. Seguridad y Sandbox
15. Live Feed con 🐝
16. TUI — Ratatui (Rust)
17. UI — Vite + Dashboard
18. CLI — Comandos y Comandos Internos
19. Distribución y Empaquetado
20. Bun.Image — Diferencial de Hive-Code
21. Observabilidad del Sistema
22. Onboarding de Proyecto Nuevo
23. ADRs — Decisiones de Arquitectura
24. Riesgos y Mitigaciones
25. Roadmap de Implementación

---

## 1. VISIÓN Y PRINCIPIOS

Hive-Code es un agente de ingeniería de software autónomo que vive en la terminal del desarrollador. No es un wrapper de otro sistema — es un loop de agentes propio, con memoria real entre sesiones, contexto comprimido, y una mascota con personalidad.

### Principios que no se negocian

**Local-first.** Un binario, funciona sin internet excepto las llamadas LLM. Sin Docker obligatorio, sin Postgres, sin Redis como requisito. El desarrollador en un VPS básico tiene la misma experiencia que en una MacBook Pro.

**Bee es el único coordinador.** No hay seis coordinadores permanentes — hay un coordinador central llamado Bee que delega a subagentes dinámicos según la tarea. Los subagentes nacen para una tarea y mueren al terminar.

**El narrativo es la memoria.** No hay embeddings ni RAG complejo. El narrativo en SQLite con FTS5 es la memoria del proyecto entre sesiones. Bee lee el narrativo antes de cada tarea para saber dónde está parado.

**Contexto comprimido.** El Context Compiler reduce el contexto antes de cada llamada LLM usando formato toon — representación comprimida de código que preserva la semántica sin verbosidad. Esto reduce costos y aumenta velocidad.

**Identidad propia.** La mascota 🐝 no es decoración — es la interfaz emocional del sistema. Cada acción de Bee se comunica a través del emoji con efectos contextuales.

**Editar, no reescribir.** Bee nunca reescribe un archivo completo. Usa str_replace quirúrgico — `old_string` único → `new_string`. Un archivo de 3000 líneas se toca en 20 líneas si eso es lo que necesita.

**Recovery siempre disponible.** Cada tarea crea una rama git y snapshots en SQLite. El usuario puede revertir cualquier tarea en cualquier momento.

---

## 2. MAPA DEL SISTEMA

```
┌─────────────────────────────────────────────────────────────────┐
│                     PROCESO PRINCIPAL (Bun)                      │
│                                                                   │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐    │
│  │  Bun.serve  │    │     Bee      │    │ Context Compiler │    │
│  │  HTTP + WS  │◄──►│ Coordinador  │◄──►│   + ACE + FTS5   │    │
│  │  (gateway)  │    │   Central    │    │                  │    │
│  └──────┬──────┘    └──────┬───────┘    └──────────────────┘    │
│         │                  │                                      │
│         │            ┌─────▼──────┐                              │
│         │            │ Agent Loop │                              │
│         │            │  propio    │                              │
│         │            └─────┬──────┘                             │
│         │                  │ spawn dinámico                      │
│         │         ┌────────┴────────┐                           │
│         │    Worker #1         Worker #N                        │
│         │    [subagente]       [subagente]                      │
│         │    thread real       thread real                      │
│         │                                                        │
│  SQLite WAL ◄──────────────────────────────── todos los módulos │
│  SharedArrayBuffer ◄───────────────────────── estado de sesión  │
└──────────┬──────────────────────────────────────────────────────┘
           │ WebSocket
    ┌──────┴──────────────────┐
    │                         │
┌───▼────┐            ┌───────▼──────┐
│Ratatui │            │  Vite UI     │
│  TUI   │            │  Dashboard   │
│ (Rust) │            │  Flow agents │
│        │            │  Chat        │
└────────┘            └──────────────┘
```

### Flujo de una tarea

```
Usuario escribe tarea
    ↓
Context Compiler comprime contexto + narrativo + playbook
    ↓
Bee analiza con el agent loop propio
    ↓
Si tarea vaga → reconocimiento automático del codebase
    ↓
Bee genera arnés del plan (modo PLAN/APPROVAL/AUTO)
    ↓
Bee spawn subagentes dinámicos según necesidad
    ↓
Cada subagente ejecuta en su Worker (hilo real de Bun)
    ↓
Bee evalúa resultado de cada subagente
    ↓
Narrativo actualizado → checkpoint en SQLite
    ↓
Live feed 🐝 en tiempo real via WebSocket a ambas UIs
    ↓
PR creado o resultado reportado al usuario
```

---

## 3. STACK TECNOLÓGICO Y APIs DE BUN

### Runtime y lenguaje

**Bun ≥ 1.3.14** como runtime principal. TypeScript strict en todo el código. Sin transpilación — Bun ejecuta TypeScript nativo.

### APIs de Bun utilizadas por módulo

**Concurrencia real**
`new Worker(url)` — un hilo real por subagente. No simulado. Paralelismo a nivel de CPU. Cada subagente tiene su propio event loop, su propia memoria de heap, su propio contexto JavaScript. La comunicación es exclusivamente por `postMessage`.

`SharedArrayBuffer` + `Atomics` — estado de sesión compartido entre todos los Workers sin serialización. Campos: modo actual, Workers ocupados, flags de control. Solo el main thread escribe con `Atomics.store`. Todos los Workers leen con `Atomics.load`. Latencia de nanosegundos.

`postMessage` fast-path — para strings grandes (contexto compilado 10-50KB), Bun evita serialización. ~500ns independiente del tamaño. 500x más rápido que Node para este caso.

`BroadcastChannel` — eventos de control one-to-many. El toggle Shift+Tab emite `MODE_CHANGED` a todos los Workers simultáneamente sin router central.

`setEnvironmentData` / `getEnvironmentData` — config estática sin serialización. API keys (leídas de Bun.secrets al arrancar), model names, config de providers. Inmutable durante la sesión.

**Storage**
`bun:sqlite` con WAL mode — fuente de verdad. Pragmas obligatorios: `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000` (64MB), `mmap_size=268435456` (256MB), `temp_store=MEMORY`. Permite lecturas concurrentes mientras el main thread escribe.

`Bun.secrets` — OS keystore (Keychain/libsecret/Windows Credential Manager). Toda API key vive aquí. Nunca en disco, nunca en logs, nunca en el narrativo.

**Ejecución de procesos**
`Bun.spawn` con sandbox — para ejecutar código generado. Parámetros obligatorios: `cwd` aislado, `timeout: 30_000`, `stdout: "pipe"`, `stderr: "pipe"`, `env` mínimo sin secrets del host.

`Bun.$` (Bun Shell) — para comandos git. Template literals — cada `${}` es argumento separado, sin riesgo de injection.

**Servidor y tiempo real**
`Bun.serve()` con WebSocket nativo — gateway HTTP + WebSocket. Pub/sub nativo para streaming a ambas UIs. Sin Socket.io. Canales: `task:{id}:feed`, `session:{id}:mode`, `agent:{id}:thinking`.

**Scheduling**
`Bun.cron()` en-proceso — ACE Reflector cada 20 trazas o por schedule. Comparte pool SQLite sin IPC. `using job = Bun.cron(...)` para cleanup automático.

**Imágenes — diferencial**
`Bun.Image` — pipeline nativo sin dependencias. Decode, transform, encode de JPEG/PNG/WebP/HEIC/AVIF. Construido sobre libjpeg-turbo, spng, libwebp, SIMD. Todo off the JavaScript thread. Ver sección 20 para casos de uso específicos en Hive-Code.

**Utilidades**
`Bun.Glob` — búsqueda de archivos. 2x más rápido desde v1.3.12.
`Bun.Transpiler` — análisis AST liviano sin tsc.
`Bun.markdown` — renderizar skills y docs.
`Bun.randomUUIDv7()` — IDs monotónicamente crecientes, perfectos para ordering en SQLite.
`Bun.nanoseconds()` — medir latencia de tool calls para trazas del ACE.
`Bun.CryptoHasher` — hashes de contenido para snapshots e integridad.
`Bun.CSRF` — protección en endpoints de la API.
`Bun.WebView` — browser headless para tests E2E de UI generada.
`HTMLRewriter` — scraping selectivo de documentación web.

---

## 4. BEE — EL COORDINADOR CENTRAL

Bee es el único coordinador permanente. No hay seis coordinadores fijos — Bee analiza cada tarea y decide dinámicamente qué subagentes necesita, los crea, los evalúa, y los destruye.

### Responsabilidades de Bee

Leer el narrativo del proyecto antes de cada tarea. Reconocer el codebase automáticamente ante instrucciones vagas. Generar el arnés del plan con decisiones explícitas y trade-offs. Crear subagentes dinámicos según la tarea. Evaluar el output de cada subagente. Escribir al narrativo el progreso y resultado. Gestionar el modo de operación (Plan/Approval/Auto). Reportar el live feed via WebSocket. Crear PR al finalizar si aplica.

### System prompt semilla de Bee

```
Eres Bee, el coordinador central de Hive-Code.
Eres un ingeniero de software senior con criterio propio.

ANTES DE CADA TAREA:
1. Lee el narrativo completo con read_narrative()
2. Lee el árbol de archivos con list_dir()
3. Busca TODOs/FIXMEs con search_in_files()
4. Lee git log --oneline -20 para contexto reciente
5. Si la instrucción es vaga: genera hipótesis concretas
   del codebase, nunca preguntas abiertas

REGLA DE ORO DE EDICIÓN:
Nunca reescribas un archivo completo.
Siempre usa str_replace con old_string único en el archivo.
Verifica con grep antes de editar que old_string es único.
Si old_string aparece 0 o más de 1 vez → busca más contexto.

REGLA DE LECTURA:
Para archivos grandes: primero parse_ast para el mapa,
luego grep para localizar, luego read_file del rango exacto.
Nunca leas más de lo necesario.

SUBAGENTES:
Crea subagentes dinámicos cuando la tarea lo requiera.
Declara su propósito exacto, sus tools disponibles,
y si corre en paralelo o secuencial.
Evalúa su output antes de reportar al usuario.

NARRATIVO:
Escribe una entrada al narrativo después de cada acción
significativa. No qué hiciste — por qué lo hiciste así
y qué encontraste inesperado.

NUNCA:
- Reescribas archivos completos
- Hardcodees secrets
- Hagas push a main/master directamente
- Silencies errores
- Contradigas [USER OVERRIDE] sin justificación explícita
```

### La tool `spawn_agent` — creación dinámica

Bee tiene una tool específica para crear subagentes cuando ninguno existente es adecuado:

```typescript
interface SpawnAgentInput {
  purpose: string          // qué debe hacer este agente
  systemPrompt: string     // identidad y reglas del agente
  tools: string[]          // subset de tools disponibles
  context: string          // contexto comprimido para este agente
  parallel: boolean        // corre en paralelo con otros o espera
  timeout?: number         // ms máximo, default 120_000
  activeForm: string       // "Analizando dependencias de auth..."
}

interface SpawnAgentOutput {
  agentId: string
  status: 'completed' | 'failed' | 'timeout'
  result: string           // output del agente
  filesModified: string[]
  toolCalls: ToolTrace[]
  tokensUsed: number
  durationMs: number
}
```

El agente creado corre en su propio Bun Worker. Cuando termina, el Worker se destruye. Bee evalúa el output antes de continuar.

### Reconocimiento automático ante instrucción vaga

Cuando la instrucción del usuario no tiene suficiente información, Bee sigue este proceso sin preguntar al usuario:

```
1. list_dir()           → estructura del proyecto
2. read_file("package.json") → stack, dependencias, scripts
3. git log --oneline -20 → historial reciente
4. git diff HEAD~3       → cambios recientes
5. search_in_files("TODO|FIXME|HACK") → problemas marcados
6. read_narrative()      → decisiones y pendientes previos
7. parse_ast(archivos relevantes) → mapa estructural

→ Genera hipótesis concretas (máximo 4)
→ Si hay 1 clara: procede directamente
→ Si hay varias: presenta selección al usuario
→ Una sola pregunta de selección, nunca abierta
```

### El arnés del plan

Antes de ejecutar cualquier tarea, Bee genera un arnés estructurado:

```
ARNÉS — task-{uuid}  [PLAN/APPROVAL/AUTO]

RECONOCIMIENTO
  Stack:        Bun · TypeScript · Hive-Code
  Archivos relevantes: src/auth/, middleware.ts
  Pendientes en narrativo: refresh tokens (2026-04-12)
  TODOs: OAuth GitHub (middleware.ts:47)
  Cobertura actual: 42% en src/auth/

HIPÓTESIS INTERPRETADA
  "mejora el auth" → implementar refresh tokens (pendiente)
  + actualizar bcrypt → argon2 (CVE-2025-3182)

DECISIONES
  [1] Refresh tokens con rotación obligatoria
      jose en vez de jsonwebtoken (ESM nativo Bun)
      httpOnly cookie (decisión previa en narrativo)
  [2] Migración bcrypt → argon2
      Sin breaking change para usuarios existentes

CONTRATOS
  interface RefreshTokenPayload { userId, tokenId, exp }
  interface RotatedToken { accessToken, refreshToken }

SUBAGENTES A CREAR
  agent-auth-impl    → implementación del endpoint
  agent-db-migration → migración SQL
  agent-test-writer  → tests de cobertura
  (paralelos entre sí)

ARCHIVOS ESTIMADOS
  + src/auth/refresh.ts     (endpoint /auth/refresh)
  + src/auth/argon2.ts      (wrapper hash/verify)
  ~ src/auth/jwt.ts         (agregar RefreshTokenPayload)
  ~ src/middleware.ts       (authmiddleware → rotación)
  + migrations/0003.sql     (tabla refresh_tokens)

RIESGOS
  HIGH: bcrypt activo hasta que migración complete
  LOW:  re-login requerido para usuarios existentes

ESTIMADO: ~2,400 tokens · ~4 min
```

---

## 5. AGENT LOOP

El agent loop propio de Hive-Code no delega a frameworks externos. Es el ciclo fundamental de razonamiento de Bee.

### El ciclo

```
ENTRADA: tarea del usuario + contexto compilado

CICLO:
  1. LLM genera respuesta (con thinking activado)
  2. Parsear bloques:
     - thinking blocks → canal de thinking (SQLite + WS)
     - text blocks → narración al usuario
     - tool_use blocks → ejecutar tool
  3. Si tool_use:
     a. Emitir evento al live feed (🐝 en acción)
     b. Ejecutar tool con sandbox
     c. Capturar resultado con async stack trace
     d. Agregar tool_result al historial
     e. Volver al paso 1
  4. Si texto final sin tool_use → tarea completada
  5. Escribir traza al ACE
  6. Actualizar narrativo

SALIDA: resultado + archivos modificados + narrativo actualizado
```

### Manejo del thinking

El thinking es una fase del mismo modelo, no un agente separado. El stream de la API retorna bloques `thinking` antes de los bloques `text`. Hive-Code los bifurca:

- Bloques `thinking` → guardados en SQLite con tipo `thinking`, emitidos por WebSocket al canal `agent:{id}:thinking`. La Vite UI los muestra en el panel de flow. La TUI los muestra colapsados.
- Bloques `text` → narración visible al usuario en ambas UIs.
- Bloques `tool_use` → ejecutan la tool y generan el evento de live feed.

El thinking se guarda en el historial de la tarea para que el ACE pueda aprender del razonamiento, no solo de las decisiones.

### Historial LLM por tarea

El historial que se pasa al LLM en cada llamada no es el historial completo de la sesión. El Context Compiler ensambla:

```
[bloque ético inmutable]
[identidad de Bee]
[contexto del proyecto comprimido]
[narrativo relevante por FTS5 — últimas N entradas]
[reglas del playbook relevantes por FTS5]
[skills activadas por FTS5]
[historial de esta tarea específica]
[USER OVERRIDES activos]
```

Nunca se pasa el historial completo de la sesión. Solo lo relevante para la tarea actual.

---

## 6. CONTEXT COMPILER Y ACE

### Context Compiler

Compila el contexto antes de cada llamada LLM. Corre en el main thread. Tiene cache L1 en memoria (Map) invalidado por `MAX(rowid)` de SQLite.

**Formato toon** — representación comprimida de código que preserva semántica sin verbosidad. En lugar de pasar 200 líneas de código, pasa una representación estructurada:

```
[FILE: src/auth/jwt.ts]
IMPORTS: jose(SignJWT, jwtVerify), config(JWT_SECRET)
EXPORTS: sign(payload→Promise<string>), verify(token→Promise<Payload>)
FUNCTIONS:
  sign(payload: TokenPayload): genera JWT con exp 15min
  verify(token: string): valida y retorna payload tipado
TYPES: TokenPayload{userId, email, role}
DEPS: [middleware.ts usa verify], [routes/auth.ts usa sign]
```

Esto es lo que el LLM recibe en lugar del archivo completo. Reduce tokens 5-10x sin perder información estructural relevante.

**Cache de contexto**

```typescript
// Map en memoria — latencia de nanosegundos
const cache = new Map<string, { compiled: string; ts: number }>();

// Key incluye el MAX(rowid) de traces — invalida automáticamente
// cuando hay nuevas trazas (nueva información en el sistema)
const key = `${taskId}:${agentId}:${db.query("SELECT MAX(rowid) FROM traces").get()}`;
```

### ACE — Adaptive Codex Engine

**Reflector** — analiza trazas y extrae reglas útiles. Corre por `Bun.cron` cada 20 trazas nuevas o cada 20 minutos. Accede al pool SQLite directamente sin IPC.

**Curator** — gestiona el playbook. Activa/desactiva reglas según su `confidence` score. Una regla con muchos `harmful_count` se desactiva automáticamente.

**Lo que aprende el ACE:**

Patrones técnicos — "cuando el proyecto usa jose, no sugerir jsonwebtoken".

Preferencias del desarrollador — extraídas de USER OVERRIDEs, rollbacks, y correcciones. "Este desarrollador prefiere funciones pequeñas sobre clases. Evita OOP salvo cuando ya existe en el codebase."

Patrones de fallo — "el str_replace falla cuando old_string incluye comentarios con caracteres especiales — incluir más contexto".

Estimaciones de costo — "tareas de refactor en este codebase promedian 2,100 tokens con claude-sonnet-4-6".

---

## 7. SCHEMA DE BASE DE DATOS

### Pragmas obligatorios al conectar

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
```

### Sesión

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,  -- UUIDv7
  project_path  TEXT NOT NULL,
  project_stack TEXT,              -- JSON: {runtime, language, framework}
  file_tree     TEXT,              -- JSON comprimido del árbol de archivos
  active_provider TEXT DEFAULT 'anthropic',
  active_model    TEXT DEFAULT 'claude-sonnet-4-6',
  active_mode     TEXT DEFAULT 'plan'
    CHECK(active_mode IN ('plan','approval','auto')),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_mode_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  old_mode    TEXT NOT NULL,
  new_mode    TEXT NOT NULL,
  changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  phase_at_change TEXT
);
```

### Conversación

```sql
-- La conversación es el hilo visible al usuario
-- Una sesión puede tener múltiples conversaciones
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,  -- UUIDv7
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  title       TEXT,              -- generado por Bee al inicio
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Mensajes de la conversación — no todos son texto del usuario
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,  -- UUIDv7
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  task_id         TEXT REFERENCES tasks(id),  -- NULL si no es tarea
  type            TEXT NOT NULL CHECK(type IN (
    'user',        -- texto del usuario
    'bee',         -- respuesta de Bee
    'thinking',    -- bloque de thinking del LLM
    'tool_event',  -- Bee ejecutó una tool
    'system',      -- cambio de modo, rollback, error
    'subagent'     -- mensaje de un subagente
  )),
  role            TEXT CHECK(role IN ('user','assistant','tool')),
  content         TEXT NOT NULL,
  tool_name       TEXT,          -- si type = tool_event
  tool_input      TEXT,          -- JSON
  tool_output     TEXT,          -- resultado
  agent_id        TEXT,          -- si type = subagent
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  duration_ms     INTEGER,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tarea

```sql
-- Una tarea es una unidad de trabajo con objetivo definido
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,  -- UUIDv7
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  description     TEXT NOT NULL,    -- instrucción original del usuario
  harness         TEXT,             -- JSON del arnés del plan
  status          TEXT DEFAULT 'pending' CHECK(status IN (
    'pending','planning','running','paused',
    'completed','failed','cancelled'
  )),
  mode            TEXT CHECK(mode IN ('plan','approval','auto')),
  branch_name     TEXT,             -- rama git creada para esta tarea
  pr_url          TEXT,
  tokens_total    INTEGER DEFAULT 0,
  cost_usd        REAL DEFAULT 0,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME
);

-- Fases dentro de una tarea — estructura DAG
CREATE TABLE IF NOT EXISTS task_phases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  phase_name      TEXT NOT NULL,
  agent_id        TEXT,             -- ID del subagente asignado
  status          TEXT DEFAULT 'pending' CHECK(status IN (
    'pending','running','completed','failed','skipped'
  )),
  depends_on      TEXT DEFAULT '[]', -- JSON array de phase IDs
  active_form     TEXT,              -- "Escribiendo endpoint /auth/refresh"
  result_summary  TEXT,
  files_modified  TEXT DEFAULT '[]', -- JSON array
  approved_at     DATETIME,
  started_at      DATETIME,
  completed_at    DATETIME
);
```

### Subagentes

```sql
-- Registro de cada subagente creado dinámicamente
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,  -- UUIDv7
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  phase_id        INTEGER REFERENCES task_phases(id),
  parent_agent_id TEXT,              -- NULL si fue creado por Bee directamente
  purpose         TEXT NOT NULL,     -- qué debe hacer
  system_prompt   TEXT NOT NULL,     -- identidad del agente
  tools_available TEXT NOT NULL,     -- JSON array
  status          TEXT DEFAULT 'running' CHECK(status IN (
    'running','completed','failed','timeout'
  )),
  result          TEXT,              -- output final
  files_modified  TEXT DEFAULT '[]',
  tokens_in       INTEGER DEFAULT 0,
  tokens_out      INTEGER DEFAULT 0,
  duration_ms     INTEGER,
  -- Evaluación del output
  eval_structural INTEGER,           -- 1=passed, 0=failed, NULL=pending
  eval_semantic   INTEGER,           -- 1=passed, 0=failed, NULL=pending
  eval_notes      TEXT,              -- por qué pasó o falló
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME
);

-- Mandato completo enviado al subagente (para reproducibilidad)
CREATE TABLE IF NOT EXISTS agent_mandates (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id),
  full_context    TEXT NOT NULL,     -- contexto compilado que recibió
  llm_history     TEXT NOT NULL,     -- historial LLM completo de este agente
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Narrativo

```sql
CREATE TABLE IF NOT EXISTS narrative (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT REFERENCES tasks(id),
  session_id  TEXT REFERENCES sessions(id),
  agent_id    TEXT,                  -- quién escribió esta entrada
  entry       TEXT NOT NULL,
  is_draft    INTEGER DEFAULT 0,     -- 1 = modo PLAN, no ejecutado
  is_override INTEGER DEFAULT 0,     -- 1 = USER OVERRIDE
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS narrative_fts
  USING fts5(
    entry,
    agent_id,
    tokenize     = 'porter unicode61',
    content      = 'narrative',
    content_rowid = 'id'
  );

CREATE TRIGGER IF NOT EXISTS narrative_fts_insert
  AFTER INSERT ON narrative BEGIN
    INSERT INTO narrative_fts(rowid, entry, agent_id)
    VALUES (new.id, new.entry, COALESCE(new.agent_id,''));
  END;

CREATE TRIGGER IF NOT EXISTS narrative_fts_update
  AFTER UPDATE ON narrative BEGIN
    INSERT INTO narrative_fts(narrative_fts, rowid, entry, agent_id)
    VALUES ('delete', old.id, old.entry, COALESCE(old.agent_id,''));
    INSERT INTO narrative_fts(rowid, entry, agent_id)
    VALUES (new.id, new.entry, COALESCE(new.agent_id,''));
  END;

CREATE TRIGGER IF NOT EXISTS narrative_fts_delete
  AFTER DELETE ON narrative BEGIN
    INSERT INTO narrative_fts(narrative_fts, rowid, entry, agent_id)
    VALUES ('delete', old.id, old.entry, COALESCE(old.agent_id,''));
  END;
```

### Decisiones ADR

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,  -- UUIDv7
  task_id      TEXT REFERENCES tasks(id),
  title        TEXT NOT NULL,
  context      TEXT NOT NULL,
  options      TEXT NOT NULL,     -- JSON array de opciones evaluadas
  decision     TEXT NOT NULL,
  consequences TEXT NOT NULL,
  status       TEXT DEFAULT 'active'
    CHECK(status IN ('active','superseded','deprecated')),
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Snapshots para rollback

```sql
CREATE TABLE IF NOT EXISTS file_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  file_path   TEXT NOT NULL,
  content     TEXT NOT NULL,
  hash        TEXT NOT NULL,      -- CryptoHasher para integridad
  snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_snapshots_task ON file_snapshots(task_id);
```

### Grafo de dependencias del codebase

```sql
CREATE TABLE IF NOT EXISTS code_graph (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  file_path     TEXT NOT NULL,
  imports       TEXT DEFAULT '[]', -- JSON array de archivos que importa
  exported_by   TEXT DEFAULT '[]', -- JSON array de archivos que lo importan
  exports       TEXT DEFAULT '[]', -- JSON array de símbolos exportados
  complexity    INTEGER,           -- complejidad ciclomática estimada
  last_modified TEXT,
  indexed_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, file_path) ON CONFLICT REPLACE
);
CREATE INDEX IF NOT EXISTS idx_graph_session ON code_graph(session_id);
```

### Memoria semántica del desarrollador

```sql
CREATE TABLE IF NOT EXISTS developer_preferences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  category    TEXT NOT NULL CHECK(category IN (
    'style',        -- preferencias de código
    'workflow',     -- cómo trabaja
    'tech',         -- stack preferido
    'boundary'      -- lo que NO hace
  )),
  preference  TEXT NOT NULL,
  confidence  REAL DEFAULT 0.5,   -- 0-1, sube con confirmaciones
  source      TEXT,               -- de qué USER_OVERRIDE o rollback se extrajo
  active      INTEGER DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Trazas ACE

```sql
CREATE TABLE IF NOT EXISTS traces (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT REFERENCES tasks(id),
  agent_id        TEXT,
  tool_name       TEXT NOT NULL,
  input_summary   TEXT,
  output_summary  TEXT,
  thinking_summary TEXT,          -- resumen del thinking para aprendizaje
  success         INTEGER DEFAULT 1,
  duration_ns     INTEGER,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  analyzed        INTEGER DEFAULT 0,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_traces_analyzed ON traces(analyzed) WHERE analyzed = 0;

CREATE TABLE IF NOT EXISTS playbook (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule          TEXT NOT NULL,
  category      TEXT,             -- NULL = aplica a todos
  helpful_count INTEGER DEFAULT 0,
  harmful_count INTEGER DEFAULT 0,
  confidence    REAL DEFAULT 0.5,
  active        INTEGER DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_applied  DATETIME
);

CREATE VIRTUAL TABLE IF NOT EXISTS playbook_fts
  USING fts5(
    rule,
    category,
    tokenize = 'porter unicode61',
    content  = 'playbook',
    content_rowid = 'id'
  );

CREATE TABLE IF NOT EXISTS reflections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  traces_analyzed  INTEGER NOT NULL,
  insights         TEXT NOT NULL,
  preferences_extracted TEXT,    -- JSON array de preferencias del dev
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Skills FTS5

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts
  USING fts5(
    name,
    keywords,
    content,
    tokenize = 'porter unicode61',
    prefix   = '2 3'
  );
```

### Recovery y checkpoints

```sql
CREATE TABLE IF NOT EXISTS recovery_points (
  id          TEXT PRIMARY KEY,   -- UUIDv7
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  phase_id    INTEGER REFERENCES task_phases(id),
  git_ref     TEXT NOT NULL,      -- commit hash o branch en el momento
  state       TEXT NOT NULL,      -- JSON del estado completo del sistema
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS providers (
  name          TEXT PRIMARY KEY,
  display_name  TEXT,
  base_url      TEXT,
  models        TEXT,             -- JSON array
  added_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scratchpad (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(thread_id, key) ON CONFLICT REPLACE
);
```

---

## 8. TOOLS NATIVAS

Todas las tools viven en el main thread. Los subagentes las invocan por `postMessage` — nunca directamente. Esto serializa el acceso a filesystem y git, evitando race conditions.

### Tools de Filesystem

**read_file(path, offset?, limit?)**
Lee un archivo. Si es grande, usa offset+limit para leer solo el rango necesario. El flujo correcto es Glob → Grep para localizar → read_file del rango exacto. Retorna `{ content, startLine, totalLines, hash }`.

**write_file(path, content)**
Crea snapshot en SQLite antes de escribir. Usa `Bun.write()` — atómico por diseño. Solo para archivos nuevos. Para archivos existentes usar edit_file.

**edit_file(path, oldString, newString)**
str_replace quirúrgico. Falla con error descriptivo si `oldString` aparece 0 o más de 1 vez en el archivo. Crea snapshot antes de editar. Retorna `{ linesChanged, diff }`.

**list_dir(path, recursive?, glob?)**
Árbol de archivos con sizes y mtimes. Usa `Bun.Glob`.

**search_in_files(pattern, glob?, maxResults?)**
Búsqueda por contenido. Usa `ripgrep` via `Bun.spawn` si está disponible, fallback a `Bun.Glob.scan()`. Retorna `[{ path, line, column, match, context }]`.

**delete_file(path)**
Siempre requiere confirmación del usuario. Snapshot automático antes de borrar.

### Tools de Git

**git_status()** — `Bun.$ git status --porcelain`
**git_diff(path?)** — diff del archivo o del repo
**git_create_branch(name)** — `hive-code/task-{id}`
**git_commit(message, files[])** — Conventional Commits, staging explícito
**git_create_pr(title, body)** — GitHub API, narrativo en el body
**git_rollback(taskId)** — restaura snapshots + git reset, requiere confirmación
**git_blame(path, line)** — historia de una línea específica

### Tools de Ejecución

**shell_executor(cmd, cwd, timeoutMs?)**
`Bun.spawn` sandboxeado. Guarda traza en ACE automáticamente. Captura stdout, stderr, exitCode, durationNs. Emite evento al live feed con 🐝.

**run_tests(pattern?, flags[])**
`bun test --isolate` + flags. Captura output con async stack traces completos. Retorna `{ passed, failed, coverage, failures[] }`.

**check_types()**
`bun tsc --noEmit`. Retorna `{ errors[], warnings[] }`.

**run_script(path)**
Archivo TypeScript en proceso aislado. Timeout 60 segundos.

### Tools de Análisis

**parse_ast(path)**
`Bun.Transpiler` — análisis liviano sin tsc. Retorna `{ imports[], exports[], functions[], classes[], complexity }`.

**find_imports(path, recursive?)**
Árbol de dependencias. Detecta ciclos. Alimenta el grafo de dependencias en SQLite.

**check_dependencies()**
Lee bun.lock y package.json. Cruza contra CVEs conocidos.

### Tools de Narrativo

**read_narrative(taskId?, last?)**
FTS5 con filtros opcionales. Retorna entradas ordenadas por relevancia o recencia.

**append_narrative(entry)**
Solo el main thread escribe. Subagentes proponen, main thread valida y escribe.

**search_narrative(query)**
FTS5 con Porter stemmer. Retorna `{ excerpt, highlighted, score }`.

**read_decisions(status?)** / **write_decision(adr)**

### Tools de Imagen — Bun.Image

**capture_screenshot(url)**
Abre URL en `Bun.WebView`, captura screenshot, retorna como WebP optimizado.

**analyze_ui_screenshot(path)**
Lee imagen, genera thumbnail para incluir en contexto del agente de UI.

**generate_diagram(mermaid)**
Renderiza diagrama Mermaid a PNG via headless browser.

**optimize_asset(path, options)**
Comprime assets del proyecto con `Bun.Image` pipeline.

---

## 9. EVALUACIÓN DE SUBAGENTES

Tres niveles, en orden de ejecución:

### Evaluación estructural (automática, inmediata)

Antes de que Bee reporte resultado al usuario. Sin llamada LLM.

```
¿Los archivos prometidos en el mandato existen?
¿El código compila? (check_types)
¿Los tests pasan? (run_tests)
¿El lint pasa?
¿El str_replace aplicó correctamente? (hash del archivo)
```

Si falla la evaluación estructural → Bee no acepta el resultado. El subagente recibe feedback y reintenta. Máximo 3 intentos.

### Evaluación semántica (LLM, diferida)

Bee lee el output del subagente y lo compara contra el mandato original. Una llamada LLM pequeña con contexto reducido:

```
MANDATO: implementar endpoint /auth/refresh con rotación de tokens
OUTPUT DEL AGENTE: [código generado]
PREGUNTA: ¿el output cumple el mandato? ¿qué falta? ¿qué está mal?
```

Si falla → Bee reporta el análisis al usuario con el fallo específico.

### Evaluación del usuario (asíncrona)

En modo APPROVAL: aprobación explícita del checkpoint. En modo AUTO: ausencia de rollback en las próximas 5 interacciones es señal positiva que el ACE registra.

---

## 10. RECOVERY ANTE FALLOS

### Tipos de fallo y respuesta

**Fallo de LLM** (timeout, rate limit, respuesta malformada)
Bee guarda el estado actual en `recovery_points`. Reintenta con backoff exponencial: 1s, 2s, 4s, máximo 3 intentos. Si persiste, pausa la tarea y notifica al usuario con el estado exacto en el que quedó.

**Fallo de tool** (archivo no encontrado, git error, test falla)
El tool retorna error con async stack trace completo. Bee analiza el error y decide: ¿es recuperable? Si sí, ajusta el approach y reintenta. Si no, reporta al usuario con análisis específico de qué falló y por qué.

**Fallo del subagente** (timeout, error interno, evaluación fallida)
Bee recibe el `status: 'failed'` del Worker. Lee el error, decide si puede delegar a otro subagente o necesita intervención del usuario. Nunca silencia el fallo.

**Interrupción del usuario** (Ctrl+C, cierre de terminal)
El checkpoint más reciente en SQLite permite retomar. `hive-code task resume {id}` restaura el estado exacto. El narrativo tiene la historia completa.

### Recovery point — qué guardar

```typescript
interface RecoveryPoint {
  taskId: string
  phaseId: number
  gitRef: string          // commit hash exacto
  completedPhases: number[]
  pendingPhases: number[]
  lastNarrativeEntry: number  // rowid
  agentStates: Record<string, AgentStatus>
}
```

---

## 11. GRAFO DE DEPENDENCIAS DEL CODEBASE

El grafo se construye en el onboarding inicial y se actualiza incrementalmente con cada modificación de archivo.

### Construcción

Al hacer `hive-code init` en un proyecto nuevo:

```
1. Glob todos los archivos de código (*.ts, *.js, *.py, etc.)
2. Para cada archivo: parse_ast → extraer imports y exports
3. Construir el grafo de dependencias en code_graph
4. Calcular centralidad: archivos más importados = más críticos
```

### Uso por Bee

Antes de cualquier modificación, Bee consulta el grafo:

```
"Voy a modificar src/auth/jwt.ts"
→ ¿Quién importa este archivo?
→ middleware.ts, routes/auth.ts, tests/auth.test.ts
→ Bee sabe automáticamente que esos archivos pueden necesitar actualización
→ Los incluye en el scope del análisis sin que el usuario los mencione
```

### Actualización incremental

Después de cada `edit_file` o `write_file`, Hive-Code re-indexa solo los archivos afectados, no el codebase completo.

---

## 12. MEMORIA SEMÁNTICA DEL DESARROLLADOR

El ACE Reflector extrae preferencias del desarrollador de tres fuentes:

**USER OVERRIDEs** — instrucciones explícitas del usuario durante una tarea. "No toques el middleware, crea uno nuevo." → preferencia: "evitar modificar archivos de infraestructura existente".

**Rollbacks** — qué tareas el usuario revirtió. Si revirtió tres veces cuando Bee usó clases, la preferencia "prefiere funciones sobre clases" sube en confidence.

**Correcciones manuales** — git blame después de una tarea de Bee. Si el usuario editó manualmente código que Bee generó, el ACE registra qué cambió y extrae la preferencia implícita.

Estas preferencias se inyectan en el Context Compiler como parte del bloque de identidad de Bee para la sesión. No son reglas rígidas — son contexto que Bee considera.

---

## 13. GESTIÓN DE TOKENS Y COSTOS

### Estimación pre-tarea

Antes de ejecutar en modo APPROVAL, Bee muestra:

```
ESTIMADO DE COSTO
  Modelo:    claude-sonnet-4-6
  Fases:     4
  Tokens ~:  2,400 input · 800 output
  Costo ~:   $0.018 USD
  
¿Continuar?
```

La estimación usa el historial del ACE para tareas similares en el mismo proyecto.

### Tracking en tiempo real

Cada mensaje en la tabla `messages` guarda `tokens_in` y `tokens_out`. Cada tarea acumula `tokens_total` y `cost_usd`. La barra de estado en la TUI muestra el acumulado de la sesión actual.

### Alertas de costo

Si una tarea supera 2x la estimación inicial → Bee pausa y notifica. El usuario decide si continuar o cancelar.

### Context Compiler como optimizador de costo

El formato toon reduce tokens 5-10x en la representación del codebase. El cache del Context Compiler evita recompilar el mismo contexto. Las skills se inyectan solo cuando son relevantes por FTS5 — no siempre.

---

## 14. SEGURIDAD Y SANDBOX

### Validación antes de ejecución

Bee tiene una capa de validación antes de ejecutar cualquier comando generado por LLM:

```
¿El comando modifica archivos fuera del directorio del proyecto?
¿El comando accede a variables de entorno del host?
¿El comando descarga código externo sin pasar por package.json?
¿El comando tiene rm -rf o equivalentes destructivos?
¿El comando expone puertos o hace requests de red inesperados?
```

Si alguna validación falla → Bee no ejecuta, reporta al usuario qué encontró.

### Prompt injection en el codebase

Hive-Code puede leer archivos del proyecto que contengan instrucciones maliciosas para el agente (CLAUDE.md envenenado, comentarios con instrucciones). Mitigación: el Context Compiler marca el contenido de archivos del usuario como `[USER_CONTENT]` — Bee sabe que ese contenido no son instrucciones del sistema sino datos a procesar.

### Bun.spawn sandbox

```
cwd: directorio aislado por tarea
env: { PATH, HOME, TMPDIR } — sin secrets del host
timeout: 30_000ms
maxBuffer: 10MB
killSignal: SIGKILL al timeout
```

### Acciones que siempre requieren confirmación

Sin importar el modo (Plan/Approval/Auto):

- `DROP TABLE` / `DELETE FROM` sin WHERE
- Eliminar archivos del repositorio
- Push directo a `main` o `master`
- `bun add` — instalar dependencia nueva
- Modificar `.env`, `Bun.secrets`, configs de producción
- Ejecutar script descargado de internet
- Cualquier comando con `sudo`

---

## 15. LIVE FEED CON 🐝

### Eventos emitidos por WebSocket

```typescript
interface BeeEvent {
  type: 'tool_start' | 'tool_end' | 'thinking' | 'narration' |
        'phase_start' | 'phase_end' | 'task_end' | 'error'
  agentId: string
  tool?: string           // nombre de la tool si es tool_start/end
  activeForm: string      // "Buscando documentación de JWT..."
  beeState: 'thinking' | 'searching' | 'reading' |
            'writing' | 'executing' | 'done' | 'error'
  payload?: string        // contenido relevante
  tokensUsed?: number
  durationMs?: number
  timestamp: number
}
```

### Mapa tool → estado de la 🐝

```
web_search     → beeState: 'searching'   🐝 vuela horizontal
file_read      → beeState: 'reading'     🐝 quieta + efecto lupa
file_edit      → beeState: 'writing'     🐝 quieta + efecto lápiz
bash           → beeState: 'executing'   🐝 pulsa rápido
thinking       → beeState: 'thinking'    🐝 flota suave
spawn_agent    → beeState: 'thinking'    🐝 + indicador de spawn
grep           → beeState: 'searching'   🐝 + lupa
parse_ast      → beeState: 'reading'     🐝 quieta
run_tests      → beeState: 'executing'   🐝 pulsa
completed      → beeState: 'done'        🐝 celebra (una vez)
error          → beeState: 'error'       🐝 oscila
```

### activeForm — declarado por el agente

Bee y cada subagente declaran el `activeForm` antes de ejecutar cada tool. No lo infiere el sistema. Texto en presente continuo, específico:

- ✓ "Analizando dependencias de src/auth/jwt.ts"
- ✓ "Ejecutando bun test --isolate auth.test.ts"
- ✗ "Ejecutando herramienta"
- ✗ "Procesando..."

### Resultado colapsado

Cuando una tool termina, el live feed muestra una línea resumida que el usuario puede expandir para ver el output completo. Esto evita que el output de un grep de 200 resultados inunde la pantalla.

---

## 16. TUI — RATATUI (RUST)

### Arquitectura

La TUI está implementada en Rust con Ratatui. Se comunica con el server de Bun via WebSocket. Recibe eventos `BeeEvent` y los renderiza. No tiene lógica de agentes — es puramente presentacional.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  🐝 hive-code v1.0.0  │  PLAN  │  claude-sonnet-4-6 │
├──────────────────┬──────────────────────────────────┤
│                  │                                   │
│   LIVE FEED      │         CHAT / NARRACIÓN          │
│   (🐝 events)   │                                   │
│                  │                                   │
│   🐝 ···        │   Bee: He encontrado 3 pendientes  │
│   Leyendo jwt.ts │   en el narrativo. El más urgente  │
│                  │   es el refresh token de abril.    │
│   🐝 ✎          │                                   │
│   Escribiendo    │   ¿Continúo con ese primero?      │
│   refresh.ts     │                                   │
│                  │   > _                             │
├──────────────────┴──────────────────────────────────┤
│  ctx: 2,400 tok  │  $0.02  │  ^C salir  │  :help    │
└─────────────────────────────────────────────────────┘
```

### Estados de la 🐝 en Ratatui

Frames ASCII animados en el panel de live feed. El emoji real más efectos de texto alrededor:

```
Searching:   🐝 ·  ·  ·   Buscando...
             🐝  · · ·    Buscando...
Reading:     🐝 ✎         Leyendo jwt.ts líneas 45-89
Executing:   🐝 ⚡         Ejecutando bun test
Thinking:    🐝            Razonando...   (oscila suave)
Done:        🐝 ✓          3 archivos modificados
Error:       🐝 ✗          Falló: old_string no único
```

### Thinking en Ratatui

Colapsado por defecto. Un indicador `[▶ thinking: 47 líneas]` que se expande con una tecla. El contenido del thinking no se muestra a menos que el usuario lo solicite.

---

## 17. UI — VITE + DASHBOARD

### Stack

Vite 8. Sin framework específico definido en el TDD — la elección de Vue/React/Svelte queda para la implementación. El server de Bun sirve la UI como assets estáticos y provee la API WebSocket.

### Paneles

**Dashboard** — estado del sistema en tiempo real. Sesión activa, provider, modelo, costo acumulado, Workers activos.

**Flow de agentes** — grafo visual de Bee y sus subagentes. Nodos con estado (idle/running/done/error), aristas de delegación, timeline de ejecución. El thinking de Bee aparece aquí como un panel lateral que se puede mostrar/ocultar.

**Chat** — hilo conversacional con el usuario. Mensajes de Bee, narración, checkpoints de APPROVAL.

**Live feed 🐝** — el mismo feed que la TUI pero con CSS animations. El emoji 🐝 tiene:

```css
/* Buscando — vuela horizontal */
.bee-searching { animation: flyHorizontal 1.5s ease-in-out infinite; }

/* Pensando — flota vertical */
.bee-thinking  { animation: float 2s ease-in-out infinite; }

/* Ejecutando — pulsa */
.bee-executing { animation: pulse 0.3s ease-in-out infinite; }

/* Done — celebra una vez */
.bee-done      { animation: celebrate 0.6s ease-out 1; }

/* Error — oscila */
.bee-error     { animation: shake 0.4s ease-in-out 3; }
```

### Bun.Image en la UI

La UI sirve screenshots de componentes generados, diagramas de arquitectura renderizados, y thumbnails del codebase — todos procesados con `Bun.Image` antes de servirlos. Ver sección 20.

---

## 18. CLI — COMANDOS Y COMANDOS INTERNOS

### Comandos CLI (binario)

```
hive-code start [--port] [--mode plan|approval|auto]
hive-code stop | restart | status | logs [--follow]
hive-code init [path]
hive-code plan "<tarea>"
hive-code run "<tarea>"
hive-code doctor [--fix]
hive-code version | upgrade | changelog

hive-code provider list|add|set|test
hive-code mcp list|add|enable|disable|test
hive-code skill list|enable|disable|add|info
hive-code mode get|set|history
hive-code task list|status|cancel|rollback|resume
hive-code narrative show|search|export
hive-code decision list|show
hive-code ace status|playbook|reflector
hive-code secret list|set|delete|rotate
hive-code note list|add|get|delete
hive-code github connect|disconnect|status|whoami
```

### Comandos internos (dentro del prompt de Bee)

Escribiendo `/` dentro del chat activo:

```
/provider list|add|set|test|status
/modelo list|set|info
/mcp list|add|enable|disable|test
/skill list|enable|disable|info|add
/mode get|set
/task list|status|cancel|rollback
/narrative show|search
/ace status|reflector run
/doctor
/help [<comando>]
/version
```

Autocompletado con Tab usando FTS5 con índice de prefijo `prefix = '2 3'`.

### Seguridad de comandos internos

Las API keys nunca se muestran. `/provider add` solicita la key via stdin sin echo. Las keys se guardan en `Bun.secrets`, nunca en SQLite.

---

## 19. DISTRIBUCIÓN Y EMPAQUETADO

### Binarios por plataforma

`bun build --compile --assets ./dist/ui` — incluye la Vite UI embebida.

```
hive-code-{version}-linux-x64
hive-code-{version}-linux-arm64
hive-code-{version}-linux-x64-musl      (Alpine / Docker slim)
hive-code-{version}-macos-x64           (Intel)
hive-code-{version}-macos-arm64         (Apple Silicon)
hive-code-{version}-windows-x64.exe
hive-code-{version}-windows-arm64.exe
```

Generados por GitHub Actions en push con tag `v*`. La TUI Ratatui se compila como binario separado o como sidecar — a definir en implementación según la integración con el binario principal.

### Paquete npm

```
@johpaz/hive-code
```

`postinstall` detecta plataforma, descarga el binario nativo desde GitHub Releases.

### Instalación

```bash
npm install -g @johpaz/hive-code
bun install -g @johpaz/hive-code
curl -fsSL https://hive-code.io/install.sh | bash
```

---

## 20. BUN.IMAGE — DIFERENCIAL DE HIVE-CODE

`Bun.Image` es la API de procesamiento de imágenes nativa de Bun. Cero dependencias npm, cero build steps, cero addons. Construida sobre libjpeg-turbo, spng, libwebp, SIMD. Todo corre off the JavaScript thread.

### Casos de uso en Hive-Code

**Verificación visual de UI generada**

El subagente de frontend genera un componente. `Bun.WebView` lo abre, captura un screenshot. `Bun.Image` lo procesa:

```
screenshot raw (1920x1080, ~2MB)
→ Bun.Image.resize(800, 600, { fit: 'inside' })
→ .webp({ quality: 70 })
→ ~50KB lista para incluir en el contexto del agente
```

El agente recibe la imagen comprimida, la analiza visualmente, detecta errores de renderizado sin que el desarrollador abra ningún browser.

**Diagramas de arquitectura**

El Architecture Coordinator genera un diagrama en Mermaid. Hive-Code lo renderiza a imagen via headless browser, la optimiza con `Bun.Image`, y la incluye en el arnés del plan que ve el usuario en la UI de Vite.

**Screenshots de errores visuales**

Cuando un test E2E falla con diferencia visual, Bee captura el screenshot del estado fallido, lo optimiza con `Bun.Image`, y lo incluye en el reporte de error al usuario. El usuario ve exactamente qué está mal sin abrir el browser.

**Thumbnails del codebase**

Para proyectos con assets de imagen (logos, iconos, screenshots de docs), Hive-Code puede indexar y generar thumbnails de todos los assets para que Bee sepa qué hay disponible sin cargar imágenes completas al contexto.

**Clipboard para contexto visual**

```typescript
const img = Bun.Image.fromClipboard();
if (img) {
  // El usuario pegó un screenshot de un bug, un mockup, o un error
  // Bee puede analizarlo como contexto adicional de la tarea
}
```

El usuario puede pegar un screenshot directamente — de un bug visual, de un mockup de diseño, de un error de browser. Bee lo recibe como contexto sin que el usuario tenga que describirlo en texto.

### Lo que ningún otro coding agent tiene

Claude Code no procesa imágenes localmente. Codex tampoco. Gemini puede recibir imágenes pero no las procesa con un pipeline nativo integrado en el runtime.

Hive-Code con `Bun.Image` puede: capturar, redimensionar, optimizar, analizar visualmente, y usar imágenes como parte del ciclo de desarrollo — todo sin dependencias externas, todo off the JS thread, todo en el mismo proceso.

---

## 21. OBSERVABILIDAD DEL SISTEMA

### Debug de decisiones históricas

Para cualquier llamada LLM histórica el desarrollador puede reconstruir:

```
hive-code task debug {taskId} --phase 2
→ contexto exacto que recibió el LLM
→ tokens usados
→ tiempo de respuesta
→ qué reglas del playbook estaban activas
→ qué skills estaban inyectadas
→ thinking del agente (si se guardó)
```

### Métricas en tiempo real

La barra de estado en ambas UIs muestra:
- Tokens de la sesión actual
- Costo acumulado USD
- Tiempo desde inicio de la tarea
- Modelo activo
- Modo activo

### Logs del sistema

```
DEBUG  → mensajes entre Workers (solo en desarrollo)
INFO   → inicio/fin de fases, tool calls exitosos
WARN   → hallazgos MEDIUM/LOW, retries, estimación superada
ERROR  → fallos de tools, Workers caídos, errores de LLM
```

Nunca loguear: API keys, tokens de auth, contenido de archivos completos, output de LLM con datos sensibles.

### Tests del sistema

```bash
# Tests de integración del agent loop completo
bun test --isolate tests/agent-loop/

# Tests de recovery ante fallos simulados
bun test --isolate tests/recovery/

# Tests del Context Compiler
bun test --isolate tests/context-compiler/

# Tests del schema SQLite
bun test --isolate tests/database/
```

---

## 22. ONBOARDING DE PROYECTO NUEVO

El primer `hive-code init` en un repo que el sistema nunca ha visto.

### Flujo completo

```
1. Detectar stack automáticamente
   → package.json, pyproject.toml, Cargo.toml, go.mod...
   → Determinar: runtime, lenguaje, framework, test runner

2. Indexar el codebase
   → Glob todos los archivos de código
   → parse_ast de cada archivo → code_graph en SQLite
   → FTS5 index del contenido (para search_in_files)
   → Generar mapa comprimido en formato toon

3. Leer contexto existente
   → README.md → contexto del proyecto
   → CLAUDE.md / .hive / docs → instrucciones del dev
   → git log --oneline -50 → historia reciente
   → TODOs/FIXMEs → problemas conocidos

4. Primera entrada del narrativo
   → "Proyecto inicializado el {fecha}. Stack: {stack}.
      {N} archivos indexados. Pendientes detectados: {lista}.
      Sin tareas previas."

5. Preguntar al usuario (una sola vez)
   → ¿Hay algo que Bee debe saber sobre cómo trabajas en este proyecto?
   → Respuesta libre → guardada como primera preferencia del dev

6. Listo
   → Dashboard muestra el proyecto
   → Bee está listo para la primera tarea
```

### Tiempo estimado de onboarding

```
Proyecto pequeño  (<50 archivos):   < 5 segundos
Proyecto mediano  (<500 archivos):  < 30 segundos
Proyecto grande   (<5000 archivos): < 3 minutos
```

---

## 23. ADRs — DECISIONES DE ARQUITECTURA

### ADR-001: Un coordinador central (Bee) vs múltiples coordinadores fijos

**Decisión:** Un solo coordinador central con subagentes dinámicos.

**Por qué no múltiples fijos:** Seis Workers permanentes es overhead real para tareas simples. La mayoría de tareas cotidianas no necesitan Architecture + Backend + Security + Test + DevOps + Frontend simultáneamente. Un coordinador general que crea lo que necesita es más eficiente y más adaptable.

**Consecuencia:** Bee debe ser muy bueno decidiendo qué subagentes crear. El system prompt de Bee es el artefacto más importante del sistema.

---

### ADR-002: SQLite WAL vs Redis vs PostgreSQL

**Decisión:** SQLite con WAL mode como única base de datos.

**Por qué no Redis:** Es un cliente, no un servidor embebido. Requiere proceso externo. Rompe el principio local-first. Los casos de uso de cache los cubre el Map en memoria del Context Compiler.

**Por qué no PostgreSQL:** Requiere servidor externo. El binario deja de ser standalone. Para 1-10 Workers concurrentes, SQLite WAL es más que suficiente.

**Escape hatch:** La interfaz `HiveCodeStorage` permite swapear a PostgreSQL en un PR de un día si el caso de uso multi-instancia lo requiere en el futuro.

---

### ADR-003: Bun Workers vs procesos separados para subagentes

**Decisión:** Bun Workers (threads reales) para subagentes.

**Por qué no procesos:** IPC entre procesos tiene más overhead que postMessage entre Workers. Los Workers comparten acceso al I/O del kernel (red, filesystem) sin copia. El binario único es más simple de distribuir.

**Limitación conocida:** La Workers API de Bun aún es experimental para terminación. Mitigación: manejo robusto del evento `"close"` + `worker.unref()`.

---

### ADR-004: TUI en Rust (Ratatui) vs TUI en TypeScript

**Decisión:** Ratatui en Rust para la TUI.

**Por qué no TypeScript:** Las librerías de TUI en TypeScript (Ink, pi-tui, Rezi) tienen dependencias problemáticas, están en alpha, o requieren React. Ratatui es el estándar de la industria para TUIs en producción, maduro, con comunidad activa.

**Consecuencia:** El sistema tiene dos componentes en lenguajes distintos. Comunicación via WebSocket — limpia, sin acoplamiento.

---

### ADR-005: TUI con Rezi — estrategia

**Decisión descartada:** Usar Rezi (@rezi-ui) como TUI principal.

**Por qué descartado:** 1 solo maintainer, alpha.71, motor C (Zireael) como submodulo que podría no estar disponible en fork. El plan a largo plazo es implementar HiveTUI propio cuando el proyecto madure.

**Plan actual:** Ratatui para la TUI. HiveTUI propio como proyecto futuro cuando haya recursos.

---

### ADR-006: Editar vs reescribir archivos

**Decisión:** str_replace siempre. Nunca reescribir archivos completos.

**Por qué:** Un archivo de 3000 líneas modificado en 20 líneas debe producir un diff de 20 líneas. Reescribir produce un diff de 3000 líneas — ilegible, imposible de revisar, propenso a perder código.

**Implementación:** `edit_file` falla con error descriptivo si `old_string` aparece 0 o más de 1 vez. El agente debe incluir suficiente contexto para hacer el match único.

---

### ADR-007: Bun.Image como diferencial

**Decisión:** Integrar Bun.Image en el ciclo de desarrollo para verificación visual, diagramas, y análisis de screenshots.

**Por qué es diferencial:** Ningún competitor tiene procesamiento de imágenes nativo en el runtime. Permite que Bee "vea" el resultado de su trabajo de UI sin herramientas externas. El input del usuario via clipboard abre un canal de comunicación visual que ningún otro sistema tiene.

---

## 24. RIESGOS Y MITIGACIONES

### Riesgo 1 — Fallo del LLM a mitad de tarea larga

**Probabilidad:** Alta en tareas de >20 min. **Impacto:** Alto.

**Mitigación:** Recovery points en SQLite antes de cada fase. `hive-code task resume {id}` retoma desde el último checkpoint. Backoff exponencial en reintentos (1s, 2s, 4s).

---

### Riesgo 2 — Prompt injection en archivos del proyecto

**Probabilidad:** Media. **Impacto:** Alto.

**Mitigación:** El Context Compiler marca contenido de archivos del usuario como `[USER_CONTENT]`. Validación de comandos antes de ejecución. Lista de operaciones que siempre requieren confirmación.

---

### Riesgo 3 — Costo de tokens inesperado

**Probabilidad:** Alta para usuarios nuevos. **Impacto:** Medio.

**Mitigación:** Estimación pre-tarea en modo APPROVAL. Alerta si la tarea supera 2x la estimación. Contador visible en ambas UIs. Context Compiler con formato toon reduce tokens 5-10x.

---

### Riesgo 4 — Workers API experimental en Bun

**Probabilidad:** Media. **Impacto:** Bajo-Medio.

**Mitigación:** Manejo robusto de `"close"` y `"error"`. El main thread detecta Workers caídos y los reinicia. `smol: true` en Workers ligeros. Probar en Bun 1.3.14 antes de asumir estabilidad.

---

### Riesgo 5 — Subagente genera código peligroso

**Probabilidad:** Baja. **Impacto:** Alto.

**Mitigación:** Sandbox con cwd aislado, env mínimo, timeout. Validación pre-ejecución. Lista de operaciones siempre con confirmación. Prompt injection detectada por Context Compiler.

---

## 25. ROADMAP DE IMPLEMENTACIÓN

### Sprint 1 — Fundamentos (semana 1-2)
- Schema SQLite completo con FTS5 y triggers
- Bun Workers básicos con postMessage
- SharedArrayBuffer para estado de sesión
- Context Compiler básico con cache Map
- Tools: read_file paginado, write_file con snapshot, edit_file con validación de unicidad

**Done cuando:** Un Worker puede leer un archivo y escribir al narrativo sin race conditions.

---

### Sprint 2 — Agent Loop (semana 2-3)
- Agent loop propio de Bee
- Manejo de thinking blocks
- Tool execution con sandbox
- Evaluación estructural de subagentes
- Recovery points básicos

**Done cuando:** Bee puede ejecutar una tarea simple de 3 pasos con tools reales y el resultado queda en SQLite.

---

### Sprint 3 — Reconocimiento y Arnés (semana 3-4)
- Reconocimiento automático del codebase
- Generación del arnés del plan
- Spawn dinámico de subagentes (spawn_agent tool)
- Grafo de dependencias básico
- FTS5 para narrativo y playbook

**Done cuando:** Bee puede recibir una instrucción vaga, reconocer el codebase, y generar un arnés con subagentes apropiados.

---

### Sprint 4 — Modos y TUI (semana 4-5)
- Modos Plan/Approval/Auto completos
- Toggle Shift+Tab via BroadcastChannel
- Checkpoints de fase con preview
- USER OVERRIDE en narrativo
- Integración WebSocket con Ratatui TUI

**Done cuando:** El usuario puede cambiar de modo durante una tarea y ver el cambio reflejado en la TUI inmediatamente.

---

### Sprint 5 — Live Feed y Vite UI (semana 5-6)
- Eventos BeeEvent completos
- 🐝 con estados y animaciones en Ratatui
- Dashboard Vite con flow de agentes
- Thinking visible en Vite UI
- 🐝 con CSS animations en Vite

**Done cuando:** Una tarea completa se visualiza en tiempo real en ambas UIs con la 🐝 animada correctamente.

---

### Sprint 6 — ACE y Memoria (semana 6-7)
- ACE Reflector con Bun.cron
- Extracción de preferencias del desarrollador
- Playbook FTS5 completo
- Estimación de costos pre-tarea
- Tracking de tokens en tiempo real

**Done cuando:** Después de 5 tareas, el ACE ha extraído al menos 3 preferencias del desarrollador que Bee usa en la siguiente tarea.

---

### Sprint 7 — Bun.Image y Seguridad (semana 7-8)
- Bun.Image en el pipeline de verificación de UI
- Screenshot via Bun.WebView → optimización → contexto
- Clipboard como canal de input visual
- Validación pre-ejecución de comandos
- Sandbox completo con todas las restricciones

**Done cuando:** El agente de frontend puede generar un componente, abrirlo en WebView, capturar el screenshot, y reportar errores visuales sin intervención del usuario.

---

### Sprint 8 — CLI, Onboarding y Distribución (semana 8-10)
- Todos los comandos CLI
- Comandos internos con autocompletado FTS5
- `hive-code doctor` completo
- Flujo de onboarding de proyecto nuevo
- `bun build --compile` para los 7 targets
- `@johpaz/hive-code` en npm

**Done cuando:** `npm install -g @johpaz/hive-code && hive-code init` funciona en una máquina limpia en menos de 5 minutos.

---

### Sprint 9 — Hardening (semana 10-12)
- Tests de integración del agent loop completo
- Tests de recovery ante fallos simulados
- Tests del Context Compiler
- Documentación de usuario final
- Observabilidad completa (debug histórico)
- Release v1.0.0

---
# Hive-Code — TDD Continuación
## Secciones 26–35
**Versión:** 1.0.0 | **Continuación del documento principal**

---

## 26. CONTRATOS DE MENSAJES ENTRE WORKERS

Todo lo que viaja por `postMessage` entre el main thread y los Workers tiene un tipo explícito. Sin `any`. Sin strings libres.

### Main thread → Worker (despacho de tarea)

```typescript
interface WorkerTask {
  taskId: string           // UUIDv7
  agentId: string          // ID del agente en SQLite
  purpose: string          // qué debe hacer
  systemPrompt: string     // identidad completa del agente
  compiledContext: string  // formato toon del Context Compiler
  tools: ToolName[]        // subset de tools disponibles
  llmConfig: {
    provider: string
    model: string
    maxTokens: number
    thinkingEnabled: boolean
    thinkingBudget?: number
  }
  parallel: boolean
  timeoutMs: number
  activeForm: string       // "Analizando dependencias de auth..."
}
```

### Worker → Main thread (resultado)

```typescript
interface WorkerResult {
  taskId: string
  agentId: string
  status: 'completed' | 'failed' | 'timeout' | 'needs_input'
  output: string                    // resultado final del agente
  filesModified: string[]
  toolCalls: ToolTrace[]
  thinkingSummary?: string          // resumen del thinking para ACE
  narrativeEntry: string            // entrada lista para append_narrative
  evalStructural?: boolean          // resultado de evaluación estructural
  tokensIn: number
  tokensOut: number
  durationMs: number
  error?: {
    type: 'llm_error' | 'tool_error' | 'validation_error' | 'timeout'
    message: string
    stackTrace?: string
    recoverable: boolean
  }
}
```

### Worker → Main thread (tool request)

Los Workers no ejecutan tools directamente — las solicitan al main thread:

```typescript
interface ToolRequest {
  requestId: string        // para correlacionar la respuesta
  agentId: string
  toolName: ToolName
  input: ToolInput         // tipado por toolName
  activeForm: string       // para el live feed
}

interface ToolResponse {
  requestId: string
  agentId: string
  toolName: ToolName
  output: unknown
  success: boolean
  durationNs: number
  error?: string
}
```

### BroadcastChannel — eventos de control

```typescript
interface ControlEvent {
  type:
    | 'MODE_CHANGED'
    | 'TASK_CANCELLED'
    | 'PAUSE_ALL'
    | 'RESUME_ALL'
    | 'SHUTDOWN'
  sessionId: string
  payload?: {
    mode?: 'plan' | 'approval' | 'auto'
    taskId?: string
    reason?: string
  }
  timestamp: number
}
```

### WebSocket → UIs (live feed)

```typescript
interface BeeEvent {
  type:
    | 'tool_start'
    | 'tool_end'
    | 'thinking_chunk'
    | 'narration'
    | 'phase_start'
    | 'phase_complete'
    | 'task_complete'
    | 'checkpoint'
    | 'error'
    | 'mode_changed'
    | 'cost_update'
  agentId: string
  taskId?: string
  phaseId?: number
  tool?: string
  activeForm: string
  beeState:
    | 'thinking'
    | 'searching'
    | 'reading'
    | 'writing'
    | 'executing'
    | 'waiting'
    | 'done'
    | 'error'
    | 'idle'
  payload?: string
  tokensUsed?: number
  costUsd?: number
  durationMs?: number
  timestamp: number
}
```

---

## 27. SYSTEM PROMPTS BASE DE SUBAGENTES COMUNES

Bee crea subagentes dinámicamente pero hay patrones recurrentes. Estos son los system prompts semilla para los subagentes más comunes. Bee los personaliza antes de cada spawn con el contexto específico de la tarea.

### Subagente de implementación de código

```
Eres un ingeniero de software implementando código TypeScript para Bun.

RECIBISTE:
- Un ADR o especificación del trabajo a hacer
- Las interfaces TypeScript que debes respetar
- El contexto del proyecto en formato comprimido

REGLAS DE EDICIÓN:
- Lee el archivo ANTES de modificarlo siempre
- Usa edit_file con str_replace — nunca write_file sobre archivos existentes
- Si old_string no es único: incluye más líneas de contexto
- Verifica con check_types() después de cada archivo
- Un error de tipos es un blocker — no continúes con tipos rotos

REGLAS DE CÓDIGO:
- TypeScript strict, async/await, sin callbacks
- try/catch con tipo explícito en el catch
- Credenciales solo via Bun.secrets — nunca hardcodeadas
- JSDoc en cada función pública con @param, @returns, @throws

AL TERMINAR:
Escribe en tu output:
1. Qué implementaste
2. Por qué tomaste las decisiones que tomaste
3. Qué encontraste inesperado
4. Qué archivos tocaste y en qué líneas
```

### Subagente de base de datos

```
Eres un especialista en base de datos. Trabajas con SQLite via bun:sqlite.

REGLAS:
- Todas las queries usan placeholders — nunca concatenación de strings
- Cada migración es un archivo separado en migrations/
- Las migraciones son idempotentes — usan IF NOT EXISTS
- Los índices van en columnas que aparecen en WHERE y ORDER BY
- Las foreign keys siempre tienen ON DELETE definido

PARA CADA CAMBIO DE SCHEMA:
1. Escribe la migración en migrations/{timestamp}_{nombre}.sql
2. Verifica que la migración es reversible
3. Documenta el propósito en un comentario SQL al inicio del archivo

PARA CADA QUERY:
1. Explica el plan de ejecución esperado
2. Verifica que hay índice en las columnas de filtrado
3. Para queries complejas: usa EXPLAIN QUERY PLAN primero
```

### Subagente de tests

```
Eres un especialista en testing. Escribes tests con bun:test.

FILOSOFÍA:
Un test bueno falla por una razón clara y específica.
Si un test puede fallar por cinco razones distintas, es un test malo.

SIEMPRE INCLUYE:
- Happy path de cada función pública
- Edge cases documentados en el código o spec
- Casos de error: inputs inválidos, null, undefined, strings vacíos
- Casos límite: arrays vacíos, valores extremos, concurrencia

NUNCA:
- Mockees la función que estás testeando
- Escribas un test que nunca puede fallar
- Dependas del orden de ejecución entre tests (--isolate lo garantiza)

FORMATO:
describe("cuando {condición}") → it("{resultado esperado}")
No: describe("UserService") → it("test 1")
Sí: describe("cuando el token expira") → it("retorna 401 con mensaje claro")

CICLO OBLIGATORIO:
1. Escribe el test
2. Corre con run_tests()
3. Si falla: analiza el async stack trace COMPLETO
4. Decide: ¿bug en test o bug en implementación?
5. Si es bug en implementación: reporta, no corrijas el código ajeno
6. Repite hasta que todos pasen o hasta 3 ciclos
```

### Subagente de seguridad

```
Eres un auditor de seguridad. Solo lees, nunca escribes código.

CHECKLIST OBLIGATORIO (en este orden):

□ SECRETS: strings con patrón de key en el código
  (sk-, ghp_, Bearer, password=, API_KEY=)

□ INJECTION SQL: queries con concatenación de strings
  Buscar: + en queries, template literals en SQL, f-strings en SQL

□ INJECTION DE COMANDOS: Bun.spawn con input del usuario sin sanitizar
  Buscar: variables de usuario en arrays de argumentos sin validación

□ PATH TRAVERSAL: rutas construidas con input del usuario
  Buscar: path.join con req.params, readFile con variables externas

□ AUTENTICACIÓN: endpoints sin verificación de token
  Buscar: routes que no llaman verify() antes de ejecutar lógica

□ EXPOSICIÓN DE DATOS: respuestas con campos internos
  Buscar: objetos completos de DB retornados directamente (password, hash)

□ DEPENDENCIAS: CVEs en bun.lock
  Ejecutar check_dependencies() siempre

FORMATO DE REPORTE por hallazgo:
[CRITICAL|HIGH|MEDIUM|LOW] archivo:línea
Descripción: qué está mal y por qué es un riesgo
Patch: diff concreto listo para aplicar

REGLA ABSOLUTA:
Un CRITICAL bloquea todo. No hay excepciones.
```

### Subagente de documentación

```
Eres un technical writer. Escribes documentación para desarrolladores.

PRINCIPIOS:
- Explica el "por qué" antes del "cómo"
- Un ejemplo vale más que tres párrafos de descripción
- La documentación que no está actualizada es peor que no tener documentación

PARA CADA MÓDULO:
1. Propósito en una sola oración
2. Cuándo usarlo y cuándo NO usarlo
3. Ejemplo mínimo funcional
4. Parámetros con tipos y descripción
5. Errores posibles y cómo manejarlos

FORMATO:
Markdown. Sin HTML. Sin tablas complejas.
Código siempre en bloques con el lenguaje especificado.
```

---

## 28. FTS5 — QUERIES COMPLETAS DE PRODUCCIÓN

### Búsqueda en narrativo con fallback

```typescript
export function searchNarrative(
  db: Database,
  query: string,
  taskId?: string,
  limit = 5
): NarrativeMatch[] {

  const taskClause = taskId
    ? `AND n.task_id = '${taskId.replace(/'/g, "''")}'`
    : '';

  const sql = `
    SELECT
      n.id,
      n.agent_id,
      n.task_id,
      snippet(narrative_fts, 0, '▶', '◀', '...', 20) AS excerpt,
      highlight(narrative_fts, 0, '▶', '◀')           AS highlighted,
      bm25(narrative_fts, 1.0, 0.5)                    AS score,
      n.created_at
    FROM narrative_fts
    JOIN narrative n ON n.id = narrative_fts.rowid
    WHERE narrative_fts MATCH ?
      ${taskClause}
    ORDER BY score
    LIMIT ?
  `;

  // Intento 1: frase exacta con stemming
  let results = db.query(sql).all(sanitizeFts(query), limit);
  if (results.length > 0) return results as NarrativeMatch[];

  // Intento 2: tokens con OR y wildcard
  const orQuery = query
    .split(/\s+/)
    .map(t => t.replace(/["()*^{}]/g, '').toLowerCase())
    .filter(t => t.length >= 3)
    .map(t => `${t}*`)
    .join(' OR ');

  if (!orQuery) return [];
  return db.query(sql).all(orQuery, limit) as NarrativeMatch[];
}
```

### Activación de skills por relevancia

```typescript
export function findRelevantSkills(
  db: Database,
  taskDescription: string,
  limit = 3
): SkillMatch[] {

  const tokens = taskDescription
    .split(/\s+/)
    .map(t => t.replace(/["()*^{}]/g, '').toLowerCase())
    .filter(t => t.length >= 3)
    .join(' OR ');

  if (!tokens) return [];

  // Pesos: keywords(3.0) > name(2.0) > content(1.0)
  // BM25 menor = más relevante — ORDER BY score ASC
  return db.query(`
    SELECT name, keywords, bm25(skills_fts, 2.0, 3.0, 1.0) AS score
    FROM skills_fts
    WHERE skills_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(tokens, limit) as SkillMatch[];
}
```

### Playbook relevante por coordinador

```typescript
export function findRelevantRules(
  db: Database,
  taskKeywords: string,
  category: string,
  limit = 5
): PlaybookMatch[] {

  const tokens = taskKeywords
    .split(/\s+/)
    .map(t => t.replace(/["()*^{}]/g, '').toLowerCase())
    .filter(t => t.length >= 3)
    .join(' OR ');

  if (!tokens) return [];

  // coordinator tiene peso mayor (2.0) — reglas específicas
  // ranquean antes que reglas globales (coordinator IS NULL)
  return db.query(`
    SELECT
      p.id, p.rule, p.category, p.confidence,
      bm25(playbook_fts, 1.0, 2.0) AS score
    FROM playbook_fts
    JOIN playbook p ON p.id = playbook_fts.rowid
    WHERE playbook_fts MATCH ?
      AND p.active = 1
      AND (p.category IS NULL OR p.category = ?)
    ORDER BY score
    LIMIT ?
  `).all(tokens, category, limit) as PlaybookMatch[];
}
```

### Autocompletado de comandos con prefijo

```typescript
export function autocompleteCommand(
  db: Database,
  prefix: string
): string[] {
  if (prefix.length < 2) return [];

  const token = prefix.replace(/["()*^{}]/g, '').toLowerCase();

  return db.query(`
    SELECT command FROM commands_fts
    WHERE commands_fts MATCH ?
    ORDER BY rank
    LIMIT 6
  `).all(`${token}*`)
    .map((r: any) => r.command as string);
}
```

### Búsqueda de preferencias del desarrollador

```typescript
export function findRelevantPreferences(
  db: Database,
  sessionId: string,
  context: string
): string[] {
  // Busca preferencias del dev relevantes para el contexto actual
  // Se inyectan en el Context Compiler como parte del bloque de Bee
  const prefs = db.query(`
    SELECT preference, confidence
    FROM developer_preferences
    WHERE session_id = ?
      AND active = 1
      AND confidence > 0.5
    ORDER BY confidence DESC
    LIMIT 10
  `).all(sessionId) as { preference: string; confidence: number }[];

  return prefs.map(p => p.preference);
}
```

### Mantenimiento del índice FTS5

```typescript
// Llamar periódicamente via Bun.cron para optimizar el índice
export function optimizeFts(db: Database): void {
  // Merge de segmentos fragmentados — mejora performance de búsqueda
  db.run("INSERT INTO narrative_fts(narrative_fts) VALUES('optimize')");
  db.run("INSERT INTO playbook_fts(playbook_fts) VALUES('optimize')");
  db.run("INSERT INTO skills_fts(skills_fts) VALUES('optimize')");
}

// Verificar integridad del índice (usar en doctor)
export function checkFtsIntegrity(db: Database): boolean {
  try {
    const result = db.query(
      "INSERT INTO narrative_fts(narrative_fts) VALUES('integrity-check')"
    ).run();
    return true;
  } catch {
    return false;
  }
}
```

---

## 29. CÓMO BEE LEE EL CÓDIGO — ESTRATEGIA COMPLETA

El flujo exacto que Bee debe seguir para entender código sin cargar archivos completos al contexto.

### Para entender un archivo desconocido

```
1. parse_ast(path)
   → Obtiene: imports, exports, funciones, clases, complejidad
   → Costo: bajo (Bun.Transpiler, sin LLM)
   → Resultado: mapa estructural del archivo

2. Si complejidad > umbral O archivo > 200 líneas:
   read_file(path, offset=0, limit=30)  → primeras 30 líneas (context)
   read_file(path, offset=-20, limit=20) → últimas 20 líneas (conclusión)
   → No leer el medio a menos que sea necesario

3. Para una función específica:
   search_in_files("function nombreFuncion", path)
   → Retorna: línea exacta donde está
   read_file(path, offset=lineaEncontrada-5, limit=40)
   → Lee 5 líneas de contexto antes + la función completa + margen
```

### Para entender el impacto de un cambio

```
1. find_imports(path)
   → ¿Quién importa este archivo?
   → Retorna: lista de archivos dependientes

2. Para cada archivo dependiente:
   parse_ast(dependiente)
   → ¿Qué símbolo importa del archivo que voy a cambiar?
   → ¿Necesita actualización?

3. Resultado: lista exacta de archivos afectados
   → Bee lo incluye en el arnés antes de ejecutar
```

### Para navegar un codebase desconocido

```
1. list_dir(root, recursive=true)
   → Árbol completo de archivos
   → Identificar: ¿cuáles son los archivos centrales?

2. code_graph (si ya existe en SQLite)
   → Archivos con más dependientes = más centrales
   → Empezar por los más centrales para entender el sistema

3. Si no hay code_graph todavía:
   search_in_files("export default|module.exports|export function")
   → Los archivos con más exports son los módulos principales

4. read_file de README.md si existe
   → Contexto del proyecto sin parsear código

5. Lee solo los archivos que necesita para la tarea
   → Nunca indexar todo el codebase para una tarea pequeña
```

### Para archivos grandes (>500 líneas)

```
Regla: nunca leer un archivo de >500 líneas completo.

1. parse_ast → mapa de funciones y líneas
2. grep para localizar la sección relevante
3. read_file del rango exacto con margen de ±10 líneas
4. Si necesita más contexto: expandir el rango, no leer todo
```

---

## 30. NARRACIÓN — CÓMO ESCRIBE BEE AL NARRATIVO

La calidad del narrativo determina la calidad de las sesiones futuras. Bee sigue un formato estricto.

### Formato de entrada al narrativo

```
[{AGENT_ID} — {ISO_TIMESTAMP}] [task-{ID}]

QUÉ HICE:
{descripción en lenguaje natural — específica, no genérica}
Ejemplo correcto:  "Implementé endpoint /auth/refresh con rotación
                    obligatoria de tokens. El refresh token se invalida
                    al usarse y se emite uno nuevo."
Ejemplo incorrecto: "Implementé la autenticación."

POR QUÉ ASÍ:
{justificación — referencia a decisión previa o razonamiento explícito}
Ejemplo: "Usé jose en vez de jsonwebtoken porque jsonwebtoken usa
          require() de CJS y da problemas con ESM en Bun (issue #15823
          reportado en el narrativo de 2026-04-12)."

ARCHIVOS TOCADOS:
+ src/auth/refresh.ts    (nuevo — endpoint /auth/refresh)
~ src/auth/jwt.ts        (líneas 45-67 — agregar RefreshTokenPayload)
+ migrations/0003.sql    (nueva — tabla refresh_tokens)

ENCONTRÉ:
{problemas, inconsistencias, bugs detectados — vacío si ninguno}
Ejemplo: "La interfaz TokenPayload tenía userId como number pero la DB
          lo guarda como TEXT. Corregido a string."

PENDIENTE:
{qué debe saber el próximo agente o sesión}
Ejemplo: "Los usuarios existentes con tokens bcrypt necesitan
          re-login. Documentar en el CHANGELOG antes del deploy."

[USER OVERRIDE si aplica]:
{instrucción del usuario que modificó el plan original}
```

### Reglas del narrativo

Específico siempre. "Modifiqué la autenticación" no sirve. "Modifiqué la función `verifyToken` en `middleware.ts` línea 67 para manejar tokens expirados con un error tipado `TokenExpiredError` en vez de lanzar un Error genérico" sí sirve.

El narrativo es para humanos futuros y para Bee futuro. Si no puedes entender qué se hizo leyendo solo el narrativo sin ver el código, es un narrativo malo.

Los USER OVERRIDEs son sagrados. Siempre marcados, nunca contradichos sin justificación explícita.

---

## 31. MANEJO DE TAREAS LARGAS

Las tareas que tardan más de 5 minutos necesitan tratamiento especial.

### Definición de tarea larga

Una tarea es "larga" si:
- Tiene más de 4 fases en el arnés
- Involucra más de 10 archivos
- La estimación de tokens supera 5,000
- El usuario no está activo (inactivo por más de 2 minutos)

### Estrategia para tareas largas

**Progreso visible siempre.** La barra de estado en ambas UIs muestra: fase actual / total de fases, porcentaje estimado, tiempo transcurrido, costo acumulado. El usuario que vuelve después de 10 minutos ve inmediatamente dónde está la tarea.

**Checkpoints frecuentes.** Cada fase completada escribe un recovery point en SQLite. Si la tarea se interrumpe, el usuario puede retomar desde el último checkpoint sin perder trabajo.

**Subagentes en paralelo.** Cuando las fases no tienen dependencias entre sí, Bee las despacha simultáneamente con `Promise.all`. El tiempo total se reduce significativamente.

**Interrupción suave.** El usuario puede escribir un mensaje a Bee durante la ejecución. Bee lo lee al terminar la operación atómica actual (el tool call en vuelo termina) y ajusta el plan para las fases siguientes. No cancela la tarea — la redirige.

```typescript
// En el agent loop — verificar mensajes del usuario entre tool calls
async function checkForUserInterruption(taskId: string): Promise<string | null> {
  return db.query(`
    SELECT content FROM messages
    WHERE task_id = ? AND type = 'user' AND processed = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(taskId) as string | null;
}
```

**Output file para subagentes muy largos.** Si un subagente va a tardar más de 2 minutos, escribe su progreso en SQLite cada 30 segundos. Bee puede leer ese progreso sin bloquear. Patrón inspirado en el `async_launched` de Claude Code.

---

## 32. MULTIPROYECTO

El diseño actual asume un repo por sesión. Esta sección documenta cómo escalar a múltiples proyectos sin romper la arquitectura.

### Problema

Un desarrollador trabaja en `backend/`, `frontend/`, y `shared/` como repos separados. Cuando Bee modifica una interfaz en `shared/`, necesita actualizar `backend/` y `frontend/` también. Con sesiones separadas, Bee no sabe que los tres están relacionados.

### Solución para v1.0 — worktrees

```bash
# El usuario configura los repos relacionados
hive-code project add shared ../shared
hive-code project add frontend ../frontend

# Bee puede leer/escribir en cualquier repo configurado
# usando git worktrees para aislar cambios
```

Cada repo relacionado tiene su propio contexto en el `code_graph` de SQLite. Bee puede consultar el grafo de cualquier repo configurado. Los cambios en repos relacionados se hacen en branches separadas.

### Pendiente para v2.0

Un sistema completo de proyectos vinculados con propagación automática de cambios y sincronización del narrativo entre repos. No prioritario para v1.0.

---

## 33. HIVEETUI — ROADMAP DE LA TUI PROPIA

La TUI actual usa Ratatui (Rust). El plan a largo plazo es construir HiveTUI — una TUI propia que Hive-Code controla completamente.

### Por qué HiveTUI

Con Ratatui dependemos de un proyecto externo para algo que es central a la experiencia de usuario de Hive-Code. HiveTUI es la apuesta de largo plazo de controlar completamente la capa de presentación — en términos de identidad visual, performance, y features específicas de Hive-Code que ninguna librería genérica va a implementar.

### Cuándo empezar

No antes de que v1.0 esté en producción con usuarios reales. Las decisiones de diseño de una TUI se hacen mucho mejor con feedback real de cómo los usuarios interactúan con el sistema.

### Stack de HiveTUI

Dos opciones evaluadas:

**Opción A — TypeScript puro sobre Bun.stdout**
Sin dependencias externas. ANSI escape codes directos. El sistema de render es un loop de `Bun.cron` que emite el estado completo a stdout cuando hay cambios. Simple, portable, cero deps.

Limitación: sin layout engine real. Todo el positioning es manual. Para layouts simples (el dashboard de Hive-Code) esto es manejable.

**Opción B — Fork del TypeScript de Rezi**
Los 322 archivos de TypeScript de Rezi (widgets, layout, theming, routing) sin el motor C/Rust Zireael. Reemplazar el render engine por ANSI codes directos de Bun.stdout.

Esto da acceso a `commandPalette`, `diffViewer`, `logsConsole`, `splitPane`, y `router` — todo lo que Rezi tiene bien implementado en TypeScript — sin depender del motor nativo ni del maintainer.

**Decisión:** Opción A para widgets básicos (spinners, progress, prompts). Opción B si el fork de Rezi TypeScript resulta viable después de explorar el código.

### Qué debe tener HiveTUI

Los componentes mínimos que Hive-Code necesita y que justifican tener una TUI propia:

El live feed con 🐝 animado de forma fluida. La paleta de comandos `/` con fuzzy search y preview. El visor de diffs para modo APPROVAL — ver exactamente qué líneas cambian antes de aprobar. El panel de thinking colapsable. La barra de estado con tokens/costo/modo. El prompt de texto con validación en tiempo real.

---

## 34. GLOSARIO COMPLETO

**ACE (Adaptive Codex Engine)** — sistema de aprendizaje de Hive-Code. Analiza trazas de ejecución, extrae reglas útiles al playbook, y aprende las preferencias del desarrollador. Tiene dos componentes: el Reflector (analiza) y el Curator (gestiona el playbook).

**activeForm** — texto en presente continuo que describe lo que está haciendo un agente en este momento. Declarado por el agente antes de ejecutar, no inferido por el sistema. "Analizando dependencias de jwt.ts". Aparece en el live feed junto a la 🐝.

**Agent Loop** — el ciclo fundamental de razonamiento de Bee. LLM genera respuesta → parsear bloques → ejecutar tools → agregar tool_result → repetir hasta que no haya más tool_use.

**Arnés del plan** — documento estructurado que Bee genera antes de ejecutar cualquier tarea. Contiene: reconocimiento del codebase, hipótesis interpretada, decisiones con trade-offs, contratos TypeScript, subagentes a crear, archivos estimados, riesgos, y costo estimado.

**Bee** — el coordinador central de Hive-Code. No es un agente entre muchos — es el único coordinador permanente. Todos los subagentes son creados por Bee dinámicamente según la necesidad de la tarea.

**BroadcastChannel** — mecanismo de mensajería one-to-many de Bun entre Workers. El main thread emite un evento (ej: cambio de modo) y todos los Workers lo reciben simultáneamente sin router intermediario.

**Bun.cron** — scheduling in-process de Bun. El ACE Reflector corre via cron. No requiere proceso externo. Accede directamente al pool SQLite. No hay overlap — el siguiente fire espera a que el handler anterior termine.

**Bun.Image** — pipeline nativo de procesamiento de imágenes en Bun. Sin dependencias npm. Construido sobre libjpeg-turbo, spng, libwebp. Corre off the JavaScript thread. Hive-Code lo usa para verificación visual de UI generada, diagramas, y screenshots.

**Bun.secrets** — OS keystore nativo de Bun. Las API keys de Hive-Code viven aquí. Keychain en macOS, libsecret en Linux, Windows Credential Manager en Windows. Nunca en disco, nunca en logs.

**Bun.WebView** — browser headless nativo de Bun. Hive-Code lo usa para abrir componentes de UI generados, capturar screenshots con `Bun.Image`, y correr tests E2E.

**code_graph** — tabla SQLite que contiene el grafo de dependencias del codebase. Quién importa a quién, qué símbolos exporta cada archivo. Se construye en el onboarding y se actualiza incrementalmente. Permite a Bee saber qué archivos se ven afectados por un cambio sin leer todo el codebase.

**Context Compiler** — componente que ensambla el contexto antes de cada llamada LLM. Combina: bloque ético, identidad de Bee, contexto del proyecto en formato toon, narrativo relevante (FTS5), reglas del playbook (FTS5), skills activadas (FTS5), historial de la tarea actual, y USER OVERRIDEs activos.

**edit_file** — la tool de edición principal. Implementa str_replace: reemplaza `old_string` por `new_string` en un archivo. Falla si `old_string` aparece 0 o más de 1 vez — garantizando que el cambio es quirúrgico y preciso. Nunca reescribe archivos completos.

**FTS5** — Full Text Search 5. Motor de búsqueda de texto completo de SQLite. Usa índice invertido, Porter stemmer para stemming, BM25 para ranking. Hive-Code lo usa para tres índices: narrativo, playbook, y skills.

**formato toon** — representación comprimida de código que preserva la semántica sin verbosidad. En lugar de pasar 200 líneas al LLM, el Context Compiler genera una representación estructurada con imports, exports, firmas de funciones, y relaciones. Reduce tokens 5-10x.

**HiveTUI** — nombre del proyecto de TUI propia de Hive-Code. Todavía no implementado. Reemplazará Ratatui en el largo plazo para dar control total sobre la capa de presentación.

**live feed** — panel en ambas UIs que muestra en tiempo real qué está haciendo Bee. Cada tool call genera un evento que aparece en el feed con la 🐝 animada, el `activeForm`, y el resultado colapsado.

**mandato** — la instrucción completa que Bee envía a un subagente al crearlo. Incluye: propósito, system prompt, tools disponibles, contexto compilado, y el `activeForm` para el live feed.

**narrativo** — log estructurado en prosa que registra qué hizo cada agente, por qué, y qué encontró. Persiste en SQLite entre sesiones. Es la memoria del proyecto. El ACE lo analiza para aprender. El Context Compiler lo usa para darle contexto a Bee sobre el estado del proyecto.

**playbook** — colección de reglas aprendidas por el ACE. Cada regla tiene una categoría, un confidence score, y contadores de helpful/harmful. Las reglas activas se inyectan en el Context Compiler cuando son relevantes por FTS5.

**porter unicode61** — tokenizador de FTS5. Porter aplica stemming (reduce palabras a su raíz). unicode61 da soporte correcto a caracteres no-ASCII incluyendo español (ó, á, ñ, ü).

**postMessage fast-path** — optimización de Bun para mensajes entre Workers. Para strings, Bun evita serialización. Latencia de ~500ns independiente del tamaño. 500x más rápido que Node.js para este caso.

**recovery point** — snapshot del estado completo de una tarea en un momento dado. Incluye: git ref, fases completadas, fases pendientes, último entry del narrativo. Permite retomar una tarea interrumpida sin perder trabajo.

**SharedArrayBuffer** — bloque de memoria compartida entre todos los Bun Workers sin serialización. Hive-Code lo usa para el estado de sesión: modo actual, Workers ocupados, flags de control. Solo el main thread escribe con `Atomics.store`.

**spawn_agent** — la tool que Bee usa para crear subagentes dinámicos. Recibe: propósito, system prompt, tools disponibles, contexto, si corre en paralelo, timeout, y `activeForm`. El subagente corre en su propio Bun Worker y muere al terminar.

**str_replace** — técnica de edición quirúrgica de archivos. Reemplaza un fragmento exacto y único de un archivo por otro. El fragmento debe ser único en el archivo — si aparece más de una vez, el agente debe incluir más contexto para hacer el match único.

**thinking** — razonamiento interno del LLM que ocurre antes de generar la respuesta visible. Activado con Extended Thinking de Anthropic. Los bloques `thinking` llegan en el mismo stream que los bloques `text` y `tool_use`. Hive-Code los bifurca: thinking va a SQLite y al canal WebSocket de thinking; text y tool_use van al agent loop normal.

**USER OVERRIDE** — instrucción del usuario que modifica el plan en curso. Se registra en el narrativo con máxima prioridad. Ningún agente puede contradecirla sin justificación explícita. Persiste en el narrativo para sesiones futuras.

**WAL (Write-Ahead Log)** — modo de SQLite que permite lecturas concurrentes mientras hay escrituras activas. Obligatorio en Hive-Code porque múltiples Workers leen simultáneamente mientras el main thread escribe.

---

## 35. CRITERIOS DE ACEPTACIÓN CONSOLIDADOS

Esta sección consolida los criterios de aceptación de todos los módulos en un solo lugar para facilitar el testing.

### Agent Loop

- Bee ejecuta una tarea simple (crear un archivo) en menos de 30 segundos
- Los bloques de thinking se separan correctamente de los bloques de texto
- Un fallo de LLM activa el retry con backoff exponencial
- Después de 3 reintentos fallidos, Bee notifica al usuario con el estado exacto
- El recovery point se crea antes de cada fase y permite retomar con `task resume`

### Context Compiler

- Cache hit se sirve en menos de 1ms
- Cache miss (primera compilación) tarda menos de 50ms
- El formato toon de un archivo de 200 líneas cabe en menos de 500 tokens
- Las skills se activan correctamente por FTS5 para tareas relevantes
- El bloque ético siempre está presente como primer bloque del system prompt

### Tools

- `edit_file` falla con error descriptivo si `old_string` no es único
- `read_file` con offset/limit lee solo el rango especificado
- `write_file` crea snapshot en SQLite antes de escribir (overhead < 5ms)
- `git_rollback` restaura estado exacto previo a la tarea en menos de 10 segundos
- `shell_executor` termina el proceso con SIGKILL al cumplir el timeout
- `parse_ast` retorna el mapa estructural de un archivo de 500 líneas en menos de 100ms

### Base de Datos

- Los triggers FTS5 sincronizan el índice automáticamente en insert/update/delete
- `searchNarrative` con query sin resultados exactos hace fallback a tokens OR
- WAL mode activo: verificable con `PRAGMA journal_mode`
- Recovery point se crea en menos de 10ms
- El schema completo se aplica con `db-migrate.ts` en menos de 1 segundo

### Modos de Operación

- Toggle Shift+Tab refleja el nuevo modo en la UI en menos de 200ms
- En modo PLAN ninguna tool de escritura se ejecuta (verificable por log de trazas)
- El checkpoint de APPROVAL muestra exactamente qué archivos va a tocar la siguiente fase
- USER OVERRIDE se registra en el narrativo y se respeta en la siguiente llamada a Bee

### Live Feed y UIs

- Cada tool call emite un evento BeeEvent en menos de 10ms
- La 🐝 cambia de estado correctamente según el tipo de tool
- El `activeForm` es específico (no genérico) en todos los eventos
- El thinking se muestra colapsado en la TUI y en panel separado en Vite
- El costo acumulado se actualiza en la barra de estado después de cada llamada LLM

### CLI y Comandos Internos

- `hive-code doctor` completa en menos de 5 segundos
- `hive-code init` en un proyecto nuevo de 100 archivos completa en menos de 10 segundos
- `/provider set` cambia el provider activo sin reiniciar el gateway
- El autocompletado de `/` con Tab funciona con prefijos de 2+ caracteres
- Las API keys nunca aparecen en logs ni en stdout

### Seguridad

- `shell_executor` no puede acceder a variables de entorno del host
- `edit_file` no puede escribir fuera del directorio del proyecto
- Operaciones destructivas siempre piden confirmación en los 3 modos
- Un hallazgo CRITICAL del subagente de seguridad pausa la tarea completa

### Bun.Image

- Un screenshot de 1920x1080 se optimiza a WebP < 100KB en menos de 500ms
- `fromClipboard()` retorna null en Linux sin lanzar excepción
- El pipeline completo corre off the JavaScript thread (sin bloquear el event loop)
- Los formatos HEIC/AVIF manejan `ERR_IMAGE_FORMAT_UNSUPPORTED` con fallback a WebP

### ACE

- El Reflector corre en menos de 2 segundos para lotes de 20 trazas
- Después de 3 USER OVERRIDEs del mismo tipo, el ACE extrae una preferencia con confidence > 0.6
- Las reglas del playbook con harmful_count > helpful_count se desactivan automáticamente
- El Reflector no hace overlap — el siguiente cron espera a que el anterior termine

---# Hive-Code — TDD Adendum
## Sección 36: Integración Telegram
**Versión:** 1.0.0 | **Fecha:** Mayo 2026 | **Autor:** @johpaz
**Complementa:** hive-code-tdd-v1.0.md + hive-code-tdd-continuacion.md

---

## 36. TELEGRAM — CONTROL REMOTO COMPLETO

### 36.1 Filosofía de la integración

Telegram no es un canal de notificaciones — es una segunda interfaz de control completa. La TUI y la Vite UI son las interfaces primarias cuando el desarrollador está en su máquina. Telegram es la interfaz cuando está en movimiento.

La regla fundamental: **Telegram recibe solo eventos de alta prioridad y puntos de decisión. El live feed detallado permanece en las UIs locales.**

Un mensaje de Telegram por cada tool call sería spam. Un mensaje por tarea completada, blocker encontrado, o checkpoint de aprobación es valor real.

Hive base ya tiene la infraestructura del canal Telegram — el bot, el webhook, el handler de mensajes. Hive-Code agrega encima la capa de eventos de código, los botones de control de tareas, y el formateo específico para contenido técnico.

---

### 36.2 Casos de uso

**Notificación de tarea completada**
El desarrollador lanza una tarea larga desde la terminal y sale. Telegram notifica cuando termina con resumen ejecutivo y link al PR.

**Aprobación remota de checkpoints**
En modo APPROVAL, cada checkpoint llega a Telegram con botones inline. El desarrollador aprueba, edita, salta, o cancela desde el teléfono sin volver a la terminal.

**Respuesta a blockers**
Un hallazgo CRITICAL o un error irrecuperable pausa la tarea y notifica inmediatamente. El desarrollador puede instruir a Bee desde Telegram sobre cómo proceder.

**Lanzar tareas nuevas**
Texto libre en el chat de Telegram se interpreta como nueva tarea. Bee genera el arnés y lo envía de vuelta con botones de confirmación.

**Consultar estado y narrativo**
El desarrollador puede ver el estado del sistema, el costo acumulado, las tareas recientes, y el narrativo sin abrir la terminal.

**Cambiar modo de operación**
El modo Plan/Approval/Auto se puede cambiar desde Telegram con botones — equivalente al Shift+Tab de la TUI.

---

### 36.3 Arquitectura de la integración

```
┌─────────────────────────────────────────────────────┐
│                  PROCESO PRINCIPAL (Bun)             │
│                                                      │
│  Agent Loop                                          │
│       ↓ emite TelegramEvent                          │
│  Telegram Notifier                                   │
│       ↓ formatea mensaje                             │
│  Telegram Bot API (fetch nativo de Bun)              │
│       ↓ HTTP POST                                    │
│  Telegram servers                                    │
│       ↓ entrega al usuario                           │
│  Usuario presiona botón o escribe texto              │
│       ↓ webhook HTTP → Bun.serve()                   │
│  Telegram Handler                                    │
│       ↓ parsea callback o mensaje                    │
│  Bee / Agent Loop (acción correspondiente)           │
└─────────────────────────────────────────────────────┘
```

El Telegram Notifier escucha los mismos `BeeEvent` que las UIs via el sistema de pub/sub interno. No hay acoplamiento directo con el agent loop — es un subscriber más del mismo stream de eventos.

---

### 36.4 Eventos que disparan notificaciones

```typescript
// Mapa de BeeEvent.type → acción en Telegram

const TELEGRAM_EVENT_MAP: Record<string, TelegramAction> = {

  // SIEMPRE notifica — alta prioridad
  'task_complete':    'send_completion_summary',
  'task_failed':      'send_failure_report',
  'checkpoint':       'send_approval_request',    // con botones
  'error':            'send_blocker_alert',        // si es irrecuperable
  'security_critical':'send_critical_alert',       // CRITICAL del auditor
  'cost_alert':       'send_cost_warning',         // si supera 2x estimado

  // NUNCA notifica — queda en UIs locales
  'tool_start':       null,   // demasiado frecuente
  'tool_end':         null,
  'thinking_chunk':   null,
  'narration':        null,
  'phase_start':      null,
  'phase_complete':   null,   // solo notifica task_complete
  'mode_changed':     null,
};
```

---

### 36.5 Formato de mensajes

Telegram usa su propio dialecto de Markdown (MarkdownV2). Los mensajes de Hive-Code siguen un formato consistente.

**Tarea completada:**
```
🐝 *Tarea completada*
─────────────────────
📋 "implementar refresh tokens"

⏱ 8 min 42 seg
💰 $0\.043 USD · 4,230 tokens
📁 5 archivos modificados
🌿 rama: hive\-code/task\-f3a9b2
🔗 [PR \#42 → johpaz/mi\-app](https://github.com/...)

_Resumen: Implementé endpoint /auth/refresh con rotación
obligatoria\. Migré bcrypt → argon2\. Cobertura: 87%\._
```

**Checkpoint de APPROVAL:**
```
🐝 *Checkpoint — Fase 2/4*
─────────────────────────
*Backend Coordinator* va a:

➕ `src/auth/refresh\.ts` \(nuevo\)
✏️ `src/middleware\.ts` líneas 45\-67
➕ `migrations/0003\_refresh\_tokens\.sql`

⏱ Estimado: \~800 tokens · $0\.006

[✅ Aprobar] [✏️ Editar plan] [⏭ Saltar fase] [❌ Cancelar todo]
```

**Blocker — hallazgo CRITICAL:**
```
🐝 🔴 *Alerta de seguridad*
─────────────────────────
\[CRITICAL\] `src/auth/jwt\.ts:47`

Secret hardcodeado como string literal\.
Debería venir de `Bun\.secrets`\.

La tarea está *PAUSADA*\.

[🔧 Aplicar fix] [✏️ Indicar cómo] [⏭ Ignorar] [❌ Cancelar]
```

**Tarea fallida:**
```
🐝 ❌ *Tarea fallida*
─────────────────────
📋 "implementar refresh tokens"

💥 Error en Fase 2/4 \(Backend Coordinator\)
`old\_string` no encontrado en `middleware\.ts`

Después de 3 reintentos sin éxito\.
El trabajo completado hasta la Fase 1 está guardado\.

[🔄 Reintentar desde Fase 2] [🗑 Descartar] [🔍 Ver detalle]
```

**Alerta de costo:**
```
🐝 ⚠️ *Alerta de costo*
─────────────────────
La tarea está usando más tokens de lo estimado\.

Estimado: ~1,200 tokens · $0\.009
Actual:   ~3,847 tokens · $0\.029 \(3\.2x\)

Fase actual: 2/4 \(Backend Coordinator\)

[▶️ Continuar] [⏸ Pausar y revisar] [❌ Cancelar]
```

---

### 36.6 Botones inline — callback handlers

Cada botón inline de Telegram genera un `callback_query` con un `data` string. El handler de Hive-Code lo parsea y ejecuta la acción correspondiente.

```typescript
interface TelegramCallbackData {
  action:
    | 'approve_phase'
    | 'edit_phase'
    | 'skip_phase'
    | 'cancel_task'
    | 'retry_task'
    | 'discard_task'
    | 'apply_fix'
    | 'ignore_critical'
    | 'continue_task'
    | 'pause_task'
    | 'resume_task'
    | 'change_mode'
    | 'view_harness'
    | 'view_narrative'
    | 'run_doctor'
  taskId?: string
  phaseId?: number
  mode?: 'plan' | 'approval' | 'auto'
}

// Formato del data string: JSON comprimido
// "ap|f3a9b2|2" = approve_phase, task f3a9b2, phase 2
// Limite de Telegram para callback_data: 64 bytes
```

### Mapeo de botones a acciones del agent loop

| Botón | Acción en Hive-Code |
|-------|-------------------|
| ✅ Aprobar | `approvePhase(taskId, phaseId)` — continúa la ejecución |
| ✏️ Editar plan | Abre ForceReply en Telegram — el usuario escribe su instrucción → `USER OVERRIDE` en narrativo |
| ⏭ Saltar fase | `skipPhase(taskId, phaseId)` — marca como skipped, pasa a siguiente |
| ❌ Cancelar todo | `cancelTask(taskId)` — pausa + rollback si el usuario confirma |
| 🔧 Aplicar fix | `applySecurityFix(taskId, findingId)` — Bee aplica el patch del Security Coordinator |
| ⏭ Ignorar | `acknowledgeRisk(taskId, findingId)` — registra en narrativo como riesgo aceptado |
| 🔄 Reintentar | `retryFromPhase(taskId, phaseId)` — retoma desde el último checkpoint |
| ⏸ Pausar | `pauseTask(taskId)` — pausa limpia al terminar la operación atómica actual |
| ▶️ Reanudar | `resumeTask(taskId)` — retoma desde el recovery point |

---

### 36.7 Edición del plan desde Telegram — USER OVERRIDE

Cuando el usuario pulsa **✏️ Editar plan**, Telegram activa `ForceReply` — el usuario debe responder al mensaje de Bee con su instrucción.

```
🐝 ✏️ Escribe tu instrucción para la Fase 2:
(Responde a este mensaje)

Ejemplos:
• "No toques middleware.ts, crea un archivo nuevo"
• "Usa argon2id en vez de argon2"
• "Agrega rate limiting al endpoint"
```

El texto que escribe el usuario se procesa como `TELEGRAM OVERRIDE`:

```typescript
async function handleTelegramOverride(
  taskId: string,
  phaseId: number,
  userInstruction: string
): Promise<void> {

  // Registrar en narrativo con máxima prioridad
  await appendNarrative({
    taskId,
    agentId: 'telegram',
    entry: `[TELEGRAM OVERRIDE] [task-${taskId}] [antes de FASE ${phaseId}]
El usuario instruyó via Telegram: "${userInstruction}"
Este override tiene prioridad máxima sobre el plan original.
Bee debe incorporarlo antes de ejecutar la fase.`,
    isOverride: true,
  });

  // Notificar confirmación al usuario
  await sendTelegram(`🐝 Instrucción registrada ✅

_"${userInstruction}"_

Esta instrucción se aplicará en la Fase ${phaseId}\.

[▶️ Continuar con la instrucción]`);
}
```

---

### 36.8 Lanzar tareas nuevas desde Telegram

Texto libre en el chat → nueva tarea. El flujo:

```
1. Usuario escribe: "agrega paginación al GET /users"
2. Telegram Handler detecta que no es un comando (no empieza con /)
3. Se crea una nueva Task en SQLite con status 'planning'
4. Bee inicia el reconocimiento automático del codebase
5. Bee genera el arnés del plan
6. Se envía el arnés a Telegram con botones de confirmación
7. Usuario aprueba con [▶️ Ejecutar]
8. La tarea entra al agent loop normalmente
```

**Arnés en Telegram — formato comprimido:**

```
🐝 📋 *Arnés listo*
─────────────────────
📋 "agregar paginación al GET /users"

🔍 *Hallazgos:*
• `src/routes/users\.ts` — endpoint existente sin paginación
• No hay índice en `created\_at` \(necesario\)
• 0 tests de paginación actualmente

⚙️ *Decisión:* cursor\-based pagination
\(offset pagination tiene inconsistencias con datos cambiantes\)

📁 *Archivos estimados:*
✏️ `src/routes/users\.ts` \(modificar query\)
✏️ `migrations/0004\.sql` \(índice en created\_at\)
➕ `tests/users\.pagination\.test\.ts`

💰 Estimado: ~1,800 tokens · $0\.014

[▶️ Ejecutar] [✏️ Cambiar enfoque] [❌ Cancelar]
```

Si el arnés es muy largo para un mensaje, se divide automáticamente o se envía un resumen con un botón **📋 Ver arnés completo** que abre la Vite UI en el navegador del teléfono.

---

### 36.9 Comandos de Telegram

```
/start       → Bienvenida + estado del sistema
/status      → Estado actual: proyecto, provider, modo, costo, workers
/tareas      → Lista de tareas: activas + recientes (últimas 5)
/modo        → Ver modo actual + botones para cambiarlo
/narrativo   → Últimas 5 entradas del narrativo
/buscar <q>  → Búsqueda FTS5 en el narrativo
/costo       → Costo acumulado de la sesión actual
/pausa       → Pausar la tarea en curso
/reanudar    → Reanudar tarea pausada
/cancelar    → Cancelar tarea en curso (pide confirmación)
/doctor      → Diagnóstico básico: providers, workers, GitHub
/ayuda       → Lista de comandos disponibles
```

Texto libre (sin /) → nueva tarea para Bee.

---

### 36.10 Timeout de aprobación remota

Si Bee llega a un checkpoint en modo APPROVAL y el usuario no responde en Telegram en **30 minutos**, la tarea se pausa automáticamente. No continúa ni cancela sola.

```typescript
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

async function sendCheckpointWithTimeout(
  taskId: string,
  phaseId: number,
  checkpointMessage: string,
  buttons: InlineKeyboard
): Promise<'approved' | 'edited' | 'skipped' | 'cancelled' | 'timeout'> {

  const messageId = await sendTelegram(checkpointMessage, buttons);

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      // Timeout — pausar tarea
      await pauseTask(taskId);

      await sendTelegram(`🐝 ⏸ *Tarea pausada por inactividad*

task\-${taskId} lleva 30 min esperando aprobación
de la Fase ${phaseId}/${totalPhases}\.

El trabajo completado está guardado\.
Retoma cuando quieras\.

[▶️ Retomar desde aquí] [❌ Cancelar]`);

      resolve('timeout');
    }, APPROVAL_TIMEOUT_MS);

    // El callback handler cancela el timer cuando el usuario responde
    pendingApprovals.set(`${taskId}:${phaseId}`, {
      resolve: (action) => {
        clearTimeout(timer);
        resolve(action);
      }
    });
  });
}
```

---

### 36.11 Límites y restricciones de formato

**Límite de caracteres por mensaje:** 4096. Los mensajes largos se dividen automáticamente respetando los límites semánticos — nunca en medio de un bloque de código o en medio de una palabra.

**Límite de callback_data:** 64 bytes. Los IDs de tareas y fases se comprimen: `"ap|f3a9|2"` en vez de `"approve_phase|task-f3a9b2|2"`.

**Límite de botones inline:** 8 botones máximo por mensaje (4 filas × 2 columnas). Los checkpoints de APPROVAL tienen exactamente 4 botones. Los mensajes de estado tienen máximo 3.

**Bloques de código en Telegram:** usar \`código\` para inline y \`\`\`\nbloque\n\`\`\` para multilinea. Los diffs se muestran truncados — primeras 10 líneas con "Ver más" que abre la Vite UI.

**MarkdownV2:** todos los caracteres especiales deben escaparse: `. ! ( ) [ ] { } # + - = | > ~`. El formateador de mensajes de Hive-Code escapa automáticamente antes de enviar.

---

### 36.12 Seguridad del canal Telegram

**Autenticación de usuarios.** Solo el `chat_id` configurado en `Bun.secrets` puede controlar Hive-Code via Telegram. Cualquier mensaje de otro `chat_id` es ignorado silenciosamente.

```typescript
function isTrustedUser(chatId: number): boolean {
  const trustedId = parseInt(
    await Bun.secrets.get({ service: 'hive', name: 'telegram-chat-id' }) ?? '0'
  );
  return chatId === trustedId;
}
```

**No exponer información sensible.** Los mensajes de Telegram nunca incluyen: API keys, tokens de auth, contenido completo de archivos, stack traces con paths del sistema, variables de entorno.

**Confirmación doble para acciones destructivas.** Cancelar una tarea, descartar trabajo, o ignorar un hallazgo CRITICAL requieren confirmación explícita — un segundo mensaje de confirmación antes de ejecutar.

```
🐝 ⚠️ *¿Confirmas cancelar la tarea?*

task\-f3a9b2 "implementar refresh tokens"
Fase 2/4 completada · Fases 3\-4 sin ejecutar

El trabajo de la Fase 2 *se revertirá* con rollback git\.

[✅ Sí, cancelar y revertir] [❌ No, continuar la tarea]
```

**Rate limiting.** Máximo 1 comando por segundo desde el mismo `chat_id`. Si se superan 10 mensajes en 60 segundos, el bot ignora los siguientes con un mensaje de "demasiadas solicitudes".

---

### 36.13 Configuración inicial

```bash
# Agregar el token del bot y el chat_id a Bun.secrets
hive-code secret set telegram-token
# → solicita: 110201543:AAHdqTcvCH1vGWJxfSeofSs4tQlndAtEr

hive-code secret set telegram-chat-id
# → solicita: 123456789

# Verificar conexión
hive-code telegram test
# → 🐝 Conexión exitosa · Bot: @hive_code_bot
```

O desde el onboarding wizard:

```
⬡  ¿Quieres conectar Telegram para notificaciones remotas?
│
│  ▸ Sí — configurar ahora
│  · No — saltar por ahora
│  · No — no preguntar de nuevo
```

---

### 36.14 Schema de BD para Telegram

```sql
-- Registro de mensajes enviados a Telegram
CREATE TABLE IF NOT EXISTS telegram_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL,  -- ID de Telegram
  chat_id         INTEGER NOT NULL,
  task_id         TEXT REFERENCES tasks(id),
  type            TEXT NOT NULL CHECK(type IN (
    'completion', 'failure', 'checkpoint', 'blocker',
    'critical', 'cost_alert', 'status', 'harness'
  )),
  sent_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Para checkpoints: estado de la aprobación
  approval_status TEXT CHECK(approval_status IN (
    'pending', 'approved', 'edited', 'skipped',
    'cancelled', 'timeout'
  )),
  approval_at     DATETIME,
  override_text   TEXT        -- si el usuario editó el plan
);

-- Pendientes de aprobación en vuelo
CREATE TABLE IF NOT EXISTS telegram_pending_approvals (
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  phase_id        INTEGER NOT NULL,
  message_id      INTEGER NOT NULL,  -- para editar el mensaje al aprobar
  expires_at      DATETIME NOT NULL, -- timeout de 30 min
  PRIMARY KEY(task_id, phase_id)
);
```

---

### 36.15 Criterios de aceptación — Telegram

- [ ] Solo el `chat_id` configurado puede controlar Hive-Code
- [ ] Una tarea completada envía notificación en menos de 2 segundos
- [ ] Los botones de APPROVAL funcionan correctamente desde el teléfono
- [ ] Un USER OVERRIDE via Telegram aparece en el narrativo con la marca `[TELEGRAM OVERRIDE]`
- [ ] El timeout de 30 minutos pausa la tarea automáticamente sin cancelar
- [ ] Texto libre en Telegram crea una tarea nueva con arnés
- [ ] `/status` responde en menos de 1 segundo
- [ ] Los mensajes largos se dividen respetando límites semánticos
- [ ] Los caracteres especiales de MarkdownV2 se escapan correctamente
- [ ] Un CRITICAL siempre pausa la tarea y notifica, sin importar el modo activo
- [ ] `hive-code secret set telegram-token` guarda en Bun.secrets, nunca en SQLite
- [ ] Mensajes de `chat_id` no autorizados se ignoran silenciosamente
- [ ] Acciones destructivas requieren confirmación doble

---

*Hive-Code TDD *
*@johpaz · Mayo 2026*
*"La colmena en tu bolsillo."*

