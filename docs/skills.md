# Skills

Una skill es una guía en Markdown que se carga **bajo demanda** en el contexto de un agente y le enseña a usar un conjunto de herramientas o un procedimiento. No concede permisos: las herramientas siguen limitadas por el perfil y por el modo.

Código en `packages/skills`. Skills empaquetadas en `src/bundled/`; guías de código adicionales en `src/code/*.md`.

## Formato

Un directorio con un `SKILL.md`: frontmatter YAML y cuerpo.

```markdown
---
name: spec-kit
description: "Flujo obligatorio guiado por especificación para features complejas"
version: 1.0.0
icon: "📐"
category: code
tools: [speckit_init, speckit_artifact_read, speckit_artifact_write, speckit_validate, speckit_tasks_sync, speckit_converge]
triggers:
  - "new feature"
  - "arquitectura"
preferred_agents: [bee, planner, verifier]
steps:
  - step: 1
    action: initialize
    instruction: "Llama speckit_init y conserva feature_dir como fuente de verdad"
---
Cuerpo en Markdown: criterios, ejemplos, errores frecuentes.
```

| Campo | Uso |
|-------|-----|
| `name`, `description` | Identificación. La descripción es lo que se indexa para descubrirla. |
| `tools` | Herramientas que documenta. El *loadout* deriva las skills de las herramientas presentes. |
| `triggers` | Frases que sugieren la skill. |
| `preferred_agents` | Perfiles para los que aplica. |
| `steps` | Procedimiento ordenado (`step`, `action`, `instruction`, `output?`, `params?`). |
| `category`, `version`, `icon` | Organización. |

El límite de tamaño por skill es `skills.maxSkillSizeKB` (256 KB por defecto).

## Carga

`SkillLoader` (`loader.ts`) combina cuatro orígenes; el último gana si hay nombres repetidos:

1. **Empaquetadas** (`bundled/`). En el binario distribuido se leen de `bundled-data.generated.ts`, que genera `bun packages/skills/scripts/generate-bundle.ts` (parte de `bun run build`); en desarrollo sin generar, se escanea el sistema de archivos.
2. **Gestionadas**: `~/.hivecode/skills` (`skills.managedDir`).
3. **Extra**: `skills.extraDirs` y `HIVE_SKILL_DIRS`.
4. **Del workspace**: `<proyecto>/skills/`.

`skills.allowBundled` limita cuáles de las empaquetadas se activan. Con `skills.hotReload` se recargan al cambiar el disco.

## Selección en ejecución

`agent/skill-selector.ts` sincroniza las skills a un índice (`syncSkillsToIndex`) y elige cuáles entran en el prompt de cada turno (`selectSkills`; `getMinimalSkills` para el arranque). El conjunto mínimo se deriva del de herramientas (`minimal-loadout.ts`), así una skill sobre herramientas no cargadas no gasta contexto. Cuando el modelo descubre una herramienta con `search_knowledge`, su skill se añade con ella. Cada perfil declara las suyas en `agent-profiles.ts` (`skills`) y `REQUIRED_PROFILE_SKILLS` en `specialties.ts` fija las imprescindibles.

## Skills empaquetadas

| Categoría | Skills |
|-----------|--------|
| `code` | `spec-kit`, `code_analysis`, `code_security_audit`, `test_driven_development` |
| `codebridge` | `code_generate`, `code_debug`, `code_refactor`, `code_review` |
| `agents` | `task_orchestrator`, `agent_spawner`, `code_delegator`, `memory_manager`, `research_and_remember` |
| `filesystem` | `file_manager`, `file_read_and_summarize`, `file_writer` |
| `git` | `git_workflow` |
| `cli` | `cli_safe_exec`, `cli_pipeline` |
| `web` | `web_research`, `browser_automate`, `browser_scrape`, `web_monitor` |
| `search_knowledge` | `busqueda_hivedb`, `busqueda_fts5` |
| `api` | `api_client` |
| `narrative` | `narrative_logger` |
| `cron_manager`, `cron_reminder` | Programación y recordatorios |
| `office`, `meeting`, `voice` | Documentos, transcripción y voz |
| `core` | `agent_utilities` |

Las guías de `src/code/` (`typescript_strict`, `test_strategy`, `clean_architecture`, `security_owasp`, `git_conventions`, `rest_api_design`, `async_error_handling`, `bun_native_apis`, `react_patterns`, `sql_query_optimization`, `dockerfile_best_practices`, `context_narration`) son material de referencia para el proyecto, en Markdown plano.

## Gestión

- TUI: `F2` → pestaña **Skills** (activar/desactivar con `Espacio`, información con `Enter`, `A` para añadir).
- Comandos: `/skill list|enable|disable|info|add`; CLI `hivecode skill …`.

## Crear una skill

1. Crea `<dir>/<nombre>/SKILL.md` con el frontmatter anterior en `~/.hivecode/skills` (para ti) o en `<proyecto>/skills/` (para el repo).
2. Lista en `tools` las herramientas reales; una skill que cite herramientas inexistentes confunde al modelo.
3. Escribe el cuerpo corto y operativo: cuándo usarla, pasos, comprobaciones, errores típicos.
4. Para empaquetarla en hivecode, ponla en `packages/skills/src/bundled/<categoría>/<nombre>/` y ejecuta el generador del bundle.
