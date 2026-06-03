---
name: agent_utilities
description: "Core agent utilities: ephemeral subagents, progress reporting, persistent notes, and project context"
version: 1.0.0
author: Hive Team
icon: "⚙️"
category: core
permissions: []
dependencies: []
tools: [spawn_agent, save_note, report_progress, get_project_context]

triggers:
  - "crear subagente"
  - "create subagent"
  - "agente efímero"
  - "ephemeral agent"
  - "subagente dinámico"
  - "guardá una nota"
  - "save a note"
  - "reportá el progreso"
  - "report progress"
  - "cuánto llevamos"
  - "how far along"
  - "contexto del proyecto"
  - "project context"
  - "estructura del proyecto"
  - "project structure"
  - "spawn"
  - "delegar subtarea"
  - "delegate subtask"

preferred_agents: []

steps:
  - step: 1
    action: choose_tool
    instruction: "Select tool based on need: spawn_agent for subtasks, save_note for persistence, report_progress for user updates, get_project_context for orientation"
    output: tool_selected

rules:
  - "Use spawn_agent for isolated subtasks that need their own context — not for simple tool calls"
  - "Use save_note for info that must survive context compression (> 50% context used)"
  - "Use report_progress every time a significant milestone completes"
  - "Call get_project_context at the start of a session instead of recursive fs_list"
  - "spawn_agent includes automatic retries and semantic evaluation — trust its result"

output_format:
  structure: utility_result
  max_length: "Brief confirmation of action taken"

examples:
  - user_input: "analizá este módulo en paralelo mientras yo termino otra cosa"
    expected_behavior: "spawn_agent({ task: 'Analyze module X and return summary', tools: ['fs_read', 'parse_ast'] })"

  - user_input: "guardá que la BD usa WAL mode para contextos futuros"
    expected_behavior: "save_note({ title: 'SQLite WAL mode', content: 'La BD usa WAL pragmas para performance...' })"

  - user_input: "reportá que completamos el 60%"
    expected_behavior: "report_progress({ percentage: 60, message: 'Completado: schema + tools. Pendiente: tests + deploy' })"
---

# Agent Utilities Skill

## Cuándo se Activa

Para tareas de infraestructura del agente: crear subagentes, persistir notas, reportar avance al usuario, y orientarse en el proyecto.

## Herramientas Disponibles

| Tool | Qué hace | Cuándo usarla |
|------|----------|---------------|
| `spawn_agent` | Subagente efímero con contexto propio, auto-destruye | Subtareas aisladas que no deben contaminar el contexto principal |
| `save_note` | Nota persistente en scratchpad (sobrevive compresión) | Información crítica que debe recordarse entre turns |
| `report_progress` | Reporta porcentaje + mensaje al usuario | En cada hito significativo de una tarea larga |
| `get_project_context` | Resumen cacheado del proyecto (estructura, módulos, ADRs) | Al inicio de cada sesión o tarea nueva |

## `spawn_agent` — Subagente Efímero

```javascript
spawn_agent({
  task: "Analizar el módulo de autenticación y listar todos los endpoints expuestos",
  tools: ["fs_read", "parse_ast", "code_search"],
  model: "claude-sonnet-4-6",   // opcional
  max_iterations: 5,             // opcional
})
// → { result: "...", success: true, iterations: 3 }
```

**Cuándo usar spawn_agent vs task_delegate:**
- `spawn_agent` → subtarea puntual, no necesita worker persistente, incluye reintentos automáticos
- `task_delegate` → worker especializado ya creado, tarea compleja de larga duración

## `save_note` — Nota Persistente

```javascript
save_note({
  title: "Decisión: usar Bun.cron nativo",
  content: "Decidimos no usar croner porque Bun.cron es suficiente y zero-deps. Ver ADR-042."
})
```

**Cuándo usar save_note vs memory_write:**
- `save_note` → nota rápida del turno actual, scratchpad temporal
- `memory_write` → conocimiento a largo plazo que debe persistir entre sesiones

## `report_progress` — Progreso al Usuario

```javascript
report_progress({ percentage: 75, message: "Completados: schema, tools, skills. Pendiente: tests" })
```

Llamar en cada hito: 25%, 50%, 75%, 100%.

## `get_project_context` — Orientarse en el Proyecto

```javascript
get_project_context()
// → { structure: {...}, key_files: [...], modules: [...], active_adrs: [...] }
```

**Siempre llamar al inicio** de una tarea nueva en lugar de hacer `fs_list` recursivo — es 10x más rápido por ser cacheado.
