# Herramientas Nativas — Referencia Completa

**Total: 74 herramientas** distribuidas en 9 categorías.
Todas en `packages/core/src/tools/`. Se cargan via `createAllTools()` y están disponibles en cada worker del enjambre.

> **Descubrimiento en runtime:** Usá `search_knowledge(type="tools", query="...")` para encontrar herramientas por tarea o sinónimo. El índice FTS5 soporta búsqueda bilingüe ES→EN.

---

## 1. Filesystem (8 herramientas)

`packages/core/src/tools/filesystem/`

| Herramienta | Descripción |
|-------------|-------------|
| `fs_read` | Lee contenido de archivo. Soporta `offset` y `limit` para archivos grandes |
| `fs_write` | Crea o sobreescribe un archivo completo |
| `fs_edit` | Edita secciones específicas mediante find/replace — más seguro que reescribir |
| `fs_delete` | Elimina archivo o directorio. **Requiere `confirmed: true` explícito** |
| `fs_list` | Lista archivos y directorios recursivamente |
| `fs_glob` | Busca archivos por patrones glob (`*.ts`, `src/**/*.json`) |
| `fs_exists` | Verifica si existe un archivo o directorio |
| `search_in_files` | Busca string o regex en archivos (ripgrep o grep). Retorna líneas con número |

**Patrón recomendado para archivos grandes (> 500 líneas):**
```
parse_ast → localizar símbolo → fs_read(offset, limit)
```

---

## 2. Web (11 herramientas)

`packages/core/src/tools/web/`

| Herramienta | Descripción |
|-------------|-------------|
| `web_search` | Busca en internet y retorna resultados con snippets |
| `web_fetch` | Descarga contenido de URL (liviano, sin JS). Retorna texto plano |
| `browser_navigate` | Navega a URL en browser real. Retorna árbol de accesibilidad (4-6× más barato que screenshot) |
| `browser_click` | Click en elemento por CSS selector o ARIA ID (`@e3`). Requiere sesión activa |
| `browser_type` | Escribe texto en campo de formulario. Requiere sesión activa |
| `browser_extract` | Extrae texto, links o JSON estructurado vía CSS selector. Requiere sesión activa |
| `browser_script` | Ejecuta JavaScript arbitrario en el contexto de la página. Requiere sesión activa |
| `browser_wait` | Espera a que aparezca un elemento CSS/ARIA. Requiere sesión activa |
| `browser_screenshot` | Captura screenshot del viewport (Bun.WebView → WebP 800×600) |
| `browser_capture_clipboard` | Lee imagen del portapapeles del sistema y retorna base64 WebP |
| `browser_preview_html` | Sirve HTML en servidor local temporal y captura screenshot headless |

**Cuándo usar browser vs web_fetch:**
- `web_fetch` → contenido estático, APIs, páginas sin JS
- `browser_navigate` → SPAs, autenticación, interacciones, capturas visuales

---

## 3. Cron / Scheduler (8 herramientas)

`packages/core/src/tools/cron/` — implementación: `packages/core/src/scheduler/BunCronScheduler.ts`

Todos con prefijo `cron.*`. El scheduler usa **`Bun.cron()` nativo** para tareas recurrentes y `setTimeout` para tareas one-shot. Al iniciar el gateway, se reconcilian todos los jobs `active` de la BD.

| Herramienta | Descripción |
|-------------|-------------|
| `cron.create` | Crea job recurrente (expresión cron) o one-shot (`fire_at`). Parámetros clave: `name`, `task`, `task_type`, `channel`, `timezone` |
| `cron.list` | Lista todos los jobs con próxima ejecución, estado y `run_count` |
| `cron.update` | Actualiza expresión, instrucción, canal o ventana temporal de un job activo |
| `cron.pause` | Pausa job sin eliminarlo (detiene Bun.cron, mantiene BD) |
| `cron.resume` | Reanuda job pausado (re-registra con Bun.cron) |
| `cron.delete` | Elimina job permanentemente (detiene timer + borra BD) |
| `cron.trigger` | Ejecuta job inmediatamente sin esperar su próximo horario |
| `cron.history` | Historial de ejecuciones de un job: duración, estado, errores |

### Parámetros de `cron.create`

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `name` | string | Nombre descriptivo del job |
| `task` | string | **Instrucción en lenguaje natural** que el agente ejecutará cuando dispare |
| `task_type` | `"recurring"` \| `"one_shot"` | Tipo de ejecución |
| `cron_expression` | string | Expresión cron de 5 campos (requerida si `recurring`). Ej: `"0 9 * * 1-5"` |
| `fire_at` | ISO 8601 | Fecha/hora de ejecución única (requerida si `one_shot`). Ej: `"2026-07-01T10:00:00"` |
| `timezone` | string | IANA timezone. Ej: `"America/Bogota"`. Default: `"UTC"` |
| `channel` | string | Canal para enviar el resultado: `"telegram"`, `"webchat"`, `"system"`. Default: `"system"` |
| `max_runs` | number | Límite de ejecuciones. Sin límite si se omite |
| `start_at` / `stop_at` | ISO 8601 | Ventana temporal activa del job |

### Cómo funciona la ejecución

Cuando dispara un job, el scheduler:
1. Inserta fila en `task_runs` (`status = 'running'`)
2. Pasa el `task` como mensaje al agent loop (`runner.generate`)
3. El agente procesa con todas sus herramientas y responde
4. La respuesta se envía al `channel` configurado
5. Actualiza `task_runs` (éxito/fallo, `duration_ms`)
6. Actualiza `cron_jobs` (`last_run_at`, `run_count`, `next_run_at`)

### Timezone

- La expresión cron se almacena en el timezone del usuario
- Al registrar, el campo hora se ajusta a UTC para Bun.cron
- **Limitación**: el ajuste es estático. Zonas con DST se desajustan 1h en el cambio de horario

### Ejemplos de expresiones

```
"* * * * *"        → cada minuto
"0 9 * * 1-5"      → lunes a viernes a las 9:00
"0 18 * * 5"       → viernes a las 18:00
"0 0 1 * *"        → primer día de cada mes a medianoche
"*/15 * * * *"     → cada 15 minutos
"@daily"           → todos los días a medianoche (00:00 UTC)
"@hourly"          → cada hora
```

---

## 4. CLI / Shell (1 herramienta)

`packages/core/src/tools/cli/`

| Herramienta | Descripción |
|-------------|-------------|
| `shell_executor` | Ejecuta comandos shell con timeout configurable. Soporta pipes y redirecciones. Output máx 10 MB |

> **Seguridad:** Todo comando pasa por `command-validator.ts` — ver sección al final.

---

## 5. Agents (16 herramientas)

`packages/core/src/tools/agents/`

### Memoria Persistente
| Herramienta | Descripción |
|-------------|-------------|
| `memory_write` | Guarda información con título único (persiste entre sesiones) |
| `memory_read` | Recupera entrada de memoria por título |
| `memory_list` | Lista todas las entradas de memoria |
| `memory_search` | Busca memorias por keyword (FTS5) |
| `memory_delete` | Elimina entrada de memoria específica |

### Gestión de Workers
| Herramienta | Descripción |
|-------------|-------------|
| `get_available_models` | Consulta providers y modelos activos. **Llamar antes de `agent_create`** para elegir `providerId` + `modelId` |
| `agent_create` | Crea worker especializado. Requiere `providerId` + `modelId` de `get_available_models` |
| `agent_find` | Busca workers existentes por nombre o descripción |
| `agent_archive` | Archiva/termina un worker |

### Delegación de Tareas
| Herramienta | Descripción |
|-------------|-------------|
| `task_delegate` | Delega tarea a worker existente (bloqueante, retorna resultado) |
| `task_delegate_code` | Delega tarea de código a subagente CLI (Qwen / Claude Code / Gemini CLI / OpenCode) |
| `task_status` | Estado de ejecución de tareas delegadas |
| `spawn_agent` | Crea subagente efímero, ejecuta con contexto propio, evalúa resultado y destruye (con reintentos) |

### Bus de Agentes
| Herramienta | Descripción |
|-------------|-------------|
| `bus_publish` | Publica mensaje al Agent Bus (comunicación worker→worker) |
| `bus_read` | Lee mensajes no leídos del Agent Bus |
| `project_updates` | Obtiene actualizaciones de estado de workers del mismo proyecto |

---

## 6. Code / Git (18 herramientas)

`packages/core/src/tools/code/`

### Git (8 herramientas)
| Herramienta | Descripción |
|-------------|-------------|
| `git_status` | Estado del working tree: cambiados, staged, untracked |
| `git_diff` | Cambios en working tree o entre commits. Soporta `--cached` y ramas |
| `git_log` | Historial de commits con metadata |
| `git_branch` | Lista, crea, elimina y cambia branches |
| `git_commit` | Stagea archivos y crea commit |
| `git_blame` | Autoría por línea de código |
| `git_create_pr` | Crea Pull Request en GitHub via API |
| `git_rollback` | Restaura archivos a estado pre-tarea desde snapshots |

### Análisis y Build (10 herramientas)
| Herramienta | Descripción |
|-------------|-------------|
| `code_search` | Ripgrep con líneas de contexto |
| `code_build` | Auto-detecta y ejecuta build (npm / bun / cargo / make) |
| `code_test` | Ejecuta tests auto-detectando el framework |
| `code_test_parallel` | Corre múltiples suites concurrentemente y agrega resultados |
| `code_lint` | Ejecuta linter (ESLint / Ruff) con auto-fix opcional |
| `code_diff_create` | Genera diff unificado entre dos archivos o versiones |
| `parse_ast` | Analiza AST TypeScript/JavaScript: imports, exports, funciones, complejidad ciclomática |
| `find_imports` | Encuentra todos los archivos que importan un módulo dado (grafo inverso via `code_graph`) |
| `check_types` | TypeScript type-check (`bun tsc --noEmit`). Retorna errores, warnings y duración |
| `run_script` | Ejecuta archivo TS/JS en subproceso aislado (timeout 60s) |

---

## 7. Core / Utilidades (5 herramientas)

`packages/core/src/tools/core/`

| Herramienta | Descripción |
|-------------|-------------|
| `search_knowledge` | FTS5 sobre tools, skills, playbook, MCP y código fuente. Bilingüe ES→EN. Tipos: `tools`, `skills`, `playbook`, `code`, `all` |
| `get_project_context` | Resumen cacheado de la estructura del proyecto: módulos clave, archivos críticos, ADRs activos. Más rápido que `fs_list` recursivo |
| `notify` | Envía notificación al canal activo del usuario (Telegram, webchat, etc.) |
| `save_note` | Guarda nota en scratchpad que sobrevive compresión de contexto |
| `report_progress` | Reporta porcentaje + mensaje al usuario y actualiza la BD de tareas |

---

## 8. Narrative / Decisiones (6 herramientas)

`packages/core/src/tools/narrative/`

Historia de trabajo y registro de decisiones arquitecturales (ADRs).

| Herramienta | Descripción |
|-------------|-------------|
| `read_narrative` | Lee entradas narrativas de la sesión/tarea en orden cronológico |
| `append_narrative` | Agrega entrada al log narrativo en markdown (`is_draft` opcional) |
| `search_narrative` | Búsqueda FTS sobre el historial con scores de relevancia |
| `read_decisions` | Lista ADRs por estado o tarea |
| `write_decision` | Guarda ADR con contexto, opciones evaluadas, decisión y consecuencias |
| `get_task_context` | Contexto completo de tarea: narrativa + decisiones + snapshots de archivos |

---

## 9. API (1 herramienta)

`packages/core/src/tools/api/`

| Herramienta | Descripción |
|-------------|-------------|
| `api_request` | Cliente HTTP para REST APIs. Control completo: método, headers, body, auth. Similar a curl |

---

## Validator de Comandos

`packages/core/src/tools/code/command-validator.ts`

Antes de cualquier ejecución shell, evalúa 5 preguntas:
1. ¿El path escapa el workspace del proyecto?
2. ¿Accede a secrets del entorno host?
3. ¿Contiene patrones destructivos?
4. ¿Descarga y pipe-ejecuta scripts de internet?
5. ¿Requiere privilegios root?

### Siempre bloqueados (sin excepción)

| Patrón | Razón |
|--------|-------|
| `rm -rf /`, `rm -rf ~/` | Delete del filesystem raíz u home |
| `mkfs`, `dd of=/dev/sd*` | Formateo de disco |
| `:(){ :|:& };:` | Fork bomb |
| `curl \| bash/sh/zsh` | Pipe de internet a shell |
| `wget -O- \|` | Pipe de internet a shell |
| `eval $(curl ...)` | Eval de script remoto |
| `python -c "...exec..."` | Ejecución arbitraria Python |
| `node -e "...require..."` | Ejecución arbitraria Node |
| `eval(...)`, `new Function(...)` | Eval de código arbitrario JS |
| `su -` | Escalada de privilegios |
| `chmod *7*` | Permisos de escritura mundial |
| `chown root` | Cambio de ownership a root |
| `/etc/passwd`, `shadow`, `sudoers` | Acceso a archivos de credenciales |
| `/proc/`, `/sys/kernel` | Acceso a filesystems del kernel |
| `Bun.secrets` | Acceso al keystore de secrets de Bun |
| `process.env.*KEY\|SECRET\|TOKEN` | Acceso a secrets de entorno |
| `curl $(cat ...)`, `base64 \| curl` | Exfiltración de datos |

### Siempre requieren confirmación del usuario

`DROP TABLE`, `rm`, push a `main`/`master`, `git push --force`, `bun add`, `npm install`, escritura en `.env`, `sudo`, `chmod 777`, `truncate`
