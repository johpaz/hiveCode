import { callLLM, resolveProviderConfig } from "@johpaz/hivecode-core/agent/llm-client"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type {
  CodeNarrativeDoc,
  CodePlaybookDoc,
  CodeReflectionDoc,
  CodeTraceDoc,
} from "@johpaz/hivecode-core/storage/collections"
import { logger } from "@johpaz/hivecode-core/utils/logger"

const REFLECTOR_TASK_INTERVAL = 5
const REFLECTOR_TIME_INTERVAL_MS = 20 * 60 * 1000

let _tasksSinceLastReflector = 0
let _lastReflectorRun = 0
let _cronTimer: ReturnType<typeof setInterval> | null = null

function nowIso(): string {
  return new Date().toISOString()
}

async function scanDocs<T>(collection: string): Promise<T[]> {
  return (await (await col<T>(collection)).scan()).map((entry) => entry.doc)
}

async function pendingTraceDocs(limit = 50): Promise<CodeTraceDoc[]> {
  return (await (await col<CodeTraceDoc>("codeTraces")).findBy("analyzed", false))
    .map((entry) => entry.doc)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
}

async function upsertPlaybookRule(rule: string, coordinator: string | null, source: string, confidence: number): Promise<boolean> {
  const playbook = await col<CodePlaybookDoc>("codePlaybook")
  const rows = await playbook.scan()
  const existing = rows.find((entry) => entry.doc.rule === rule)
  const id = existing?.id ?? Bun.randomUUIDv7()
  await playbook.put(id, {
    id,
    rule,
    coordinator,
    source,
    helpful_count: existing?.doc.helpful_count ?? 0,
    harmful_count: existing?.doc.harmful_count ?? 0,
    confidence: existing ? Math.min(existing.doc.confidence + 0.1, 0.95) : confidence,
    active: true,
    created_at: existing?.doc.created_at ?? nowIso(),
    last_applied: existing ? nowIso() : null,
  }, { expectedVersion: existing?.version ?? 0 })
  return !existing
}

export function startReflectorCron(): void {
  if (_cronTimer) return
  _cronTimer = setInterval(async () => {
    const pending = await pendingTraceDocs(1)
    if (pending.length > 0) {
      try {
        const result = await runReflector()
        if (result.rules > 0) logger.info(`[reflector] Cron run: ${result.rules} new rules`)
      } catch (err) {
        logger.warn("[reflector] Cron run failed:", (err as Error).message)
      }
    }
  }, REFLECTOR_TIME_INTERVAL_MS)
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

export async function extractDeveloperPreferences(): Promise<number> {
  const overrides = (await scanDocs<CodeNarrativeDoc>("codeNarrative"))
    .filter((entry) => entry.is_override)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 30)

  if (overrides.length === 0) return 0

  const overrideText = overrides.map((o) => `- ${o.entry}`).join("\n")

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
          "Cada preferencia debe ser una regla breve y accionable (max 120 caracteres). " +
          "Solo extrae reglas que se repitan o que sean muy especificas del desarrollador. " +
          "Formato: una regla por linea, sin numeracion, sin markdown.",
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
      if (await upsertPlaybookRule(pref, "user", "preferences", 0.7)) inserted++
    } catch { /* skip */ }
  }

  if (inserted > 0) {
    logger.info(`[reflector] Extracted ${inserted} developer preferences`)
  }
  return inserted
}

export async function runReflector(_db?: unknown): Promise<{ traces: number; rules: number }> {
  const traces = await pendingTraceDocs(50)

  if (traces.length === 0) {
    try { await extractDeveloperPreferences() } catch { /* optional */ }
    return { traces: 0, rules: 0 }
  }

  const byCoordinator: Record<string, CodeTraceDoc[]> = {}
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
    await markTracesAnalyzed(traces)
    return { traces: traces.length, rules: 0 }
  }

  const summaryResponse = await callLLM({
    ...providerCfg,
    messages: [
      {
        role: "system",
        content:
          "Eres un analista de patrones de ejecucion de agentes de software. " +
          "Analiza las trazas de ejecucion y genera reglas de playbook concisas. " +
          "Cada regla debe ser una instruccion practica que mejore el comportamiento futuro del coordinador. " +
          "Formato de salida: una regla por linea, sin numeracion, sin markdown.",
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
      if (await upsertPlaybookRule(rule, firstCoord, "reflector", 0.5)) inserted++
    } catch { /* skip */ }
  }

  try {
    const reflections = await col<CodeReflectionDoc>("codeReflections")
    const id = Bun.randomUUIDv7()
    await reflections.put(id, {
      id,
      traces_analyzed: traces.length,
      insights: rules.join("\n"),
      ethics_violation: false,
      created_at: nowIso(),
    }, { expectedVersion: 0 })
  } catch { /* optional */ }

  await markTracesAnalyzed(traces)
  _lastReflectorRun = Date.now()
  _tasksSinceLastReflector = 0

  try { await extractDeveloperPreferences() } catch { /* optional */ }

  logger.info(`[reflector] ${traces.length} trazas analizadas, ${inserted} reglas generadas`)
  return { traces: traces.length, rules: inserted }
}

async function markTracesAnalyzed(traces: CodeTraceDoc[]): Promise<void> {
  const traceCol = await col<CodeTraceDoc>("codeTraces")
  for (const trace of traces) {
    const existing = await traceCol.get(trace.id)
    if (!existing) continue
    await traceCol.put(trace.id, { ...existing.doc, analyzed: true }, { expectedVersion: existing.version })
  }
}

export function incrementTaskCounter(): void {
  _tasksSinceLastReflector++
}

export function shouldRunReflector(_db?: unknown): boolean {
  if (_tasksSinceLastReflector >= REFLECTOR_TASK_INTERVAL) return true
  if (Date.now() - _lastReflectorRun >= REFLECTOR_TIME_INTERVAL_MS) return true
  return false
}
