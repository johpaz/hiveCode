---
name: git_workflow
description: "Complete git workflow: status, diff, commit, push, branch management, and PR creation"
version: 1.0.0
icon: "🔀"
category: git
tools: [git_status, git_diff, git_log, git_branch, git_commit, git_blame, git_create_pr, git_rollback, shell_executor]
triggers:
  - "git"
  - "commit"
  - "push"
  - "pull"
  - "branch"
  - "rama"
  - "merge"
  - "pr"
  - "pull request"
  - "cambios"
  - "changes"
  - "version control"
  - "control de versiones"
preferred_agents: []
steps:
  - step: 1
    action: check_status
    instruction: "Check git status to see current state of the repository"
    output: repository_state
  - step: 2
    action: review_changes
    instruction: "Review changes with git diff before staging"
    output: changes_summary
  - step: 3
    action: stage_and_commit
    instruction: "Stage files and create commit with descriptive message"
    output: commit_result
  - step: 4
    action: push
    instruction: "Push changes to remote repository"
    output: push_result
rules:
  - "Always check git status first before making changes"
  - "Review diffs before committing to ensure quality"
  - "Write clear, descriptive commit messages"
  - "Ask user for commit message if not specified"
  - "Check branch before committing to ensure correct target"
output_format:
  structure: markdown
  sections:
    - "changes_summary"
    - "commit_message"
    - "files_changed"
    - "next_steps"
examples:
  - user_input: "commit y push de los cambios"
    expected_behavior: "git_status → git_diff → git_commit → confirm → push"
  - user_input: "creá una rama feature/new-feature"
    expected_behavior: "git_branch({ action: 'create', name: 'feature/new-feature' })"
---
# Git Workflow Skill

Guía completa para operaciones git: commit, branch, push, y gestión de PRs.

## Flujo Estándar de Commit

```
git_status → [analizar cambios] → git_diff → git_commit → push
```

## Buenas Prácticas

1. **Siempre empezar con git_status** para entender el estado actual
2. **Revisar diffs** antes de commit para evitar errores
3. **Commits atómicos**: un cambio lógico por commit
4. **Mensajes descriptivos**: qué y por qué, no cómo

## Ejemplos de Mensajes de Commit

| Tipo | Formato | Ejemplo |
|------|---------|---------|
| feat | `feat: descripción` | `feat: add user authentication endpoint` |
| fix | `fix: descripción` | `fix: handle null pointer in user service` |
| refactor | `refactor: descripción` | `refactor: extract email validation logic` |
| docs | `docs: descripción` | `docs: add API usage examples` |
| test | `test: descripción` | `test: add unit tests for auth middleware` |
| chore | `chore: descripción` | `chore: update dependencies` |
