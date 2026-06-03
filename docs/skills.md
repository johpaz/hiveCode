# Skills — Referencia Completa

Los skills son bundles ejecutables con system prompt, herramientas y triggers. Viven en `packages/skills/src/bundled/` y se regeneran con `bun packages/skills/scripts/generate-bundle.ts`.

**Total: 32 skills activos** distribuidos en 10 categorías.

> **Descubrimiento en runtime:** `search_knowledge(type="skills", query="...")` para encontrar el skill adecuado a cada tarea.

---

## Skill Mínimo (siempre disponible)

El agente arranca con este skill disponible sin búsqueda previa:

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `busqueda_fts5` | `search_knowledge` | **Sistema central de descubrimiento** — cómo encontrar tools, skills, MCP y playbook |

---

## Agents (5 skills)

Gestión de workers y coordinación multi-agente.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `agent_spawner` | `get_available_models`, `find_agent`, `create_agent`, `archive_agent` | Crear y gestionar workers especializados. Siempre buscar antes de crear |
| `code_delegator` | `task_delegate_code`, `task_status`, `codebridge_launch`, `codebridge_status` | Delegar código a subagentes CLI (Qwen, Claude, Gemini, OpenCode) |
| `memory_manager` | `memory_write/read/list/search/delete` | Ciclo completo de memoria persistente |
| `research_and_remember` | `web_search`, `web_fetch`, `memory_write` | Investigar en web y guardar hallazgos |
| `task_orchestrator` | `get_available_models`, `task_delegate`, `task_status`, `agent_find/create`, `bus_publish/read` | Coordinar múltiples workers con delegación y tracking |

**Flujo típico `agent_spawner`:**
```
find_agent → existe? reusar : get_available_models → create_agent
```

---

## CLI (2 skills)

Ejecución de comandos shell.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `cli_pipeline` | `exec`, `terminal`, `project_write` | Ejecutar comandos y pipe output a archivos |
| `cli_safe_exec` | `exec`, `terminal` | Ejecutar comandos con manejo de errores, timeout y validación |

---

## Codebridge (5 skills)

Generación y mejora de código via subagentes CLI externos.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `code_debug` | `codebridge_launch/status`, `fs_read`, `fs_edit`, `cli_exec` | Debug y corrección de errores con subagentes CLI |
| `code_generate` | `codebridge_launch/status`, `fs_write`, `fs_read` | Generar código nuevo desde cero |
| `code_refactor` | `codebridge_launch/status`, `fs_read`, `fs_edit`, `fs_write` | Refactorizar código para calidad y performance |
| `code_review` | `codebridge_launch/status`, `fs_read` | Revisar calidad de código e identificar issues |
| `code_security_audit` | `code_search`, `fs_read`, `code_lint`, `cli_exec`, `web_search` | Auditoría de seguridad: vulnerabilidades, secrets hardcodeados, inyección |

---

## Code (2 skills)

Flujos de desarrollo directos (sin subagentes externos).

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `test_driven_development` | `code_test`, `code_search`, `fs_read`, `fs_write`, `fs_edit` | Ciclo TDD: rojo→verde→refactor con enfoque test-first |
| `git_workflow` | `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`, `cli_exec` | Flujo git completo: status, diff, commit, push, branches, PR |

---

## Cron (2 skills)

Programación de tareas y recordatorios.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `cron_manager` | `cron.create/list/update/delete/pause/resume/trigger/history` | Gestión completa de cron jobs (8 herramientas) |
| `cron_reminder` | `cron.create`, `notify` | Programar recordatorio one-shot con notificación |

---

## Filesystem (3 skills)

Operaciones sobre archivos del workspace.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `file_manager` | `fs_list`, `fs_glob`, `fs_exists` | Explorar estructura del proyecto y localizar archivos |
| `file_read_and_summarize` | `fs_read` | Leer y entender contenido de archivos con resumen automático |
| `file_writer` | `fs_read`, `fs_write`, `fs_edit`, `fs_exists` | Crear, modificar y eliminar archivos con operaciones seguras |

---

## Meeting (1 skill)

Transcripción y documentación de reuniones.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `meeting_transcription` | `meeting_start/add_segment/stop/report`, `office_escribir_docx`, `notify`, `report_progress` | Transcribir reuniones en tiempo real y generar informes gerenciales con decisiones y action items |

---

## Office (1 skill)

Documentos Office (PDF, Word, Excel, PowerPoint).

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `office_document_manager` | `office_leer/escribir_pdf/docx/xlsx/pptx` | Leer, crear y manipular archivos Office desde el workspace |

---

## Projects (3 skills)

Gestión de proyectos y tareas.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `project_planner` | `project_create`, `task_create` | Crear proyectos con tareas estructuradas y asignación de workers |
| `project_tracker` | `project_list`, `project_update`, `task_update` | Seguir progreso y actualizar estado de tareas |
| `project_closer` | `task_evaluate`, `project_done`, `project_fail` | Evaluar resultados y cerrar proyectos con resúmenes |

---

## Voice (3 skills)

Entrada y salida de audio.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `voice_assistant` | `voice_transcribe`, `voice_speak` | Interacción voz-a-voz completa (STT + procesamiento + TTS) |
| `voice_input` | `voice_transcribe` | Transcribir audio a texto (Groq Whisper, OpenAI Whisper) |
| `voice_output` | `voice_speak` | Convertir texto a voz sintetizada (ElevenLabs, OpenAI TTS, Gemini TTS) |

---

## Web (4 skills)

Investigación y automatización web.

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `web_research` | `web_search`, `web_fetch` | Buscar y sintetizar información de múltiples fuentes |
| `web_monitor` | `web_search`, `web_fetch`, `memory_write`, `memory_read` | Monitorear cambios en fuentes web con tracking persistente |
| `browser_automate` | `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot` | Automatizar flujos web con clicks, formularios y verificación visual |
| `browser_scrape` | `browser_navigate`, `browser_screenshot`, `web_fetch` | Capturar contenido de páginas dinámicas (SPA, JS-heavy) |

---

## Agregar un Skill Nuevo

1. Crear directorio `packages/skills/src/bundled/<categoria>/<nombre>/SKILL.md`
2. El SKILL.md debe tener frontmatter con `name`, `description`, `category`, `tools`, `triggers`
3. Regenerar: `bun packages/skills/scripts/generate-bundle.ts`
4. El skill queda disponible via `search_knowledge` en el próximo inicio

**Estructura mínima de SKILL.md:**
```markdown
---
name: mi_skill
description: "Qué hace este skill en una línea"
version: 1.0.0
category: <categoria>
tools: [herramienta1, herramienta2]
triggers:
  - "frase que activa este skill"
  - "otra frase trigger"
---

# Mi Skill
## Cuándo se Activa
## Herramientas
## Workflow
```
