#!/usr/bin/env bash
# Verifica el proyecto (tipos + tests Bun + tests Rust), sube la versión y crea
# el tag anotado vX.Y.Z. El push es opt-in: empujar el tag dispara release.yml,
# que publica binarios y npm.
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
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) echo "opción desconocida: $arg" >&2; exit 2 ;;
    *) BUMP="${arg#v}" ;;  # acepta v0.0.1 o 0.0.1
  esac
done
[ -n "$BUMP" ] || { echo "uso: scripts/release.sh patch|minor|major|X.Y.Z [--push] [--skip-tests] [--dry-run]" >&2; exit 2; }

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Precondiciones ────────────────────────────────────────────────────────────
step "Precondiciones"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "hay que estar en main (estás en $BRANCH)"
[ -z "$(git status --porcelain)" ] || die "el árbol tiene cambios sin commitear"
git fetch --quiet origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "main local no coincide con origin/main (haz pull/push primero)"

# ── Versión siguiente ─────────────────────────────────────────────────────────
LAST_TAG=$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -v -- '-' | head -n1 || true)
CURRENT=${LAST_TAG#v}
[ -n "$CURRENT" ] || CURRENT=$(bun -e 'console.log(require("./package.json").version)')

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
TAG="v$NEXT"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "el tag $TAG ya existe"
echo "versión: ${CURRENT} → ${NEXT}  (tag $TAG)"

# ── Verificación ──────────────────────────────────────────────────────────────
if [ "$SKIP_TESTS" -eq 0 ]; then
  # La suite deja ~1 GB de directorios temporales por corrida. Acumulados agotan
  # la cuota de /tmp y los tests empiezan a fallar en cascada por no poder crear
  # su DB. Con un TMPDIR propio, que se borra al salir, cada corrida parte limpia.
  TEST_TMP=$(mktemp -d -t hivecode-release-XXXXXX)
  trap 'rm -rf "$TEST_TMP"' EXIT
  export TMPDIR="$TEST_TMP"

  step "Typecheck"
  bun run lint
  step "Tests Bun"
  bun run test --parallel
  step "Tests Rust (TUI)"
  cargo test --locked --manifest-path packages/hivetui/Cargo.toml
else
  echo "⚠ --skip-tests: no se verificó nada"
fi

if [ "$DRY" -eq 1 ]; then
  step "dry-run: no se modificó nada. Con esto se habría creado $TAG"
  exit 0
fi

# ── Versionar, commit y tag ───────────────────────────────────────────────────
step "Subiendo versión a $NEXT (todos los paquetes + Cargo)"
bun scripts/set-version.ts "$NEXT"
# `--locked` falla si Cargo.lock no coincide con los manifiestos: mejor aquí que en CI.
cargo metadata --locked --offline --no-deps --format-version 1 \
  --manifest-path packages/hivetui/Cargo.toml >/dev/null
git add package.json packages/*/package.json packages/hivetui/Cargo.toml packages/hivetui/Cargo.lock
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "hivecode $TAG"
echo "✓ commit y tag $TAG creados (local)"

if [ "$PUSH" -eq 1 ]; then
  step "Push (dispara release.yml)"
  git push origin main "$TAG"
else
  echo
  echo "Para publicar:  git push origin main $TAG"
  echo "Para deshacer:  git tag -d $TAG && git reset --hard HEAD~1"
fi
