# Skills — Referencia Completa

Los skills son bundles ejecutables con system prompt, herramientas y triggers. Hay dos fuentes:

- **Bundled** — viven en `packages/skills/src/bundled/`, se regeneran con `bun packages/skills/scripts/generate-bundle.ts`
- **Globales** — instalados en el PC (`~/.claude/skills/`, `~/.agents/skills/` o `HIVE_SKILL_DIRS`), se cargan automáticamente al arrancar el gateway

**Total actual: 33 bundled + 31 globales = 64 skills**

> **Descubrimiento en runtime:** `search_knowledge(type="skills", query="...")` busca sobre todos los skills activos (bundled + globales) usando FTS5.

---

## Skills Mínimos (siempre disponibles)

El agente arranca con estos skills sin necesidad de búsqueda:

| Skill | Propósito |
|-------|-----------|
| `busqueda_fts5` | **Sistema central de descubrimiento** — cómo encontrar tools, skills, MCP y playbook |
| `memory_manager` | Gestión de memoria persistente entre sesiones |
| `task_orchestrator` | Coordinación de workers y delegación |

---

## Skills Bundled (33)

### Agents (5 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `agent_spawner` | `get_available_models`, `agent_find`, `agent_create`, `agent_archive` | Crear y gestionar workers especializados. Siempre buscar antes de crear |
| `code_delegator` | `task_delegate_code`, `task_status` | Delegar código a subagentes CLI (Qwen, Claude, Gemini, OpenCode) |
| `memory_manager` | `memory_write/read/list/search/delete` | Ciclo completo de memoria persistente |
| `research_and_remember` | `web_search`, `web_fetch`, `memory_write` | Investigar en web y guardar hallazgos |
| `task_orchestrator` | `get_available_models`, `task_delegate`, `task_status`, `agent_find/create`, `bus_publish/read`, `project_updates` | Coordinar múltiples workers con delegación y tracking |

### CLI (2 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `cli_pipeline` | `shell_executor`, `fs_write` | Ejecutar comandos y pipe output a archivos |
| `cli_safe_exec` | `shell_executor` | Ejecutar comandos con manejo de errores, timeout y validación |

### Codebridge (4 skills)

Generación y mejora de código via `task_delegate_code` (Qwen, Claude, Gemini, OpenCode).

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `code_debug` | `task_delegate_code`, `task_status`, `fs_read`, `fs_edit`, `shell_executor` | Debug y corrección de errores con subagentes CLI |
| `code_generate` | `task_delegate_code`, `task_status`, `fs_write`, `fs_read` | Generar código nuevo desde cero |
| `code_refactor` | `task_delegate_code`, `task_status`, `fs_read`, `fs_edit`, `fs_write` | Refactorizar código para calidad y performance |
| `code_review` | `task_delegate_code`, `task_status`, `fs_read` | Revisar calidad de código e identificar issues |

### Code (3 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `code_analysis` | `parse_ast`, `find_imports`, `check_types`, `code_diff_create`, `code_test_parallel`, `run_script` | Análisis profundo: AST, dependencias inversas, typecheck, diffs, scripts |
| `code_security_audit` | `code_search`, `fs_read`, `code_lint`, `shell_executor`, `web_search` | Auditoría: vulnerabilidades, secrets hardcodeados, inyección |
| `test_driven_development` | `code_test`, `code_build`, `code_search`, `fs_read`, `fs_write`, `fs_edit` | Ciclo TDD: rojo→verde→refactor |

### Core (2 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `agent_utilities` | `spawn_agent`, `save_note`, `report_progress`, `get_project_context` | Subagentes efímeros, notas persistentes, progreso y contexto del proyecto |
| `busqueda_fts5` | `search_knowledge` | Cómo descubrir tools, skills, MCP y código con FTS5 |

### Cron (2 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `cron_manager` | `cron.create/list/update/delete/pause/resume/trigger/history` | Gestión completa de cron jobs (8 herramientas) |
| `cron_reminder` | `cron.create`, `notify` | Programar recordatorio one-shot con notificación |

### API (1 skill)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `api_client` | `api_request` | Cliente HTTP para REST APIs, webhooks y servicios externos |

### Filesystem (3 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `file_manager` | `fs_list`, `fs_glob`, `fs_exists`, `search_in_files` | Explorar estructura y localizar archivos |
| `file_read_and_summarize` | `fs_read`, `fs_exists` | Leer y entender archivos con resumen automático |
| `file_writer` | `fs_read`, `fs_write`, `fs_edit`, `fs_exists`, `fs_delete` | Crear, modificar y eliminar archivos |

### Git (1 skill)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `git_workflow` | `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`, `git_blame`, `git_create_pr`, `git_rollback`, `shell_executor` | Flujo git completo: status, diff, commit, blame, PR y rollback |

### Meeting (1 skill)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `meeting_transcription` | `meeting_start/add_segment/stop/report`, `office_escribir_docx`, `notify`, `report_progress` | Transcribir reuniones y generar informes con decisiones y action items |

### Narrative (1 skill)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `narrative_logger` | `read_narrative`, `append_narrative`, `search_narrative`, `read_decisions`, `write_decision`, `get_task_context` | Log de trabajo + ADRs (Architecture Decision Records) |

### Office (1 skill)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `office_document_manager` | `office_leer/escribir_pdf/docx/xlsx/pptx` | Leer, crear y manipular archivos Office |

### Voice (3 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `voice_assistant` | `voice_transcribe`, `voice_speak` | Interacción voz-a-voz completa (STT + TTS) |
| `voice_input` | `voice_transcribe` | Transcribir audio a texto (Groq Whisper, OpenAI Whisper) |
| `voice_output` | `voice_speak` | Texto a voz (ElevenLabs, OpenAI TTS, Gemini TTS) |

### Web (4 skills)

| Skill | Herramientas | Propósito |
|-------|-------------|-----------|
| `web_research` | `web_search`, `web_fetch` | Buscar y sintetizar información de múltiples fuentes |
| `web_monitor` | `web_search`, `web_fetch`, `memory_write`, `memory_read` | Monitorear cambios en fuentes web |
| `browser_automate` | `browser_navigate/click/type/screenshot/extract/script/wait/capture_clipboard/preview_html` | Automatizar flujos web completos |
| `browser_scrape` | `browser_navigate`, `browser_screenshot`, `web_fetch` | Capturar contenido de páginas dinámicas |

---

## Skills Globales (31 instalados en este PC)

Los skills instalados globalmente en `~/.agents/skills/` (enlazados como `~/.claude/skills/`) se cargan automáticamente al arrancar el gateway. Son skills de propósito general, no específicos de este proyecto.

| Skill | Propósito |
|-------|-----------|
| `a2ui` | Protocolo A2UI v0.9 para UIs interactivas ricas |
| `api-design-principles` | Principios REST y GraphQL para APIs escalables |
| `brainstorming` | Exploración de intent y diseño antes de implementar |
| `bun-development` | Desarrollo moderno con runtime Bun (packages, bundling, testing) |
| `changelog-generator` | Generación de changelogs estructurados |
| `elysiajs` | Backend con ElysiaJS — framework type-safe de alto rendimiento para Bun |
| `error-handling-patterns` | Patrones robustos de manejo de errores |
| `expo-api-routes` | API routes en Expo Router con EAS Hosting |
| `expo-dev-client` | Build y distribución de clientes Expo |
| `expo-tailwind-setup` | Configuración de Tailwind en Expo |
| `find-skills` | Cómo descubrir skills disponibles |
| `frontend-design` | Interfaces frontend de alta calidad, production-grade |
| `game-engine` | Desarrollo de motores de juego |
| `github-actions-templates` | Templates de CI/CD con GitHub Actions |
| `godot-gdscript-patterns` | Patrones GDScript para Godot |
| `google-gemini-embeddings` | Embeddings con Google Gemini |
| `google-gemini-file-search` | Búsqueda de archivos con Gemini |
| `langchain-architecture` | Arquitectura de aplicaciones LangChain |
| `mcp-builder` | Construcción de servidores MCP |
| `opentui` | TUIs con OpenTUI (API imperativa, React, Solid) |
| `react-flow` | Diagramas y flujos con React Flow |
| `shadcn-ui` | Componentes shadcn/ui |
| `systematic-debugging` | Debugging sistemático antes de proponer fixes |
| `tailwind-design-system` | Sistema de diseño con Tailwind |
| `threejs` | Three.js — escenas 3D, cámaras, renderer |
| `threejs-animation` | Animaciones Three.js (keyframe, skeletal, morph) |
| `threejs-fundamentals` | Fundamentos Three.js |
| `threejs-game` | Three.js para juegos |
| `vercel-react-best-practices` | Mejores prácticas React en Vercel |
| `vercel-react-native-skills` | React Native en Vercel |
| `zustand-state-management` | State management con Zustand |

### Cómo funciona la carga

Al arrancar el gateway (`packages/core/src/gateway/initializer.ts`), `SkillLoader.loadAllSkills()` escanea en orden de prioridad (última fuente gana si hay nombre repetido):

```
1. Bundled    — packages/skills/src/bundled/       (incluidos en el repo)
2. Managed    — ~/.hivecode/skills/                 (instalados por el usuario)
3. Extra dirs — ~/.claude/skills/ + HIVE_SKILL_DIRS (globales del PC)
4. Workspace  — ./skills/                           (específicos del proyecto)
```

Después de cargar, hace `INSERT OR REPLACE` en la tabla `skills` de SQLite y `syncSkillsToFTS()` re-indexa todo → disponibles via `search_knowledge`.

### Paths por plataforma

| Plataforma | Dirs escaneados automáticamente |
|-----------|--------------------------------|
| **Linux** | `~/.claude/skills/`, `~/.agents/skills/` |
| **macOS** | `~/.claude/skills/`, `~/.agents/skills/` |
| **Windows** | `%APPDATA%\Claude\skills\`, `%USERPROFILE%\.claude\skills\` |

### Dirs custom con variable de entorno

```bash
# Linux/macOS (separador ":")
HIVE_SKILL_DIRS=/mis/skills:/otro/dir bun run dev

# Windows (separador ";")
set HIVE_SKILL_DIRS=C:\mis\skills;D:\otro\dir
```

---

## Cómo Agregar un Skill

### Bundled (parte del repo)
1. Crear `packages/skills/src/bundled/<categoria>/<nombre>/SKILL.md`
2. Regenerar: `bun packages/skills/scripts/generate-bundle.ts`
3. Disponible al próximo inicio

### Global (todos los proyectos HiveCode del PC)
1. Crear `~/.hivecode/skills/<nombre>/SKILL.md`
2. Reiniciar el gateway — se carga automáticamente

### Workspace (solo este proyecto)
1. Crear `./skills/<nombre>/SKILL.md` en la raíz del proyecto
2. Reiniciar el gateway

### Formato mínimo de SKILL.md

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
## Ejemplos
```

> Los skills globales (`~/.claude/skills/`) solo necesitan `name` y `description` en el frontmatter — el body markdown completo es suficiente para que el agente los descubra y use correctamente via FTS5.
