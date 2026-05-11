# Git Conventions

## Branch Naming
- `hive-code/task-{uuid}` — feature branches (auto-created)
- `fix/{short-desc}` — bug fixes
- `hotfix/{short-desc}` — production fixes
- `docs/{short-desc}` — documentation only

## Commit Messages (Conventional Commits)
```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:
- `feat(auth): add JWT middleware`
- `fix(api): handle null user in /profile`
- `test(coordinator): add auto-restart test`

## PR Checklist
- [ ] Tests pass (`bun test --isolate`)
- [ ] Types check (`bun tsc --noEmit`)
- [ ] Lint clean (`bun run lint`)
- [ ] Narrative updated
- [ ] ADR linked if architecture changed

## Hive-Code Workflow
1. Architecture Coordinator designs → ADR
2. Branch: `hive-code/task-{uuid}`
3. Implementation → commits with Conventional Commits
4. Tests pass → Security review
5. DevOps Coordinator creates PR with narrative
