# Agent Harness

## Operating model

hiveCode has five stable agent identities:

| Profile | Responsibility | Source mutations |
|---|---|---|
| BEE | User-facing lead, objective owner, planning and orchestration | Spec Kit artifacts only |
| Scout | Focused exploration and research | No |
| Builder | General implementation of one bounded DAG node | Workspace only |
| Verifier | Reproduce acceptance criteria against the real system | No |
| Reviewer | Independent final quality, security and contract gate | No |

Backend, frontend, security, data, DevOps, product and architecture are skills, not persistent identities. Product definition and architecture belong to BEE under the mandatory `spec-kit` skill.

## Startup and activation

Startup initializes storage, the five profiles and the coordinator runtime. It creates no agent worker and no tool worker. A profile is activated only when a ready task needs it. Heavy tool workers are also lazy and capped at three.

The global model-invocation ceiling is three. It applies even if a dependency level contains more ready nodes.

## Routing

- Conversation: BEE responds directly.
- Small localized change: BEE delegates one bounded task to Builder; Spec Kit is skipped.
- Feature, architecture, migration or broad refactor: the Spec Kit lifecycle is mandatory.

Complex work follows:

```text
BEE + Spec Kit
  → specify
  → plan
  → analyze
  → approval gate 1
  → task DAG
  → Scout/Builder on ready nodes (max 3)
  → Verifier
  → repair, at most 2 cycles
  → Reviewer
  → converge
  → approval gate 2
  → integrate
```

In approval policy, gate 1 occurs before implementation mutation and gate 2 before integration.

## Native Spec Kit

Spec Kit is bundled as a Hive skill and native tool category. It does not depend on an external CLI or vendored repository.

| Tool | Contract |
|---|---|
| `speckit_init` | Creates constitution, spec, plan and tasks artifacts |
| `speckit_artifact_read` | Reads one canonical artifact |
| `speckit_artifact_write` | Atomically writes one canonical artifact |
| `speckit_validate` | Validates required stages and unresolved gaps |
| `speckit_tasks_sync` | Converts checkbox tasks and dependencies into durable jobs |
| `speckit_converge` | Records verification, review and remaining gaps |

Canonical files live under `.specify/memory/constitution.md` and `specs/<feature>/`. Chat summaries are not checkpoints.

## Durability and budgets

`agentRuns`, `harnessTasks`, `jobQueue` and `toolRuns` hold resumable execution state. Each profile can configure provider, model, fallback, effort, turns, input/output token limits, cost ceiling and additional user instructions. Identity, base prompt, permissions, tools and required skills are immutable contracts.

The loop checkpoints periodically, records a compact final handoff, detects repeated identical tool calls and stops as `needs_budget` when a configured token boundary is reached. A primary-provider failure may switch once to the configured fallback.

Worktrees, exact-file leases and checkpoints remain the mutation-safety layer. Recovery is a harness policy; it is not a permanently running Forensic agent. Memory distillation is deterministic/post-task; it is not a permanently running Librarian.

## Configuration

The TUI Settings hub includes an **Agentes** tab. Select a profile and press Enter to edit safe operational settings. The CLI equivalent is:

```bash
hivecode agent configure builder \
  --provider=anthropic \
  --model=claude-sonnet-4-6 \
  --effort=high \
  --max-turns=30 \
  --max-input-tokens=120000 \
  --max-output-tokens=16000
```

`hivecode agent edit <profile>` edits only user-owned additional instructions; it never replaces the core prompt.

## Legacy compatibility

The specialized Bun worker files remain temporarily for recovery of existing sessions and compatibility with persisted legacy plans. They are no longer eagerly started: `CoordinatorManager.startAll()` creates zero workers, `dispatchPhase()` activates a required compatibility worker on demand, and execution is capped at three. New profile contracts and SDD artifacts live in `packages/core`.
