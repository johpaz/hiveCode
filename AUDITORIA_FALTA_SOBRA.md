# Hive-Code — Auditoría: ¿Qué nos falta y qué nos sobra?

**Fecha:** 2026-05-11 · **Auditor post-Sprint 5**

---

## PARTE 1: LO QUE FALTA 🔴

### 1.1 Bugs críticos o funcionalidad rota

| # | Problema | Archivo | Impacto |
|---|----------|---------|---------|
| **1** | ~~`@clack/core` v1.3.0 NO tiene `createPrompt`~~ ✅ **FALSO POSITIVO** — Sí usa `TextPrompt`/`SelectPrompt` clases correctamente | `theme.ts` | ~~ALTO~~ ✅ **OK** |
| **2** | ~~Workers `.worker.ts` usan `import.meta.url` con `new URL()`~~ ✅ **FIXED** — Build ahora emite workers como entry points separados; `coordinator-manager` detecta `.ts` vs `.js` | `coordinator-manager.ts`, `package.json` | ~~CRÍTICO~~ ✅ **OK** |
| **3** | ~~`fs_delete` tool requiere `confirmed: true`~~ ✅ **FALSO POSITIVO** — La tool `fs_delete` no existe en el codebase; `confirmed` solo está en `git_rollback` | — | ~~ALTO~~ ✅ **OK** |
| **4** | ~~Narrative Scribe usa `crypto.randomUUID()` (v4)~~ ✅ **FIXED** — Cambiado a `Bun.randomUUIDv7()` en `scribe.ts` y `coordinator-manager.ts` | `scribe.ts`, `coordinator-manager.ts` | ~~MEDIO~~ ✅ **OK** |
| **5** | ~~Snapshot usa `Bun.CryptoHasher.hash("sha256", content)`~~ ✅ **FIXED** — Cambiado a `new Bun.CryptoHasher("sha256").update(content).digest("hex")` | `coordinator-manager.ts` | ~~ALTO~~ ✅ **OK** |
| **6** | ~~`git_create_pr` tool usa `Bun.password.hash`~~ ✅ **FIXED** — Eliminada línea absurda que hacía hash de empty string | `packages/core/src/tools/code/index.ts` | ~~MEDIO~~ ✅ **OK** |
| **7** | ~~Context Compiler Cache L1 (`context/cache.ts`)~~ ✅ **DELETED** — Archivo eliminado. Nadie lo consumía. | `cache.ts` | ~~ALTO~~ ✅ **ELIMINADO** |
| **8** | ~~`@johpaz/hive-code-core/agent/llm-client` no expone `callLLM`~~ ✅ **VERIFICADO** — `callLLM` existe en `core/src/agent/llm-client.ts:127` | `worker-handler.ts` | ~~DESCONOCIDO~~ ✅ **OK** |
| **9** | **Sub-agent worker usa `import { callLLM }`** | `subagent.worker.ts` | **MEDIO** — Cada worker bundle (1.69 MB) incluye todo el core. Verificar en runtime. |
| **10** | ~~WebSocket streaming (`task-streaming.ts`)~~ ✅ **DOCUMENTED** — Agregado comentario explicando que el gateway no tiene endpoint consumidor. No es un bug, es una feature pendiente. | `task-streaming.ts` | ~~MEDIO~~ ✅ **DOCUMENTADO** |

### 1.2 Funcionalidad del SPEC no implementada

| # | Feature | SPEC | Estado |
|---|---------|------|--------|
| **11** | **Ethics rules inyectadas en system prompt** | §15: "Context Compiler inyecta siempre las reglas de ética en el primer bloque del system prompt" | ❌ No implementado |
| **12** | **Traces escritas en `code_traces`** | §3.9: `Bun.nanoseconds()` para medir latencia de cada tool call | ❌ Tabla existe, pero no se escribe |
| **13** | **ACE Reflector para código** | §5.2: "ACE Reflector analiza el narrativo para detectar patrones de éxito y fallo" | ❌ No implementado |
| **14** | **Playbook (`code_playbook`) integrado con ACE** | §9: Tabla existe pero sin lógica | ❌ No implementado |
| **15** | **`shell_executor` con sandbox estricto** | §3.4: `cwd: directorioAisladoPorTarea`, `env: entornoMínimo` | 🟡 Implementado parcialmente (timeout sí, sandbox no) |
| **16** | **Tests de integración** | — | ❌ Ningún test |
| **17** | **NPM package `@johpaz/hive-code`** | §11: `postinstall` descarga binario | ❌ No implementado |
| **18** | **`hive-code upgrade` reemplaza binario** | §15: "Reemplaza el binario actual sin perder datos" | ❌ Solo verifica versión, no reemplaza |
| **19** | **`Bun.Transpiler` en `parse_ast`** | §3.9 | 🟢 Ya implementado en core |
| **20** | **`get_task_context` como tool ejecutable** | §7.5 | 🟢 Implementado en narrative tools |

### 1.3 Stubs / No-op que deben ser reales

| # | Stub | Ubicación | Qué debería hacer |
|---|------|-----------|-------------------|
| **21** | `Bun.WebView` verification | `webview-utils.ts` | Ahora retorna "no disponible" siempre. Debería usar `Bun.WebView` real cuando esté disponible. |
| **22** | `task resume` | `extras.ts:144-176` | Solo cambia status a 'running'. No reanuda realmente la ejecución del coordinador. |
| **23** | `provider test` | `provider.ts:174-215` | Hace fetch a `/v1/models` sin autenticación. Siempre fallará. |
| **24** | `mcp test` | `mcp.ts:120-148` | Solo hace GET. No verifica tools realmente. |
| **25** | `agent edit` | `agent.ts:120-144` | Abre `$EDITOR` pero no valida que el prompt nuevo compile o sea válido. |
| **26** | `mode history` | `extras.ts:17-54` | Lectura simple de DB. No muestra cambios en tiempo real ni integra con UI. |
| **27** | `github whoami` | `index.ts` | No implementado en commands/github.ts |
| **28** | `task rollback` | `extras.ts:56-95` | Usa tool `git_rollback` pero el parámetro `taskId` no se valida contra DB. |

---

## PARTE 2: LO QUE SOBRA 🗑️

### 2.1 Código huérfano (no se usa)

| # | Archivo | Líneas | Por qué sobra |
|---|---------|--------|---------------|
| **1** | ~~`packages/code/src/context/cache.ts`~~ ✅ **DELETED** | ~~85~~ | ~~Nadie importaba. Eliminado.~~ |
| **2** | `packages/code/src/modes/keyboard.ts` | 70 | `listenModeToggle()` activa raw mode pero: (a) el spinner de @clack/core también usa stdin, hay conflicto; (b) `stopModeToggle()` se llama en finally pero si el proceso crasha, stdin queda en raw mode. |
| **3** | `packages/code/src/modes/task-streaming.ts` | 118 | `broadcastNarrative/Phase/Mode` se llaman desde `coordinator-manager.ts`, pero el gateway NO tiene endpoint WebSocket que suscriba a estos canales. Nadie consume los mensajes. |
| **4** | ~~`packages/code/src/workers/webview-utils.ts`~~ ✅ **DELETED** | ~~95~~ | ~~`Bun.WebView` no está disponible estable. Eliminado.~~ |
| **5** | `packages/code/src/narrative/schema.ts` | 154 | `CODE_SCHEMA` es ejecutado en `initializeCodeDatabase()` pero las tablas `code_reflections`, `code_playbook`, `code_playbook_fts`, `code_context_cache` no tienen código que las use. |
| **6** | `.github/workflows/release.yml` | 71 | Workflow teórico. No se ha probado. No hay tag `v*` en el repo. Sin firma de código (macOS Gatekeeper bloqueará). |
| **7** | `packages/cli/src/commands-code/dev.ts` | 26 | Es un stub. `commands/dev.ts` original fue eliminado. Este nuevo `dev.ts` solo importa `gateway.ts` con un flag. |
| **8** | ~~`packages/cli/src/commands-code/db-init.ts`~~ ✅ **DELETED** | ~~22~~ | ~~Inicialización centralizada en `packages/cli/src/index.ts:ensureGlobalInit()`. Eliminado.~~ |
| **9** | `packages/skills/src/code/*.md` (12 archivos) | ~150 c/u | Skills de código creadas pero el Context Compiler del core no las activa. Son texto muerto hasta que el sistema de skills las use. |
| **10** | `GAP_ANALYSIS.md` | 526 | Documento de auditoría que quedó obsoleto. Debería archivarse o actualizarse. |

### 2.2 Dependencias que podrían sobrar

| Dep | ¿Se usa? | Nota |
|-----|----------|------|
| `@clack/core` | 🟢 Sí | Theme.ts usa `TextPrompt`/`SelectPrompt`/`ConfirmPrompt` clases correctamente. |
| `croner` | 🟡 Indirectamente | `CronScheduler` usa `Bun.cron`, pero `packages/core/src/tools/cron/index.ts` todavía menciona "Croner" en comentarios. Verificar si croner está en package.json. |
| `@johpaz/hive-code-core` | 🟢 Sí | Stubs creados para `config/loader`, `storage/crypto`, `storage/onboarding` que faltaban. |

### 2.3 Archivos eliminados en esta sesión de limpieza

| Archivo | Líneas | Razón | Impacto |
|---------|--------|-------|---------|
| `packages/core/src/heartbeat/index.ts` | 157 | 0 consumidores. Health check nunca instanciado. | Bajo — keepalive de WS ya es inline |
| `packages/core/src/agent/context-guard.ts` | 91 | 0 consumidores. | Bajo |
| `packages/core/src/agent/stuck-loop.ts` | 133 | 0 consumidores. | Bajo |
| `packages/core/src/utils/benchmark.ts` | 80 | 0 consumidores. | Bajo |
| `packages/core/src/state/store.ts` | 312 | 0 consumidores. | Bajo |
| `packages/core/src/resilience/circuit-breaker.ts` | 225 | 0 consumidores. | Bajo |
| `packages/code/src/context/cache.ts` | 85 | 0 consumidores. Context Compiler no lo usa. | Medio — feature pendiente cuando se integre |
| `packages/code/src/workers/webview-utils.ts` | 97 | `Bun.WebView` no disponible estable. | Bajo — re-crear cuando esté estable |
| `packages/cli/src/commands-code/db-init.ts` | 22 | Inicialización centralizada en `main()`. | Bajo — ahora `ensureGlobalInit()` lo cubre |

### 2.4 Archivos eliminados anteriormente que quizás no debieron serlo

| Archivo | Razón de eliminación | ¿Debería restaurarse? |
|---------|---------------------|----------------------|
| `commands/chat.ts` | Usaba `@clack/prompts` | ❌ No está en SPEC |
| `commands/config.ts` | Usaba `@clack/prompts` | 🟡 `hive-code config` no está en SPEC, pero hive base lo tenía |
| `commands/security.ts` | Usaba `@clack/prompts` | ❌ No está en SPEC |
| `commands/sessions.ts` | Usaba `@clack/prompts` | ❌ No está en SPEC |
| `commands/service.ts` | Usaba `@clack/prompts` | ❌ No está en SPEC |

---

## PARTE 3: PROBLEMAS DE ARQUITECTURA 🔧

### 3.1 El bundle no puede cargar workers

**Problema:** `bun build --bundle` crea un solo `hive-code.js`. Los workers se cargan con:
```typescript
new Worker(new URL("./architecture.worker.ts", import.meta.url).pathname)
```

En el bundle, `import.meta.url` es `file:///.../hive-code.js`, no el archivo `.worker.ts`. Bun no puede extraer workers del bundle automáticamente.

**Soluciones posibles:**
- A) No bundle-ar workers — copiarlos como archivos separados en `dist/workers/`
- B) Usar `Bun.Transpiler` para compilar workers inline
- C) Usar `Blob` + `URL.createObjectURL` para workers en runtime

### 3.2 `callLLM` no existe en el core

**Problema:** `worker-handler.ts` importa:
```typescript
import { callLLM } from "@johpaz/hive-code-core/agent/llm-client"
```

Pero `llm-client.ts` podría no exportar `callLLM`. Necesito verificar.

### 3.3 `@clack/core` v1.3.0 API incompatible

**Problema:** Nuestro `theme.ts` usa `createPrompt()` que es de `@clack/prompts`, no `@clack/core`. La API de `@clack/core` v1.3.0 usa clases:
- `new TextPrompt({ ... })`
- `new SelectPrompt({ ... })`

Nuestro `hiveText()` y `hiveSelect()` están escritos con `createPrompt()` que no existe.

**Impacto:** Los comandos `plan`, `run`, `doctor`, etc. probablemente crashan cuando intentan usar prompts.

### 3.4 CoordinatorManager hace git en el directorio actual

**Problema:** `coordinator-manager.ts` usa `process.cwd()` para todas las operaciones de git y filesystem. Si el usuario corre `hive-code` desde cualquier directorio, las operaciones de git afectan ese repo, no necesariamente el proyecto del usuario.

**Solución:** El manager debería recibir `projectPath` explícitamente desde el CLI.

---

## PARTE 4: CHECKLIST DE CORRECCIÓN — ESTADO ACTUAL

### ✅ Corregido en sesión anterior

1. ~~**Verificar `@clack/core` API**~~ — Era falso positivo; theme.ts usa clases correctamente.
2. ~~**Verificar `callLLM` existe en core**~~ — Verificado: `core/src/agent/llm-client.ts:127`.
3. ~~**Fix `Bun.CryptoHasher` sintaxis**~~ — Corregido a `new Bun.CryptoHasher("sha256")`.
4. ~~**Workers no cargan desde bundle**~~ — Build emite workers como entry points separados.
5. ~~**UUIDv4 → UUIDv7**~~ — Corregido en `scribe.ts` y `coordinator-manager.ts`.
6. ~~**`git_create_pr` token logic**~~ — Eliminada línea absurda `Bun.password.hash`.
7. ~~**TypeScript errors**~~ — 5 errores de tipo corregidos.

### ✅ Corregido en sesión de limpieza (esta sesión)

8. **Eliminar código huérfano** — 8 archivos eliminados (1,382 líneas en total):
   - `heartbeat/index.ts`, `context-guard.ts`, `stuck-loop.ts`, `benchmark.ts`, `state/store.ts`, `circuit-breaker.ts`, `cache.ts`, `webview-utils.ts`
9. **Eliminar `db-init.ts`** — Inicialización unificada en `main()` vía `ensureGlobalInit()`.
10. **Eliminar `ensureCodeDatabase()` de 10 comandos** — Ya no es necesario; el entry point lo hace.
11. **Refactorizar `gateway/server.ts`** — Extraído `connectMcpServer()` helper (eliminados 2 bloques duplicados de ~30 líneas c/u). Combinados imports duplicados de `./helpers`.
12. **Crear stubs faltantes** — `config/loader.ts`, `storage/crypto.ts`, `storage/onboarding.ts` (rompían build).
13. **Seed Hive-Code** — Nuevo `packages/code/src/seed.ts` con tools, skills y playbook rules.
14. **Error handlers** — `Bun.serve` `error()` callback en gateway; `uncaughtException`/`unhandledRejection` en CLI; `worker.onerror` escribe en `code_traces`.
15. **Schema validation** — `validateCodeSchema()` verifica las 11 tablas `code_*`.

### 🔴 Crítico (bloquea uso real)

16. **Sub-agent worker runtime** — Verificar que los worker bundles cargan `callLLM` correctamente.

### 🟡 Alto (degrada experiencia)

17. **Tests básicos** — Ningún test existe.
18. **`shell_executor` sandbox** — Aislar `cwd` por tarea como pide SPEC §3.4.

### 🟢 Medio (mejoras)

19. **Limpiar comentarios "Croner"** — Actualizar referencias obsoletas.
20. **Archivar `GAP_ANALYSIS.md`** — Mover a `docs/` o convertir a CHECKLIST.md actual.

### 🟢 Medio (mejoras)

9. **Eliminar o usar `context/cache.ts`** — Integrar con Context Compiler o eliminar.
10. **Limpiar comentarios "Croner"** — Actualizar referencias obsoletas.
11. **Archivar `GAP_ANALYSIS.md`** — Mover a `docs/` o convertir a CHECKLIST.md actual.

---

*Fin de la auditoría · Generado 2026-05-11*
