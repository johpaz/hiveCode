# Context Narration

## Narrative Structure (SPEC §5.1)
```
[{COORDINATOR} — {ISO_TIMESTAMP}] [{TASK_ID}] [{PHASE}]

QUÉ HICE:
{descripción de lo implementado/diseñado/revisado}

POR QUÉ:
{justificación — referencia al ADR o decisión previa}

ARCHIVOS AFECTADOS:
{lista con descripción de cada uno}

ENCONTRÉ:
{problemas, bugs, inconsistencias}

PENDIENTE:
{qué debe hacer el próximo coordinador}

USER OVERRIDE: {cambios del usuario y por qué}
```

## Rules
- Only main thread writes to narrative (serialized)
- Workers propose entries → main thread validates and writes
- Each entry has `task_id`, `coordinator`, `phase`, `timestamp`
- `USER OVERRIDE` entries have maximum priority
- Never contradict a `USER OVERRIDE` without justification

## Handoff Between Coordinators
When passing work to next phase:
1. Summarize what was done
2. List files created/modified
3. Note any blockers or issues
4. Suggest next steps
5. Reference relevant ADR sections

## Reading the Narrative
- Use `read_narrative(taskId, lastN)` for context
- Search with FTS5: `search_narrative("auth JWT")`
- Export for PR body: `narrative_export()`
