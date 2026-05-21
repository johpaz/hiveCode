 Plan de Implementación — hiveCode TDD v2.0

 Principio de orden

 Core → Datos → Agentes → Coordinación → IPC → TUI → UI web → Telegram

 Cada fase produce algo funcionando antes de la siguiente. El TUI y la UI son las últimas porque dependen de todo lo anterior.

 ---
 FASE 1 — Database foundation (1 semana)

 Objetivo: Schema SQLite completo del TDD en packages/core/src/db/

 Tareas

 1. Crear directorio packages/core/src/db/ con estructura:
 db/
 ├── client.ts          # cliente SQLite Bun nativo, WAL mode
 ├── schema.ts          # source of truth de tablas
 ├── migrations/
 │   ├── 001_initial.sql        # sessions, messages
 │   ├── 002_agent_context.sql  # blackboard + FTS5
 │   └── 003_checkpoints.sql    # checkpoints + checkpoint_files
 └── repos/
     ├── sessions.ts
     ├── messages.ts
     ├── agent-context.ts
     ├── agent-conflicts.ts
     ├── agent-awareness.ts
     ├── checkpoints.ts
     ├── adrs.ts
     └── file-risks.ts
 2. Implementar schema completo de §5 del TDD con los fixes:
   - Bug C fix: bee_awareness VIEW incluye aa.session_id en SELECT
   - Bug D fix: comentario en agent_awareness PRIMARY KEY sobre extensibilidad
   - Tablas: sessions, messages, agent_context (+ FTS5), agent_conflicts, agent_awareness, checkpoints, checkpoint_files, adrs (+ FTS5), file_risks, worker_activity
 3. Migrar el schema actual de packages/core/src/storage/ al nuevo layout (sin romper)
 4. Tests: tests/database/schema-v2.test.ts

 Archivos a crear/modificar:
 - packages/core/src/db/ (nuevo)
 - packages/core/src/storage/ → adaptar o reemplazar progresivamente
 - packages/core/src/index.ts → exportar db

 ---
 FASE 2 — Blackboard + Agent Context Layer (1 semana)

 Objetivo: El cerebro compartido entre Bee y workers funcionando.

 Tareas

 1. packages/code/src/context/blackboard.ts — clase Blackboard:
   - write(), readRelevant(), supersede(), beeAwareness(), askWorker()
   - FTS5 search via agent_context_fts
   - Query helper: SELECT * FROM bee_awareness WHERE session_id = ?
 2. packages/code/src/context/conflict-detector.ts — clase ConflictDetector:
   - Bug A fix: constructor recibe private ipc: IpcServer
   - checkBeforeWrite(): detecta file_collision y adr_violation
   - Persiste conflictos en agent_conflicts
 3. Actualizar packages/code/src/workers/base.ts — BaseWorker:
   - Agregar safeWrite() con flujo: read blackboard → check conflicts → register → execute → confirm
   - Agregar think() que escribe en blackboard + emite ReasoningChunk via IPC
 4. Tests: tests/blackboard/blackboard.test.ts, tests/blackboard/conflict-detector.test.ts

 Archivos a crear:
 - packages/code/src/context/blackboard.ts
 - packages/code/src/context/conflict-detector.ts
 - packages/code/src/workers/base.ts (actualizar)

 ---
 FASE 3 — Checkpoint & Rollback (1 semana)

 Objetivo: Rollback funcional en < 3 segundos.

 Tareas

 1. packages/code/src/checkpoint/manager.ts — clase CheckpointManager:
   - Bug B fix: usar Bun.zstdCompressSync() / Bun.zstdDecompressSync()
   - Bug E fix: dos loops separados en create():
       - Loop 1: archivos existentes → operation: 'modified'
     - Loop 2: filesToCreate: string[] → operation: 'created', content vacío
   - Firma: create(description, filePaths, filesToCreate, createdBy): Promise<string>
   - rollback(): restaura por operation (created→delete, modified→restore, deleted→restore)
 2. packages/code/src/checkpoint/snapshot.ts — helper de snapshot por archivo
 3. packages/code/src/checkpoint/rollback.ts — lógica de restauración
 4. Integrar con workers: llamar create() antes de cualquier safeWrite()
 5. Emitir CheckpointCreated y RollbackComplete via IPC
 6. Tests: tests/checkpoint/checkpoint.test.ts

 Archivos a crear:
 - packages/code/src/checkpoint/manager.ts
 - packages/code/src/checkpoint/snapshot.ts
 - packages/code/src/checkpoint/rollback.ts

 ---
 FASE 4 — ADR System (3-4 días)

 Objetivo: Bee lee ADRs, cruza archivos y calcula riesgo antes de actuar.

 Tareas

 1. packages/code/src/adr/loader.ts:
   - Escanea adrs/ del proyecto
   - Indexa en tabla adrs con FTS5 (adrs_fts)
   - Re-carga si detecta cambio (via mtime)
 2. packages/code/src/adr/analyzer.ts:
   - Cruza file_path con ADRs relevantes via FTS5
   - Retorna AdrMatch[] con relevancia
 3. packages/code/src/adr/risk.ts:
   - Calcula RiskLevel (low/medium/high/critical)
   - Escribe en file_risks
   - Emite FileRiskUpdate via IPC
 4. Integrar en BaseWorker.safeWrite(): calcular riesgo antes de escribir

 Archivos a crear:
 - packages/code/src/adr/loader.ts
 - packages/code/src/adr/analyzer.ts
 - packages/code/src/adr/risk.ts

 ---
 FASE 5 — Refactor del Coordinador (1.5 semanas)

 Objetivo: Partir coordinator-manager.ts monolítico en módulos según el TDD.

 Tareas

 1. Crear estructura en packages/code/src/coordinator/:
   - base.ts — clase base abstracta con acceso a blackboard + ipc + checkpoint
   - bee.ts — lógica de Bee: lee awareness, detecta conflictos, despacha workers
   - manager.ts — CoordinatorManager: lifecycle de workers, parseo de decisiones
 2. Extraer lógica de coordinator-manager.ts sin cambiar comportamiento externo:
   - parseBeeDecision() → coordinator/manager.ts
   - repairJson() → util compartido
   - Scribe/narrative → mantener en narrative/scribe.ts
 3. Integrar blackboard + conflict-detector + checkpoint en el flujo de cada worker
 4. Modos:
   - modes/plan.ts — bloquea tool calls de escritura
   - modes/approval.ts — espera /approve
   - modes/auto.ts — ejecución autónoma
 5. Mantener API pública compatible con repl.ts (sin cambiar la interfaz externa)

 Archivos a refactorizar:
 - packages/code/src/workers/coordinator-manager.ts → dividir en coordinator/
 - packages/code/src/coordinator/ (nuevo)
 - packages/code/src/modes/ (expandir)

 ---
 FASE 6 — Protocolo IPC (3-4 días)

 Objetivo: Envelope con prioridad + canales separados crítico/normal/low.

 Decisión de transporte

 El TDD propone Unix Domain Socket. El código actual usa stdout/stdin pipe.
 Opciones:
 - A (recomendada): Migrar a Unix socket para poder usar biased select! en Rust limpiamente
 - B: Mantener pipe pero agregar envelope + prioridad al parsing actual

 Tareas (opción A)

 1. packages/core/src/ipc/server.ts — Unix socket NDJSON server
 2. packages/core/src/ipc/protocol.ts — tipos TypeScript de BunMessage + TuiMessage
 3. packages/core/src/ipc/envelope.ts — IpcEnvelope { priority, seq, type, payload }
 4. Actualizar packages/tui/src/ipc.rs — conectar a Unix socket, tres canales mpsc
 5. Actualizar packages/cli/src/tui-launcher.ts — pasar HIVECODE_IPC socket path
 6. Bug F fix: cambiar Init.agent_count: u32 → Init.workers: Vec<String> en Rust y TS

 Archivos a crear/modificar:
 - packages/core/src/ipc/ (nuevo)
 - packages/tui/src/ipc.rs (actualizar)
 - packages/cli/src/tui-launcher.ts (actualizar)

 ---
 FASE 7 — TUI: Refactor de estado y renderer (2 semanas)

 Objetivo: Partir app.rs monolítico en state/ + renderer/ + commands.rs.

 Tareas

 1. Crear módulos de estado en packages/tui/src/state/:
 state/
 ├── mod.rs          # AppState completo (§9.3 del TDD)
 ├── session.rs      # SessionState + apply_update()
 ├── input.rs        # InputState con cursor UTF-8
 ├── history.rs      # HistoryState (ya existe como widget, migrar)
 ├── thought.rs      # ThoughtStreamState
 ├── workers.rs      # WorkerState
 ├── filemap.rs      # FileMapState
 ├── checkpoint.rs   # CheckpointState + push() + selected_id()
 ├── adr.rs          # AdrState
 ├── modal.rs        # ModalState
 ├── logs.rs         # LogState
 └── dirty.rs        # DirtyFlags + any() + clear()
 2. Crear packages/tui/src/renderer/:
 renderer/
 ├── mod.rs      # render() + selección de layout
 ├── plan.rs     # Layout::Plan
 ├── code.rs     # Layout::Code
 ├── review.rs   # Layout::Review
 ├── focus.rs    # Layout::Focus
 └── dashboard.rs # Layout::Dashboard
 3. Crear packages/tui/src/commands.rs — dispatch() para slash commands (§9.7)
 4. Mover lógica de app.rs a los módulos correspondientes
 5. app.rs queda como el event loop puro (tokio::select! biased, §9.4)

 Archivos a crear:
 - packages/tui/src/state/ (nuevo)
 - packages/tui/src/renderer/ (nuevo)
 - packages/tui/src/commands.rs (nuevo)
 - packages/tui/src/app.rs (simplificar)
 - packages/tui/src/ipc/ (nuevo, si se usa Unix socket)

 ---
 FASE 8 — TUI: Widgets faltantes (1 semana)

 Objetivo: Los 6 widgets que el TDD define y que aún no existen.

 ┌────────────────┬───────────────────────────┬────────────────────────┐
 │     Widget     │          Archivo          │    Datos de entrada    │
 ├────────────────┼───────────────────────────┼────────────────────────┤
 │ thought_stream │ widgets/thought_stream.rs │ ThoughtStreamState     │
 ├────────────────┼───────────────────────────┼────────────────────────┤
 │ workers_panel  │ widgets/workers_panel.rs  │ WorkerState            │
 ├────────────────┼───────────────────────────┼────────────────────────┤
 │ file_map       │ widgets/file_map.rs       │ FileMapState           │
 ├────────────────┼───────────────────────────┼────────────────────────┤
 │ diff_view      │ widgets/diff_view.rs      │ diff activo del worker │
 ├────────────────┼───────────────────────────┼────────────────────────┤
 │ adr_viewer     │ widgets/adr_viewer.rs     │ AdrState               │
 ├────────────────┼───────────────────────────┼────────────────────────┤
 │ conflict_alert │ widgets/conflict_alert.rs │ ConflictState          │
 └────────────────┴───────────────────────────┴────────────────────────┘

 Widgets a actualizar (existen, adaptar a nuevo estado):
 - widgets/checkpoint_bar.rs → usar CheckpointState.push() / selected_id()
 - widgets/input.rs → asegurar scroll horizontal correcto (§9.5)
 - widgets/history.rs → scrollbar lateral (§9.5)

 ---
 FASE 9 — UI Web: hive-ui (1 semana)

 Objetivo: Conectar hive-ui (React + Vite + @xyflow/react) al gateway de hiveCode.

 Tareas

 1. Definir WebSocket o SSE endpoint en packages/core/src/gateway/http.ts
 2. Mostrar workers activos, file risk map, checkpoint timeline en React
 3. Recibir BunMessage via WebSocket y actualizar store (Zustand o Context)
 4. Lectura única — no requiere TUI activo

 ---
 FASE 10 — Telegram (3-4 días)

 Objetivo: Canal Telegram como interfaz alternativa al CLI.

 Tareas

 1. Revisar packages/core/src/channels/ — integración existente
 2. Mapear comandos: /start, /halt, /rollback, /status al CoordinatorManager
 3. Emitir updates de workers y checkpoints como mensajes Telegram
 4. No requiere TUI — usa el mismo gateway

 ---
 FASE 11 — Pulido y release (1 semana)

 - Tests unitarios: InputState, CheckpointState, SessionState, Blackboard
 - cargo clippy -- -D warnings sin advertencias
 - Binario TUI < 8 MB en release
 - Demo mode (--demo): datos mock para onboarding
 - cargo test + bun test pasan
 - Documentar HIVECODE.md format (§H pendiente del TDD)

 ---
 Resumen de plazos estimados

 ┌──────────────────┬────────────────┬───────────────┐
 │       Fase       │    Duración    │ Bloqueada por │
 ├──────────────────┼────────────────┼───────────────┤
 │ 1 — DB schema    │ 1 sem          │ —             │
 ├──────────────────┼────────────────┼───────────────┤
 │ 2 — Blackboard   │ 1 sem          │ Fase 1        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 3 — Checkpoint   │ 1 sem          │ Fase 1        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 4 — ADR system   │ 3-4 días       │ Fase 1        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 5 — Coordinador  │ 1.5 sem        │ Fases 2, 3, 4 │
 ├──────────────────┼────────────────┼───────────────┤
 │ 6 — IPC          │ 3-4 días       │ Fase 5        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 7 — TUI refactor │ 2 sem          │ Fase 6        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 8 — TUI widgets  │ 1 sem          │ Fase 7        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 9 — hive-ui      │ 1 sem          │ Fase 5        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 10 — Telegram    │ 3-4 días       │ Fase 5        │
 ├──────────────────┼────────────────┼───────────────┤
 │ 11 — Pulido      │ 1 sem          │ Todas         │
 ├──────────────────┼────────────────┼───────────────┤
 │ Total            │ ~10-11 semanas │               │
 └──────────────────┴────────────────┴───────────────┘

 ---
 Archivos críticos

 ┌────────────────────────────────────────────────┬─────────────────────────────┐
 │                    Archivo                     │            Fase             │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/core/src/db/schema.ts                 │ 1                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/code/src/context/blackboard.ts        │ 2                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/code/src/context/conflict-detector.ts │ 2                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/code/src/checkpoint/manager.ts        │ 3                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/code/src/adr/loader.ts                │ 4                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/code/src/coordinator/manager.ts       │ 5                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/core/src/ipc/server.ts                │ 6                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/tui/src/state/mod.rs                  │ 7                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/tui/src/renderer/mod.rs               │ 7                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ packages/tui/src/commands.rs                   │ 7                           │
 ├────────────────────────────────────────────────┼─────────────────────────────┤
 │ hiveCode-TDD-v2.md                             │ Correcciones bugs A-F + G-L │
 └────────────────────────────────────────────────┴─────────────────────────────┘
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌