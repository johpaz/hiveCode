#!/usr/bin/env bash
# Prueba real de `hivecode` contra un proveedor de verdad, con topes bajos y sin tocar tu perfil.
#
#   HIVECODE_API_KEY=... scripts/real-check.sh PRESET MODELO [--swarm]
#   scripts/real-check.sh deepseek deepseek-chat
#   scripts/real-check.sh gemini gemini-2.5-flash --swarm
#
# - La clave llega SOLO por la variable HIVECODE_API_KEY (o por KEY_FILE=/ruta/al/archivo, que se lee
#   y no se imprime). El script no la busca en ningún llavero ni base.
# - Todo ocurre en un HIVE_HOME y un proyecto temporales; ~/.hivecode no se toca.
# - Presupuesto de toda la prueba: 40 llamadas al modelo, 120 de herramientas, 40 000 tokens de salida
#   y 10 minutos (HIVECODE_BUDGET_*). Cada escenario además es corto a propósito.
# - Escenarios: (1) pregunta de solo lectura en modo plan, (2) un cambio pequeño en modo auto con su
#   verificación, (3) deshacerlo con `hivecode rollback`. Con --swarm, (2) pasa por BEE y el harness.
set -euo pipefail
cd "$(dirname "$0")/.."

PRESET=${1:?uso: real-check.sh PRESET MODELO [--swarm]}; MODEL=${2:?uso: real-check.sh PRESET MODELO [--swarm]}
SWARM=""; [ "${3:-}" = "--swarm" ] && SWARM="--swarm"
if [ -z "${HIVECODE_API_KEY:-}" ] && [ -n "${KEY_FILE:-}" ]; then HIVECODE_API_KEY=$(cat "$KEY_FILE"); fi
[ -n "${HIVECODE_API_KEY:-}" ] || { echo "Falta la clave: HIVECODE_API_KEY=... o KEY_FILE=/ruta" >&2; exit 2; }
export HIVECODE_API_KEY

BIN=${BIN:-target/release/hivecode}; [ -x "$BIN" ] || BIN=target/debug/hivecode
[ -x "$BIN" ] || { echo "No hay binario: cargo build --release -p hivecode-app" >&2; exit 2; }
BIN=$(realpath "$BIN")

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
export HIVE_HOME="$WORK/home" TMPDIR="$WORK"
export HIVECODE_BUDGET_MODEL_CALLS=40 HIVECODE_BUDGET_TOOL_CALLS=120 HIVECODE_BUDGET_OUTPUT_TOKENS=40000 HIVECODE_BUDGET_MINUTES=10
mkdir -p "$HIVE_HOME" "$WORK/proyecto"
cd "$WORK/proyecto"
git init -q -b main
cat > suma.py <<'PY'
def suma(a, b):
    return a + b
PY
cat > test_suma.py <<'PY'
import unittest
from suma import suma


class Suma(unittest.TestCase):
    def test_suma(self):
        self.assertEqual(suma(2, 3), 5)


if __name__ == "__main__":
    unittest.main()
PY
git add . && git -c user.name=t -c user.email=t@t commit -qm inicial
ARGS=(--preset "$PRESET" --model "$MODEL" --root "$WORK/proyecto")
# BASE_URL=... apunta a otro servidor compatible (un proxy, uno local); sin él se usa el del catálogo.
[ -n "${BASE_URL:-}" ] && ARGS+=(--base-url "$BASE_URL")

# Resume la última línea JSON de `hivecode run --headless`; si no hay una, lo dice sin trazas.
summary() {
  python3 -c '
import sys, json
lines = [l for l in sys.stdin.read().splitlines() if l.startswith("{")]
done = next((json.loads(l) for l in reversed(lines) if json.loads(l).get("type") == "done"), None)
if not done:
    print("(la corrida no terminó con un resultado)"); sys.exit(1)
b = done.get("budget") or {}
h = done.get("harness") or {}
print("respuesta:", (done.get("content") or "")[:400].replace("\n", " "))
print("cambios:", done.get("integration"), "· se puede deshacer:", done.get("undoable"))
print("presupuesto:", {k: b.get(k) for k in ("model_calls", "tool_calls", "output_tokens")})
if h: print("ruta:", h.get("route"), h.get("status"), "· reparaciones:", h.get("repair_cycles"))
print("RUN_ID=" + done["run_id"], file=sys.stderr)
'
}

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
bad()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; FAILED=1; }
FAILED=0

step "1/3 · Solo lectura (modo plan): qué hace el proyecto"
OUT=$("$BIN" run --headless --mode plan $SWARM "${ARGS[@]}" "¿Qué funciones define suma.py y qué prueba hay? Responde en dos líneas." 2>"$WORK/err1" || true)
if echo "$OUT" | summary 2>/dev/null; then ok "respondió"; else bad "sin respuesta"; tail -3 "$WORK/err1"; fi

step "2/3 · Cambio pequeño (modo auto): añadir resta con su prueba"
OUT=$("$BIN" run --headless --mode auto $SWARM "${ARGS[@]}" "Añade a suma.py una función resta(a, b) y una prueba para ella en test_suma.py. Comprueba que las pruebas pasan." 2>"$WORK/err2" || true)
if echo "$OUT" | summary 2>"$WORK/runid"; then ok "terminó"; else bad "el cambio no terminó"; tail -5 "$WORK/err2"; fi
RUN_ID=$(sed -n 's/^RUN_ID=//p' "$WORK/runid")
if grep -q "def resta" "$WORK/proyecto/suma.py" 2>/dev/null; then ok "suma.py tiene resta()"; else bad "suma.py no tiene resta()"; fi
if python3 -m unittest discover -q -s "$WORK/proyecto" 2>&1 | tail -3 | grep -q "OK"; then ok "las pruebas del proyecto pasan"; else bad "las pruebas del proyecto NO pasan"; fi

step "3/3 · Historial y deshacer"
"$BIN" history --limit 5
if [ -n "$RUN_ID" ]; then
  "$BIN" rollback "$RUN_ID" && { grep -q "def resta" "$WORK/proyecto/suma.py" && bad "resta() sigue ahí tras deshacer" || ok "deshecho: resta() ya no está"; }
fi

echo
[ "$FAILED" = 0 ] && ok "prueba real terminada sin fallos" || { bad "hubo fallos (arriba)"; exit 1; }
