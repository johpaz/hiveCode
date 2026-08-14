---
name: spec-kit
description: "Mandatory specification-driven workflow for complex features, architecture, migrations, and broad refactors"
version: 1.0.0
icon: "📐"
category: code
tools: [speckit_init, speckit_artifact_read, speckit_artifact_write, speckit_validate, speckit_tasks_sync, speckit_converge]
triggers:
  - "new feature"
  - "nueva funcionalidad"
  - "architecture"
  - "arquitectura"
  - "migration"
  - "migración"
  - "large refactor"
  - "refactor amplio"
  - "spec kit"
preferred_agents: [bee, verifier, reviewer]
steps:
  - step: 1
    action: initialize
    instruction: "Call speckit_init and keep the returned feature_dir as the durable source of truth"
  - step: 2
    action: specify
    instruction: "Resolve material ambiguities and complete spec.md with prioritized scenarios, requirements, and measurable success criteria"
  - step: 3
    action: plan
    instruction: "Complete plan.md with technical context, constitution check, concrete structure, contracts, risks, and validation strategy"
  - step: 4
    action: analyze
    instruction: "Cross-check spec and plan, record ambiguities or contradictions in analysis.md, then resolve blocking gaps"
  - step: 5
    action: approval_gate_1
    instruction: "For approval policy, stop before workspace mutation until the user accepts the specification and architecture"
  - step: 6
    action: task_dag
    instruction: "Write independently executable checkbox tasks with stable TNNN IDs, agent lane, ownership, and explicit dependencies; call speckit_tasks_sync"
  - step: 7
    action: execute
    instruction: "Activate only the profiles required by ready DAG nodes; never exceed three concurrent invocations"
  - step: 8
    action: verify_and_review
    instruction: "Verifier reproduces acceptance criteria, then Reviewer independently checks the diff and artifacts; permit at most two repair cycles"
  - step: 9
    action: converge
    instruction: "Call speckit_converge with verification evidence, review verdict, and all remaining gaps"
  - step: 10
    action: approval_gate_2
    instruction: "For approval policy, stop before integration until the user accepts the convergence report"
rules:
  - "Complex work may not mutate the workspace before spec.md and plan.md validate"
  - "Simple questions and small localized fixes bypass Spec Kit"
  - "Artifacts on disk are canonical; chat summaries are not checkpoints"
  - "Product and architecture are BEE responsibilities guided by this skill, not permanent agents"
  - "Domain expertise is loaded as a skill, not represented by a persistent agent identity"
  - "Never create more than five stable identities: BEE, Scout, Builder, Verifier, Reviewer"
  - "Never run more than three agent invocations concurrently"
  - "Verifier and Reviewer are read-only over source code"
  - "After two failed repair cycles, return control to the user with evidence and options"
output_format:
  structure: markdown
  sections:
    - "feature_dir"
    - "current_gate"
    - "ready_tasks"
    - "evidence"
    - "blockers"
---
# Spec Kit for Hive

Use Spec Kit as the durable protocol for complex work. The lifecycle is:

`constitution → specify → plan → analyze → approval 1 → tasks/DAG → implement → verify → review → converge → approval 2 → integrate`

## Task syntax

Each executable task in `tasks.md` uses:

```markdown
- [ ] T001 [scout] Map affected contracts
- [ ] T002 [builder] Implement the contract (depends: T001)
- [ ] T003 [verifier] Reproduce acceptance criteria (depends: T002)
- [ ] T004 [reviewer] Independent final review (depends: T003)
```

Use `[P]` only in the prose description if useful; actual parallelism is derived from dependencies and is capped by the harness.

## Handoffs

Every invoked profile returns a compact, self-contained handoff containing:

- status and outcome;
- evidence and paths;
- changed files, if authorized;
- commands/tests and results;
- risks, blockers, and the next recommended action.

Do not paste complete logs or repeat the full specification in a handoff.
