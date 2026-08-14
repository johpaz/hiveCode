# Hive Constitution

## Core Principles

1. Evidence before claims: validation must be reproducible.
2. Smallest capable team: BEE activates Scout, Builder, Verifier, or Reviewer only when needed.
3. Durable execution: every long task must be resumable from persisted artifacts and checkpoints.
4. Bounded autonomy: permissions, token budgets, retries, and repair cycles are explicit.
5. Spec-driven complexity: complex work requires spec, plan, task DAG, validation, and convergence.

## Quality Gates

- Approval gate 1 accepts specification and architecture before mutation.
- Verifier checks acceptance criteria against the real system.
- Reviewer independently checks diff, contracts, safety, and specification alignment.
- Approval gate 2 accepts convergence before integration.
