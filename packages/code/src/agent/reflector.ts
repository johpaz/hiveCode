import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { callLLM, resolveProviderConfig } from "@johpaz/hivecode-core/agent/llm-client"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const REFLECTOR_TASK_INTERVAL = 5
const REFLECTOR_TRACE_THRESHOLD = 20
// Auto-run every 20 minutes if neither task nor trace threshold is met
const REFLECTOR_TIME_INTERVAL_MS = 20 * 60 * 1000

let _tasksSinceLastReflector = 0
let _lastReflectorRun = 0
let _cronTimer: ReturnType<typeof setInterval> | null = null

/** Start the time-based reflector cron (call once at startup). */
export function startReflectorCron(): void {
  if (_cronTimer) return
  _cronTimer = setInterval(async () => {
    const db = getDb()
    const pending = (db.query("SELECT COUNT(*) as c FROM code_traces WHERE analyzed = 0").get() as any)?.c ?? 0
    if (pending > 0) {
      try {
        const result = await runReflector(db)
        if (result.rules > 0) logger.info(`[reflector] Cron run: ${result.rules} new rules`)
      } catch (err) {
        logger.warn("[reflector] Cron run failed:", (err as Error).message)
      }
    }
  }, REFLECTOR_TIME_INTERVAL_MS)
  // Don't block process exit
  if (_cronTimer && typeof (_cronTimer as any).unref === "function") {
    ;(_cronTimer as any).unref()
  }
}

export function stopReflectorCron(): void {
  if (_cronTimer) {
    clearInterval(_cronTimer)
    _cronTimer = null
  }
}

/**
 * Extract developer preferences from USER_OVERRIDEs and corrections in the narrative.
 * Stores extracted rules in code_playbook with coordinator='user', source='preferences'.
 */
export async function extractDeveloperPreferences(db: ReturnType<typeof getDb>): Promise<number> {
  // Read recent user overrides from narrative
  const overrides = db.query<any, []>(`
    SELECT entry, created_at FROM code_narrative
    WHERE is_override = 1
    ORDER BY id DESC LIMIT 30
  `).all()

  if (overrides.length === 0) return 0

  const overrideText = overrides.map((o: any) => `- ${o.entry}`).join("\n")

  let providerCfg: any
  try {
    providerCfg = await resolveProviderConfig("", "")
  } catch {
    return 0
  }

  const response = await callLLM({
    ...providerCfg,
    messages: [
      {
        role: "system",
        content:
          "Eres un analizador de preferencias de desarrollador. " +
          "Analiza las instrucciones de override del usuario y extrae preferencias o reglas de estilo concretas. " +
          "Cada preferencia debe ser una regla breve y accionable (máx 120 caracteres). " +
          "Sólo extrae reglas que se repitan o que sean muy específicas del desarrollador. " +
          "Formato: una regla por línea, sin numeración, sin markdown.",
      },
      {
        role: "user",
        content: `Analiza estas instrucciones de override del usuario y extrae sus preferencias:\n${overrideText}`,
      },
    ],
  })

  const prefs = response.content
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 10 && l.length < 200 && !l.startsWith("#"))
    .slice(0, 8)

  let inserted = 0
  for (const pref of prefs) {
    try {
      db.query(`
        INSERT INTO code_playbook (rule, coordinator, source, confidence, active)
        VALUES (?, 'user', 'preferences', 0.7, 1)
        ON CONFLICT(rule) DO UPDATE SET
          confidence = MIN(confidence + 0.05, 0.95),
          last_applied = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `).run(pref)
      inserted++
    } catch { /* skip */ }
  }

  if (inserted > 0) {
    logger.info(`[reflector] Extracted ${inserted} developer preferences`)
  }
  return inserted
}

export async function runReflector(db?: ReturnType<typeof getDb>): Promise<{ traces: number; rules: number }> {
  const database = db || getDb()

  const traces = database.query(`
    SELECT task_id, agent_id, coordinator, tool_name, input_summary, output_summary, success, duration_ns
    FROM code_traces WHERE analyzed = 0 ORDER BY id DESC LIMIT 50
  `).all() as any[]

  if (traces.length === 0) {
    // Still try to extract developer preferences even with no new traces
    try { await extractDeveloperPreferences(database) } catch { /* optional */ }
    return { traces: 0, rules: 0 }
  }

  const byCoordinator: Record<string, any[]> = {}
  for (const t of traces) {
    const key = t.coordinator || t.agent_id || "unknown"
    if (!byCoordinator[key]) byCoordinator[key] = []
    byCoordinator[key].push(t)
  }

  const lines: string[] = []
  for (const [coord, ts] of Object.entries(byCoordinator)) {
    lines.push(`\n## Coordinador: ${coord}`)
    for (const t of ts.slice(0, 10)) {
      const status = t.success ? "OK" : "FAIL"
      lines.push(`- [${status}] ${t.tool_name}: ${t.output_summary?.slice(0, 120) || ""}`)
    }
  }

  let providerCfg: any
  try {
    providerCfg = await resolveProviderConfig("", "")
  } catch {
    database.query("UPDATE code_traces SET analyzed = 1 WHERE analyzed = 0").run()
    return { traces: traces.length, rules: 0 }
  }

  const summaryResponse = await callLLM({
    ...providerCfg,
    messages: [
      {
        role: "system",
        content:
          "Eres un analista de patrones de ejecución de agentes de software. " +
          "Analiza las trazas de ejecución y genera reglas de playbook concisas (1 por bloque de trazas). " +
          "Cada regla debe ser una instrucción práctica que mejore el comportamiento futuro del coordinador. " +
          "Formato de salida: una regla por línea, sin numeración, sin markdown.",
      },
      {
        role: "user",
        content: `Analiza estas ${traces.length} trazas y genera reglas de playbook:\n${lines.join("\n")}`,
      },
    ],
  })

  const rules = summaryResponse.content
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 10 && !l.startsWith("#") && !l.startsWith("-"))
    .slice(0, 10)

  let inserted = 0
  const firstCoord = Object.keys(byCoordinator)[0] || null
  for (const rule of rules) {
    try {
      database.query(`
        INSERT INTO code_playbook (rule, confidence, active, coordinator, source)
        VALUES (?, 0.5, 1, ?, 'reflector')
        ON CONFLICT(rule) DO UPDATE SET
          confidence = MIN(confidence + 0.1, 0.95),
          last_applied = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `).run(rule, firstCoord)
      inserted++
    } catch { /* skip */ }
  }

  // Save reflection record
  try {
    database.query(`
      INSERT INTO code_reflections (traces_analyzed, insights)
      VALUES (?, ?)
    `).run(traces.length, rules.join("\n"))
  } catch { /* optional */ }

  database.query("UPDATE code_traces SET analyzed = 1 WHERE analyzed = 0").run()
  _lastReflectorRun = Date.now()
  _tasksSinceLastReflector = 0

  // Also extract developer preferences on each full reflector run
  try { await extractDeveloperPreferences(database) } catch { /* optional */ }

  logger.info(`[reflector] ${traces.length} trazas analizadas, ${inserted} reglas generadas`)
  return { traces: traces.length, rules: inserted }
}

export function incrementTaskCounter(): void {
  _tasksSinceLastReflector++
}

export function shouldRunReflector(db: ReturnType<typeof getDb>): boolean {
  if (_tasksSinceLastReflector >= REFLECTOR_TASK_INTERVAL) return true
  const pending = (db.query("SELECT COUNT(*) as c FROM code_traces WHERE analyzed = 0").get() as any)?.c ?? 0
  return pending >= REFLECTOR_TRACE_THRESHOLD
}
