/**
 * Seed Playbook — Reglas base inyectadas al crear la base de datos.
 * Estas reglas representan las convenciones y mejores prácticas de HiveCode
 * que todo coordinador debe conocer desde el inicio.
 */

export interface SeedRule {
  rule: string
  coordinator: string | null // null = aplica a todos
  confidence: number
}

export const SEED_PLAYBOOK: SeedRule[] = [
  {
    rule: "Siempre verificar con read_file antes de escribir cualquier archivo existente",
    coordinator: null,
    confidence: 0.95,
  },
  {
    rule: "Nunca hardcodear credenciales — siempre usar Bun.secrets o variables de entorno",
    coordinator: null,
    confidence: 0.99,
  },
  {
    rule: "Preferir Bun.spawn con array de args sobre shell exec para evitar inyección de comandos",
    coordinator: "backend",
    confidence: 0.92,
  },
  {
    rule: "Siempre ejecutar check_types (bun tsc --noEmit) después de modificar código TypeScript",
    coordinator: null,
    confidence: 0.88,
  },
  {
    rule: "Crear tests con bun:test --isolate para cada módulo modificado",
    coordinator: "test",
    confidence: 0.85,
  },
  {
    rule: "Documentar decisiones técnicas en el narrativo con formato QUÉ / POR QUÉ / ARCHIVOS",
    coordinator: null,
    confidence: 0.90,
  },
  {
    rule: "En modo PLAN, ninguna tool de escritura debe ejecutarse — solo lectura y diseño",
    coordinator: null,
    confidence: 0.97,
  },
  {
    rule: "Antes de git_commit, verificar que los tests pasen con bun test",
    coordinator: "devops",
    confidence: 0.87,
  },
  {
    rule: "Usar Bun.randomUUIDv7() para IDs de tareas, sesiones y trazas",
    coordinator: null,
    confidence: 0.91,
  },
  {
    rule: "Redactar campos sensibles (api_key, token, secret, password) en logs y narrativos",
    coordinator: null,
    confidence: 0.96,
  },
  {
    rule: "Para APIs REST, validar inputs con Zod antes de procesar cualquier request",
    coordinator: "backend",
    confidence: 0.89,
  },
  {
    rule: "Siempre usar PRAGMA journal_mode = WAL al inicializar SQLite",
    coordinator: "backend",
    confidence: 0.93,
  },
]

export function seedPlaybook(db: any): void {
  const stmt = db.prepare(`
    INSERT INTO code_playbook (rule, coordinator, confidence, active, source)
    VALUES (?, ?, ?, 1, 'seed')
    ON CONFLICT(rule) DO UPDATE SET
      confidence = MAX(code_playbook.confidence, excluded.confidence),
      active = 1
  `)
  for (const r of SEED_PLAYBOOK) {
    stmt.run(r.rule, r.coordinator, r.confidence)
  }
}
