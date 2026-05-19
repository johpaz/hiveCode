# Recovery, Pause & Resume

Hivecode saves recovery points throughout task execution so you can pause, resume, or roll back without losing work.

## How recovery works

Before each coordinator phase runs, Hivecode saves a **recovery point** to the database containing:

- `git_ref` — the current git commit hash (if in a git repo)
- `completed_phases` — list of phase IDs already finished
- `pending_phases` — list of phase IDs still to run
- `last_narrative_id` — how far the narrative log has progressed

Additionally, **file snapshots** are saved whenever a coordinator writes or modifies a file. These snapshots store the file path and full content at the moment of change.

---

## Pausing a task

```bash
hivecode task pause <task-id>
```

Sets the task status to `paused` after the current phase finishes. The coordinator won't start the next phase. You can find the task ID from `hivecode task list`.

Inside the REPL, `Ctrl+C` while a task is running will also trigger a graceful pause.

---

## Resuming a task

```bash
hivecode task resume <task-id>
```

This command:

1. Finds the most recent recovery point for the task
2. Displays what was completed and what's still pending:
   ```
   ✅ Completadas: 2 fases
   ⏳ Pendientes: 3 fases
   📍 Git ref: a3f9c12
   ```
3. If file snapshots exist, prompts:
   ```
   ? ¿Restaurar archivos al estado anterior? (y/N)
   ```
4. If you confirm, all snapshotted files are restored to their state at the recovery point
5. The task status changes back to `running` and execution continues from where it left off

---

## Rolling back files manually

If you need to restore files without resuming the task:

```bash
# Find the task ID
hivecode task list

# View the recovery point details
hivecode task debug <task-id>
```

Or query the database directly:

```sql
-- See all recovery points for a task
SELECT id, git_ref, completed_phases, pending_phases, created_at
FROM code_recovery_points
WHERE task_id = 'your-task-id'
ORDER BY id DESC;

-- See all file snapshots for a task
SELECT file_path, length(content) as size, created_at
FROM code_file_snapshots
WHERE task_id = 'your-task-id';
```

To restore a specific file from a snapshot:

```bash
# Using hivecode task resume (restores all snapshots)
hivecode task resume <task-id>

# Or manually via SQLite
sqlite3 ~/.hive/hive.db "SELECT content FROM code_file_snapshots WHERE task_id='<id>' AND file_path='src/auth.ts'" > src/auth.ts
```

---

## Git-based rollback

If the task was running in a git repository, each recovery point stores the `git_ref` at that moment. You can roll back to that exact state:

```bash
# Find the git ref from the recovery point
hivecode task debug <task-id>

# Roll back git state (CAUTION: this discards uncommitted changes)
git reset --hard <git-ref>
```

Combine this with file snapshot restoration for a complete rollback.

---

## Cancelling a task

```bash
hivecode task cancel <task-id>
```

Stops the task immediately. The task status changes to `cancelled`. Recovery points and snapshots are preserved so you can inspect what was done.

---

## Telegram integration

From Telegram, use:

- `/pausa` — pause the active task
- `/reanudar` — resume the most recently paused task (prompts for file restoration)
- `/cancelar` — cancel with confirmation inline keyboard

In approval mode, Telegram sends an approval request message with inline buttons after each phase:
- **✅ Aprobar** — continue to the next phase
- **⏭ Saltar fase** — skip this phase and continue
- **❌ Cancelar tarea** — cancel the entire task

A 30-minute timeout applies to each approval request.

---

## Recovery point database schema

```sql
CREATE TABLE code_recovery_points (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL REFERENCES code_tasks(id),
  phase_id          INTEGER REFERENCES code_task_phases(id),
  git_ref           TEXT,
  completed_phases  TEXT DEFAULT '[]',   -- JSON array of phase IDs
  pending_phases    TEXT DEFAULT '[]',   -- JSON array of phase IDs
  last_narrative_id INTEGER,
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```
