# Desarrollo

## Requisitos
La cadena de Rust de `rust-toolchain.toml`, `git` y el SDK en `../hiveRust/hiveSDK-Rust`. No hace
falta Bun ni Node.

## Compilar y probar
```bash
cargo build -p hivecode-app                         # target/debug/hivecode
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings
cargo build --manifest-path packages/hivetui/Cargo.toml   # la TUI (las pruebas del CLI la usan si existe)
cargo test --workspace
(cd packages/hivetui && cargo test)
scripts/build-rust.sh                               # binario de release con la TUI incrustada
```
Las pruebas no llaman a ningún modelo real: usan un servidor de modelo falso local, repositorios git
temporales y un `HIVE_HOME` aislado (nunca tocan tu perfil ni el llavero).

## Prueba con un proveedor real
`scripts/real-check.sh PRESET MODELO [--swarm]` con `HIVECODE_API_KEY` (o `KEY_FILE`). Perfil y
proyecto temporales, presupuesto acotado (40 llamadas al modelo, 120 de herramientas).

## Variables de entorno
`HIVE_HOME` (perfil; por defecto `~/.hivecode`), `HIVECODE_API_KEY`, `HIVECODE_MODEL`,
`HIVECODE_BASE_URL`, `HIVECODE_CONTEXT_WINDOW`, `HIVECODE_SECRETS_FILE`, `HIVECODE_BRAVE_API_KEY`,
`HIVECODE_AGENT_MAX_STEPS`, `HIVECODE_BUDGET_MODEL_CALLS|TOOL_CALLS|OUTPUT_TOKENS|MINUTES`,
`HIVECODE_TUI_BIN` (otra TUI), `HIVETUI_EMBED` (TUI a incrustar al compilar).

## Publicar
`scripts/release.sh patch|minor|major|X.Y.Z [--push]` sube la versión, crea el tag `vX.Y.Z` y, con
`--push`, dispara `release.yml` (binarios para Linux x64/arm64 y macOS arm64/x64). CI y release
descargan también el SDK; si es privado, define el secreto `SDK_TOKEN`.
