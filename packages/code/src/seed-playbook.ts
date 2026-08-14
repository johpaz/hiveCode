import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodePlaybookDoc } from "@johpaz/hivecode-core/storage/collections"

export interface SeedRule {
  rule: string
  coordinator: string | null
  confidence: number
}

export const SEED_PLAYBOOK: SeedRule[] = [
  { rule: "Siempre verificar con read_file antes de escribir cualquier archivo existente", coordinator: null, confidence: 0.95 },
  { rule: "Nunca hardcodear credenciales; usar Bun.secrets o variables de entorno", coordinator: null, confidence: 0.99 },
  { rule: "Preferir Bun.spawn con array de args sobre shell exec para evitar inyeccion de comandos", coordinator: "backend", confidence: 0.92 },
  { rule: "Ejecutar check_types despues de modificar codigo TypeScript", coordinator: null, confidence: 0.88 },
  { rule: "Crear tests con bun:test --isolate para cada modulo modificado", coordinator: "test", confidence: 0.85 },
  { rule: "Documentar decisiones tecnicas en el narrativo con formato QUE / POR QUE / ARCHIVOS", coordinator: null, confidence: 0.90 },
  { rule: "En modo PLAN, ninguna tool de escritura debe ejecutarse; solo lectura y diseno", coordinator: null, confidence: 0.97 },
  { rule: "Antes de git_commit, verificar que los tests pasen con bun test", coordinator: "devops", confidence: 0.87 },
  { rule: "Usar Bun.randomUUIDv7() para IDs de tareas, sesiones y trazas", coordinator: null, confidence: 0.91 },
  { rule: "Redactar campos sensibles (api_key, token, secret, password) en logs y narrativos", coordinator: null, confidence: 0.96 },
  { rule: "Para APIs REST, validar inputs con Zod antes de procesar cualquier request", coordinator: "backend", confidence: 0.89 },
]

export async function seedPlaybook(_db?: unknown): Promise<void> {
  const playbook = await col<CodePlaybookDoc>("codePlaybook")
  const existing = await playbook.scan()
  for (const rule of SEED_PLAYBOOK) {
    const row = existing.find((entry) => entry.doc.rule === rule.rule)
    const id = row?.id ?? Bun.randomUUIDv7()
    await playbook.put(id, {
      id,
      rule: rule.rule,
      coordinator: rule.coordinator,
      source: "seed",
      helpful_count: row?.doc.helpful_count ?? 0,
      harmful_count: row?.doc.harmful_count ?? 0,
      confidence: Math.max(row?.doc.confidence ?? 0, rule.confidence),
      active: true,
      created_at: row?.doc.created_at ?? new Date().toISOString(),
      last_applied: row?.doc.last_applied ?? null,
    }, { expectedVersion: row?.version ?? 0 })
  }
}
