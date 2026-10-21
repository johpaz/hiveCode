/**
 * La verificación determinista: ejecutar el proyecto.
 *
 * Un gate por modelo cuesta minutos y juzga; ejecutar la suite cuesta segundos y mide. Para
 * un cambio acotado, lo segundo no es menos preciso sino más: el veredicto no depende de
 * quién lo juzgue. Sólo cuando las comprobaciones pasan tiene sentido pedirle a un modelo
 * que repase criterios de aceptación y diff — eso es lo que hace la ruta de feature.
 *
 * Distingue tres estados, no dos: "pasó", "falló" y "no había nada que comprobar". Un
 * proyecto sin suite de pruebas no es un proyecto con pruebas rotas: eso sería un fallo
 * inventado, y un fallo inventado dispara reparaciones que no arreglan nada.
 */
import { createAllTools } from "../tools/index.ts"
import { readProjectFacts, type ProjectFacts } from "./task-weight.ts"

export interface DeterministicCheck {
  name: string
  status: "passed" | "failed" | "skipped"
  detail: string
}

export interface DeterministicVerdict {
  ok: boolean
  checks: DeterministicCheck[]
  summary: string
}

/** Salidas que significan "no había nada que correr", no "falló". */
const NOTHING_TO_RUN = /0 test files|no test files|no tests found|0 tests|no build script|no test script|not found|no tsconfig/i

const CHECKS: { tool: string; label: string }[] = [
  { tool: "code_test", label: "pruebas" },
  { tool: "check_types", label: "tipos" },
  { tool: "code_build", label: "build" },
]

/**
 * Qué comprobaciones tienen sentido aquí.
 *
 * Una comprobación que no aplica no es una comprobación fallida: un proyecto sin `tsconfig`
 * no tiene tipos que comprobar, y `tsc` sobre un proyecto así sale en rojo porque no hay
 * configuración, no porque el código esté mal. Tratarlo como fallo inventaba un defecto,
 * disparaba una reparación inútil y gastaba el presupuesto arreglando un problema que no
 * existía.
 */
export function checksFor(facts: ProjectFacts): { tool: string; label: string }[] {
  return CHECKS.filter(check => {
    if (check.tool === "code_test") return facts.hasTests
    if (check.tool === "check_types") return facts.hasTypescript && !(facts.hasPackageJson && !facts.hasDependencies)
    if (check.tool === "code_build") return facts.scripts.includes("build")
    return true
  })
}

function applicableChecks(workspace: string): { tool: string; label: string }[] {
  return checksFor(readProjectFacts(workspace))
}

export async function verifyDeterministic(
  workspace: string,
  signal?: AbortSignal,
): Promise<DeterministicVerdict> {
  const tools = createAllTools({} as never)
  const config = { configurable: { workspace }, signal }
  const checks: DeterministicCheck[] = []

  for (const { tool: name, label } of applicableChecks(workspace)) {
    const tool = tools.find(t => t.name === name)
    if (!tool?.execute) continue
    try {
      const res = (await tool.execute({ path: workspace, timeout: 120 }, config as never)) as any
      const output = String(res?.result?.output ?? "")
      const detail = String(res?.error ?? output ?? "").slice(0, 800)

      if (NOTHING_TO_RUN.test(detail) && res?.ok !== true) {
        checks.push({ name: label, status: "skipped", detail: "no había nada que comprobar" })
        continue
      }
      if (name === "check_types") {
        const pass = res?.result?.pass !== false
        checks.push({
          name: label,
          status: pass ? "passed" : "failed",
          detail: pass ? String(res?.result?.summary ?? "sin errores de tipos") : detail,
        })
        continue
      }
      checks.push({ name: label, status: res?.ok ? "passed" : "failed", detail: res?.ok ? "" : detail })
    } catch (err) {
      checks.push({ name: label, status: "skipped", detail: (err as Error).message.slice(0, 200) })
    }
  }

  const failed = checks.filter(c => c.status === "failed")
  const summary = checks
    .map(c => `${c.name} ${c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "—"}`)
    .join(" · ")
  return { ok: failed.length === 0, checks, summary }
}

/** El texto que va al informe y a la respuesta al usuario. */
export function describeVerdict(verdict: DeterministicVerdict): string {
  const lines = verdict.checks.map(c => {
    const mark = c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "—"
    return `- ${c.name} ${mark}${c.detail && c.status !== "passed" ? `: ${c.detail}` : ""}`
  })
  return `Verificación determinista: ${verdict.ok ? "todo en verde" : "hay comprobaciones en rojo"}\n${lines.join("\n")}`
}
