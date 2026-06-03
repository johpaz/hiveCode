---
name: narrative_logger
description: "Document work history, architectural decisions (ADRs), and retrieve full task context"
version: 1.0.0
author: Hive Team
icon: "📝"
category: narrative
permissions: []
dependencies: []
tools: [read_narrative, append_narrative, search_narrative, read_decisions, write_decision, get_task_context]

triggers:
  - "documentá lo que hiciste"
  - "document what you did"
  - "escribí el log"
  - "write the log"
  - "guardá la decisión"
  - "save decision"
  - "ADR"
  - "architecture decision"
  - "decisión arquitectural"
  - "qué se decidió"
  - "what was decided"
  - "historial de la tarea"
  - "task history"
  - "leé la narrativa"
  - "read narrative"
  - "buscá en el historial"
  - "search history"
  - "contexto completo de la tarea"
  - "full task context"

preferred_agents: []

steps:
  - step: 1
    action: choose_operation
    instruction: "Decide if reading, writing, or searching narrative/decisions"
    output: operation_type

  - step: 2
    action: execute
    instruction: "Run the appropriate narrative tool"
    output: result

rules:
  - "Use append_narrative to document significant milestones, not every small step"
  - "Use write_decision for architectural choices — context + options + decision + consequences"
  - "Use get_task_context at the start of a task to understand what was done before"
  - "Use search_narrative to find relevant past work without reading everything"
  - "Narrative entries are markdown — use headers, lists, code blocks for clarity"

output_format:
  structure: narrative_entry
  max_length: "Concise but complete — capture the WHY not just the WHAT"

examples:
  - user_input: "documentá que migramos la BD a SQLite WAL"
    expected_behavior: "append_narrative({ content: '## Migración a SQLite WAL\\n...', phase: 'database' })"

  - user_input: "guardá la decisión de usar Bun.cron en vez de Croner"
    expected_behavior: "write_decision({ title: 'Usar Bun.cron nativo', context: '...', options: [...], decision: '...', consequences: '...' })"

  - user_input: "qué pasó en la tarea del sprint 3"
    expected_behavior: "get_task_context({ taskId: '...' }) → narrativa + decisiones + snapshots"
---

# Narrative Logger Skill

## Cuándo se Activa

Para documentar trabajo realizado, registrar decisiones arquitecturales (ADRs), o recuperar el contexto completo de una tarea.

## Herramientas Disponibles

| Tool | Qué hace | Cuándo usarla |
|------|----------|---------------|
| `append_narrative` | Agrega entrada al log de trabajo | Después de completar un hito |
| `read_narrative` | Lee el historial cronológico | Al retomar una tarea pausada |
| `search_narrative` | Búsqueda FTS en el historial | Buscar decisiones o problemas pasados |
| `write_decision` | Guarda un ADR | Para decisiones arquitecturales importantes |
| `read_decisions` | Lista ADRs por estado/tarea | Revisar decisiones pasadas |
| `get_task_context` | Todo sobre una tarea: narrative + ADRs + snapshots | Al iniciar o retomar trabajo |

## Cuándo Escribir Narrativa

Escribir en `append_narrative` cuando:
- ✅ Completaste una fase significativa
- ✅ Encontraste y resolviste un problema importante
- ✅ Cambiaste de enfoque o estrategia
- ❌ NO para cada tool call individual

## Estructura de un ADR (`write_decision`)

```markdown
## Contexto
¿Por qué surgió esta decisión? ¿Qué problema resuelve?

## Opciones Evaluadas
- Opción A: pros / cons
- Opción B: pros / cons

## Decisión
Elegimos X porque...

## Consecuencias
- ✅ Beneficio 1
- ⚠️ Trade-off 1
```

## Ejemplos

### Documentar progreso
```javascript
append_narrative({
  content: "## Sprint 3 — Cron Scheduler\n\nImplementamos BunCronScheduler usando Bun.cron nativo...",
  phase: "implementation",
  coordinator: "architecture"
})
```

### Guardar decisión arquitectural
```javascript
write_decision({
  title: "Usar Bun.cron en lugar de croner library",
  context: "Necesitamos scheduling sin dependencias externas",
  options: ["croner v10", "Bun.cron nativo", "node-cron"],
  decision: "Bun.cron nativo — zero deps, ya disponible",
  consequences: "Limitación: sin DST automático. Trade-off aceptable."
})
```

### Recuperar contexto de tarea
```javascript
get_task_context({ taskId: "abc123" })
// → { narrative: [...], decisions: [...], snapshots: [...] }
```

### Buscar en historial
```javascript
search_narrative({ query: "migración base de datos" })
// → entradas relevantes con scores de relevancia
```
