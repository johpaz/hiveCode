# hivecode

**Enjambre de agentes de código para tu terminal. Un solo binario en Rust, multi‑proveedor.**

`hivecode` recibe una tarea y la resuelve con un agente (o un enjambre: **BEE** lidera y delega en
`scout`, `builder`, `verifier` y `spider`) construido sobre el motor del SDK de Hive Agents
(`hive-agent-core`). Cada tarea trabaja en su propia copia de git (`git worktree`), se verifica de
forma determinista (pruebas, tipos, compilación) y se integra al proyecto solo si sale bien; todo
cambio integrado se puede deshacer con `hivecode rollback`.

> **Sin Bun ni Node.** Un único ejecutable con la TUI incrustada. Base de datos: HiveDB (la misma
> que usan las sesiones del SDK). Licencia: ver [`LICENSE`](./LICENSE).

## Compilar

Requiere la cadena fijada en `rust-toolchain.toml` y el SDK al lado:

```
Hive/
├── hiveCode/          ← este repositorio
└── hiveRust/hiveSDK-Rust/
```

```bash
scripts/build-rust.sh          # dist/hivecode-rust-<os>-<arch> (+ .sha256), con la TUI incrustada
```

## Primeros pasos

```bash
hivecode onboard                       # elige proveedor y guarda su clave
hivecode doctor                        # comprueba proveedor, clave, base de datos, TUI, git
hivecode                               # la TUI
hivecode run "explica este proyecto"   # una tarea suelta
hivecode run --swarm --mode auto "añade validación al formulario de alta y sus pruebas"
```

Proveedores y claves: `hivecode provider list|presets|add|use|remove|key`. La clave se resuelve en
este orden: `HIVECODE_API_KEY` → la variable que indique `key_env` del proveedor → el llavero del
sistema (servicio `hivecode`). Sin llavero (servidor, contenedor): `HIVECODE_SECRETS_FILE=/ruta`
(archivo `0600`). `config.json` nunca lleva claves.

## Comandos

| Comando | Para qué |
|---------|----------|
| `run [--headless] [--swarm] [--mode plan\|approval\|auto] [--resume ID \| --recover ID] <tarea>` | Una tarea. `--headless` emite NDJSON. |
| `history [--json]` / `rollback ID` | Historial de corridas y deshacer una integrada. |
| `provider …` / `mcp …` | Proveedores y servidores MCP (`<servidor>__<herramienta>`). |
| `skill list\|show\|match\|check` | Skills `SKILL.md` (las incluidas, las tuyas y las del proyecto). |
| `cron add\|list\|enable\|disable\|run` | Tareas programadas sobre el scheduler del SDK. |
| `init [--write]` | Genera/actualiza las instrucciones del proyecto. |
| `doctor` / `onboard` | Diagnóstico y primer arranque. |

## Modos

- `plan`: solo lectura; las herramientas que mutan se rechazan.
- `approval`: pregunta antes de cada herramienta que muta (en la TUI, con un modal).
- `auto`: ejecuta sin preguntar, dentro de la copia de git de la tarea.

## Documentación

Índice en [`docs/`](./docs/README.md): [arquitectura](./docs/architecture.md),
[modos](./docs/modes.md), [harness y enjambre](./docs/harness.md), [skills](./docs/skills.md),
[TUI](./docs/tui.md), [desarrollo](./docs/development.md) y el
[estado del port a Rust](./docs/rust-port.md).
