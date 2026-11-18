#!/usr/bin/env bash
# Verifica el proyecto, sube la versión del workspace y crea el tag anotado vX.Y.Z.
# El push es opt-in: empujar el tag dispara release.yml.
#
#   scripts/release.sh patch|minor|major|X.Y.Z [--push] [--skip-tests] [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP=""; PUSH=0; SKIP_TESTS=0; DRY=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    -*) echo "opción desconocida: $arg" >&2; exit 2 ;;
    *) BUMP="${arg#v}" ;;
  esac
done
[ -n "$BUMP" ] || { echo "uso: scripts/release.sh patch|minor|major|X.Y.Z [--push] [--skip-tests] [--dry-run]" >&2; exit 2; }

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

step "Precondiciones"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ] || die "hay que estar en main/master (estás en $BRANCH)"
[ -z "$(git status --porcelain)" ] || die "el árbol tiene cambios sin commitear"

CURRENT=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)
[ -n "$CURRENT" ] || die "no encuentro la versión en Cargo.toml"
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  NEXT="$BUMP"
else
  IFS=. read -r MA MI PA <<<"${CURRENT%%-*}"
  case "$BUMP" in
    major) NEXT="$((MA + 1)).0.0" ;;
    minor) NEXT="$MA.$((MI + 1)).0" ;;
    patch) NEXT="$MA.$MI.$((PA + 1))" ;;
    *) die "bump inválido: $BUMP" ;;
  esac
fi
echo "versión: $CURRENT → $NEXT"
git rev-parse "v$NEXT" >/dev/null 2>&1 && die "el tag v$NEXT ya existe"

if [ "$SKIP_TESTS" = 0 ]; then
  step "Formato, clippy y pruebas"
  cargo fmt --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  (cd packages/hivetui && cargo test --locked)
fi

[ "$DRY" = 1 ] && { echo "(dry-run: no se cambia nada)"; exit 0; }

step "Versión $NEXT"
sed -i "0,/^version = \"$CURRENT\"/s//version = \"$NEXT\"/" Cargo.toml
cargo update --workspace --offline >/dev/null 2>&1 || cargo metadata --format-version 1 >/dev/null
git add Cargo.toml Cargo.lock
git commit -m "chore(release): v$NEXT"
git tag -a "v$NEXT" -m "hivecode v$NEXT"
if [ "$PUSH" = 1 ]; then
  git push origin HEAD "v$NEXT"
else
  echo "Tag v$NEXT creado en local. Para publicar: git push origin HEAD v$NEXT"
fi
