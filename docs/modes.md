# Execution Modes

Hivecode supports three execution modes that control how much autonomy Bee and the coordinators have when running tasks.

## Plan mode

```bash
hivecode plan "description"
hivecode run "description" --mode plan
```

**What happens:** Bee analyzes the task and generates a structured arnés (harness document) but does **not** execute any changes. No files are written, no commands run.

**Use when:**
- You want to understand what Hivecode will do before it does it
- You're reviewing a complex refactor that touches many files
- You're onboarding and learning how Bee breaks down tasks
- You need stakeholder sign-off before proceeding

**Output:** The arnés printed to the terminal (or Telegram) — RECONOCIMIENTO, HIPÓTESIS, DECISIONES, CONTRATOS, SUBAGENTES, ARCHIVOS ESTIMADOS, RIESGOS, ESTIMADO. Run `hivecode run "same description"` to execute it.

---

## Approval mode

```bash
hivecode run "description" --mode approval
# or
hivecode run "description" --approval
```

**What happens:** Bee generates the arnés, presents it, and waits for your confirmation (`[s]í / [n]o`) before dispatching each coordinator phase. After each phase completes, you see the diff and can approve, skip, or cancel.

**Use when:**
- Production systems where each file change needs review
- Learning and auditing — you want to see every diff before it's applied
- Sensitive refactors (auth, payments, database migrations)
- You're working in a regulated environment

**Approval flow:**
1. Arnés printed → `¿Continuar con esta arquitectura? [s/N]`
2. If yes → coordinators run one phase at a time
3. After each phase → diff presented → `Aprobar / Saltar / Cancelar`
4. Telegram users get inline keyboard buttons for each approval step

**Tip:** A 30-minute timeout applies to Telegram approval requests. If no response is received, the task is cancelled automatically.

---

## Auto mode

```bash
hivecode run "description"           # auto is the default
hivecode run "description" --mode auto
```

**What happens:** Bee analyzes, plans (internally), and executes all phases without pausing for confirmation. File snapshots are saved at each recovery point so you can roll back if needed.

**Use when:**
- Routine tasks you've done before (adding tests, fixing lint, updating dependencies)
- CI/CD pipelines where human approval isn't needed
- Time-sensitive work where interruptions are costly
- You trust the task description is precise enough

**Safety:** Auto mode still creates recovery points and file snapshots after each phase. Use `hivecode task resume <id>` with file restoration if something goes wrong.

---

## Switching modes at runtime

Inside the REPL, switch modes without restarting:

| Shortcut | Mode |
|----------|------|
| `Ctrl+P` | Plan |
| `Ctrl+A` | Approval |
| `Ctrl+U` | Auto |

The mode bar in the TUI header updates immediately.

---

## Mode comparison

| Feature | Plan | Approval | Auto |
|---------|------|----------|------|
| Executes code changes | ❌ | ✅ (per phase) | ✅ |
| Shows arnés | ✅ | ✅ | ❌ |
| Pauses for confirmation | N/A | ✅ | ❌ |
| Shows diff per phase | N/A | ✅ | ❌ |
| Telegram buttons | ✅ | ✅ | ❌ |
| Recovery points | N/A | ✅ | ✅ |
| Fastest execution | ❌ | ❌ | ✅ |
| Safest for production | ✅ | ✅ | ⚠️ |
