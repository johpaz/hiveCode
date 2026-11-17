#!/usr/bin/env bash
# Compila el binario único `hivecode` en Rust, con la TUI incrustada, y lo deja en dist/.
#
#   scripts/build-rust.sh            # dist/hivecode-rust-<os>-<arch> (+ .sha256)
#
# No necesita Bun ni Node. Requiere la cadena de Rust fijada en rust-toolchain.toml.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

step "TUI (packages/hivetui, release)"
(cd packages/hivetui && cargo build --release --locked)

step "hivecode (release, con la TUI incrustada)"
HIVETUI_EMBED="$PWD/packages/hivetui/target/release/hivetui" cargo build --release --locked -p hivecode-app

OS=$(uname -s | tr '[:upper:]' '[:lower:]'); ARCH=$(uname -m)
OUT="dist/hivecode-rust-$OS-$ARCH"
mkdir -p dist
cp target/release/hivecode "$OUT"
(cd dist && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")

step "Comprobación"
"$OUT" --version
HOME_TMP=$(mktemp -d)
HIVE_HOME="$HOME_TMP" HIVECODE_API_KEY=x HIVECODE_MODEL=x "$OUT" doctor | grep -E "TUI|base de datos" || true
rm -rf "$HOME_TMP"
printf '\n%s  (%s bytes)\n' "$OUT" "$(wc -c < "$OUT")"
