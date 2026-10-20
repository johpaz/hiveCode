# Desarrollo

## Ejecutar desde el código fuente

```bash
bun install
bun run dev        # cargo build de la TUI (debug) + gateway + TUI en el mismo proceso
```

Equivalente manual, útil para no tocar el `hivecode` instalado desde npm:

```bash
(cd packages/hivetui && cargo build)
HIVE_DEV=true bun packages/cli/src/index.ts
```

Para probar contra otro proyecto, lanza el comando **desde su directorio** (la sesión toma `process.cwd()` como proyecto):

```bash
cd ~/Documentos/Agents/Bee
HIVE_DEV=true bun ~/Documentos/Agents/Hive/hiveCode/packages/cli/src/index.ts
```

El proyecto de prueba debe ser un repo git con al menos un commit si vas a usar `approval` o `auto` (crean un `git worktree`). En `plan` no hace falta.

## Variables de entorno

| Variable | Efecto |
|----------|--------|
| `HIVE_HOME` | Directorio de configuración y datos (por defecto `~/.hivecode`). |
| `HIVE_DB_PATH` | Ruta explícita de HiveDB. Los tests la aíslan. |
| `HIVE_DEV` | Logging detallado y comportamientos de desarrollo. |
| `HIVE_PORT`, `HIVE_HOST` | Puerto y host del gateway. |
| `HIVE_AUTH_TOKEN` | Token del gateway. |
| `HIVE_MAX_AGENT_CONCURRENCY` | Llamadas activas por sesión (1–32, por defecto 4). |
| `HIVECODE_AGENT_MAX_STEPS` | Tope global de pasos del bucle de agente. |
| `HIVECODE_LEGACY_HARNESS=1` | Usa el pipeline antiguo de coordinadores en vez de `ProfileHarness`. |
| `HIVECODE_TUI=1` | La pone el lanzador de la TUI; desactiva los prompts por stdin. |
| `HIVETUI_HEADLESS=1` | La TUI emite NDJSON en vez de pintar. |
| `HIVE_SANDBOX=1`, `HIVE_SANDBOX_MODE` | Activa y configura el sandbox del shell. |
| `HIVE_SKILL_DIRS` | Directorios extra de skills (separador de `PATH`). |
| `HIVE_CAUSAL_LOG=1` | Activa el registro causal del bucle (coste: una escritura por llamada). |
| `HIVE_COORDINATOR_PROVIDER`, `HIVE_COORDINATOR_MODEL` | Provider y modelo del coordinador. |
| `HIVE_FREE_API_URL` | API de `hivecode-free`. |

## Pruebas

```bash
bun run lint                       # tsc --noEmit en la raíz (debe dar 0 errores)
bun run test                       # bun test con la DB y el llavero aislados
bun run test:integration           # tests/ con tsconfig propio
bun run test:jev                   # solo los del oráculo
cd packages/hivetui && cargo test  # Rust
```

Reglas aprendidas:

- Usa siempre `--preload ./tests/setup/db-isolated.ts` (el script `test` ya lo hace); sin él los tests escriben en tu HiveDB real.
- **No uses `mock.module` en tests nuevos**: en Bun se filtra entre archivos y rompe pruebas ajenas. Parchea el prototipo o inyecta la dependencia (ver `tests/audit/plan-mode-harness.test.ts`, que parchea `ProfileHarness.prototype.run`).
- Los tests con LLM real (`tests/agents/*.real.test.ts`) están excluidos en `bunfig.toml`, porque dentro de un worktree causaban caídas del JIT. Se ejecutan a mano con `--tsconfig-override tests/tsconfig.json`.
- `tsc` por paquete (`-p packages/code`) da más errores que el `tsc` de la raíz; el criterio es la raíz.
- `jev-decisions.test.ts` importa el módulo con `?actual` porque `tests/jev/` lo reemplaza con `mock.module` (global al proceso): sin eso, cuatro de sus tests fallaban en la suite completa y pasaban solos.

Directorios de `tests/`: `agent-loop`, `agents`, `audit` (regresiones de bugs reales), `checkpoint`, `context`, `context-compiler`, `coordinator`, `database`, `e2e`, `harness-recovery`, `ipc`, `jev`, `recovery`, `security`, `tools`…

## Depurar la TUI con tmux

Para ver la TUI real sin ensuciar tu terminal:

```bash
tmux new-session -d -s bee -x 200 -y 50 -c ~/Documentos/Agents/Bee \
  'HIVE_DEV=true bun ~/Documentos/Agents/Hive/hiveCode/packages/cli/src/index.ts'
tmux set-option -g remain-on-exit on
tmux send-keys -t bee 'crea un proyecto…' Enter
tmux send-keys -t bee BTab               # Shift+Tab
tmux capture-pane -t bee -p              # lo que se ve ahora
tmux kill-server
```

Una tarea real con un modelo remoto tarda de 3 a 5 minutos. El modo persiste en `~/.hivecode/execution_mode`, así que comprueba con qué modo arrancas.

Antes de repetir una prueba en el proyecto de ejemplo:

```bash
git reset --hard && git clean -fdx
git worktree prune; git branch --list 'hivecode/*' | xargs -r git branch -D
rm -rf /tmp/hivecode-worktrees
```

## Diagnóstico

- `hivecode doctor`: providers, llavero, base de datos, propuestas pendientes.
- `/logs list|follow` dentro de la TUI y `HIVE_LOG_CONSOLE` para ver el log en consola.
- Bun recoge las trazas de herramientas en `code_traces` y los eventos del harness en la narrativa (`/narrative show|search`).
- Las delegaciones (`task_delegate`) no tienen un log propio: se reconstruyen desde la narrativa y las trazas.

## Convenciones de cambios

- Un bug real = una prueba de regresión en `tests/audit/` (o junto al código) que falle sin el arreglo.
- Mantén los commits por tema. El README y `docs/` se actualizan en el mismo cambio que modifica el comportamiento que describen.
- Los tipos nulos de sesión/tarea (`taskId`, `sessionId`) se tratan como `string | null` en narrativa y ADR; usa `ensureSession()` para obtener una sesión garantizada.

## Publicación

El repositorio versiona en *lockstep*: un único número en todos los `package.json`, `Cargo.toml` y `Cargo.lock` (`scripts/set-version.ts` es la fuente de verdad).

```bash
scripts/release.sh patch --dry-run   # verifica (tipos, tests Bun y Rust) sin cambiar nada
scripts/release.sh patch --push      # sube versión, crea el tag vX.Y.Z y lo empuja
```

El tag dispara `release.yml`: verifica, compila los binarios por plataforma, crea la release con `SHA256SUMS` y publica `@johpaz/hivecode` en npm. `bun run build` genera el bundle de skills, compila la TUI en release y empaqueta el CLI; `bun run build:binary[:mac|:win|:all]` produce los ejecutables independientes.
