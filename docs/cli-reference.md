# CLI Reference

All commands are available via `hivecode <command> [options]`.

## Core commands

### `hivecode` (REPL)

Starts an interactive terminal session.

```bash
hivecode
hivecode --mode approval    # start in approval mode
hivecode --port 16120       # custom gateway port
```

Keyboard shortcuts inside the REPL:
- `Tab` — autocomplete commands (FTS5-powered, 44 commands)
- `Ctrl+P` — switch to plan mode
- `Ctrl+A` — switch to approval mode
- `Ctrl+U` — switch to auto mode
- `Ctrl+C` — cancel current task or exit

---

### `hivecode run <description>`

Runs a task and streams output to the terminal.

```bash
hivecode run "implement OAuth2 login"
hivecode run "refactor auth module" --mode approval
hivecode run "add unit tests" --quiet
```

**Flags:**
| Flag | Description |
|------|-------------|
| `--mode <plan\|approval\|auto>` | Override execution mode |
| `--approval` | Shorthand for `--mode approval` |
| `--quiet` | Suppress spinner and phase headers |
| `--exit-on-error` | Exit with code 1 on task failure (default: true) |

---

### `hivecode plan <description>`

Generates a structured plan (arnés) without executing it.

```bash
hivecode plan "migrate database to PostgreSQL"
```

Output includes:
- **RECONOCIMIENTO** — detected stack and relevant files
- **HIPÓTESIS INTERPRETADA** — what Bee understood
- **DECISIONES** — chosen approach with trade-offs
- **CONTRATOS** — TypeScript interfaces defined
- **SUBAGENTES A CREAR** — coordinators that will run
- **ARCHIVOS ESTIMADOS** — files to be created/modified
- **RIESGOS** — risk assessment (HIGH/MEDIUM/LOW)
- **ESTIMADO** — estimated tokens and time

---

### `hivecode init`

Interactive setup wizard. Safe to run multiple times.

```bash
hivecode init
```

---

### `hivecode doctor`

Checks system health: providers, gateway, workers, database.

```bash
hivecode doctor
```

---

## Task management

### `hivecode task list`

Lists recent tasks with status and timestamps.

```bash
hivecode task list
hivecode task list --limit 20
hivecode task list --status failed
```

### `hivecode task status <id>`

Shows detailed status for a single task.

```bash
hivecode task status abc123
```

### `hivecode task pause <id>`

Pauses a running task after the current phase completes.

```bash
hivecode task pause abc123
```

### `hivecode task resume <id>`

Resumes a paused task from the last recovery point.

```bash
hivecode task resume abc123
```

If file snapshots exist, you'll be prompted:
```
? ¿Restaurar archivos al estado anterior? (y/N)
```

If you confirm, files are restored to their state at the recovery point before re-running.

### `hivecode task cancel <id>`

Cancels a task immediately.

```bash
hivecode task cancel abc123
```

### `hivecode task debug <id>`

Prints the full task narrative (all coordinator entries).

```bash
hivecode task debug abc123
```

---

## Narrative and search

### `hivecode narrative <id>`

Shows the narrative log for a task.

```bash
hivecode narrative abc123
```

### `hivecode search <query>`

Full-text search across all task narratives (FTS5).

```bash
hivecode search "OAuth JWT"
hivecode search "database migration error"
```

---

## Channel management

### `hivecode telegram connect`

Connects a Telegram bot and begins listening.

```bash
hivecode telegram connect
```

### `hivecode telegram status`

Shows current Telegram connection status.

### `hivecode telegram disconnect`

Disconnects the Telegram bot.

---

## Utility

### `hivecode logs`

Streams gateway logs to the terminal.

### `hivecode cost`

Shows total token usage and estimated USD cost for the current session.

### `hivecode version`

Prints the current Hivecode version.
