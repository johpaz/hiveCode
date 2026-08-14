import { loadConfig } from "../../config/loader.ts"
import { col } from "../../storage/hive"
import type { ConversationDoc, UsageRecordDoc } from "../../storage/collections"
import pkg from "../../../../../package.json"

const CURRENT_VERSION = pkg.version

export interface VersionInfo {
  current: string
  latest?: string
  status: "up-to-date" | "update-available" | "checking" | "error"
  error?: string
  installationType?: "binary" | "npm" | "bun"
}

/**
 * Detecta el tipo de instalación de Hive
 */
function detectInstallationType(): | "binary" | "npm" | "bun" {
  // Docker: existe el archivo .dockerenv o el path contiene /.docker

  // Bun: process.execPath contiene "bun"
  if (process.execPath?.includes("bun")) {
    return "bun"
  }

  // npm: las variables de entorno de npm
  if (process.env.npm_config_global_prefix) {
    return "npm"
  }

  // Por defecto, asumir binario standalone
  return "binary"
}

/**
 * Obtiene la versión más reciente desde npm registry
 */
async function getLatestVersionFromNpm(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch("https://registry.npmjs.org/@johpaz/hive-agents/latest", {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    })

    clearTimeout(timeout)

    if (!response.ok) {
      return null
    }

    const data = await response.json()
    return data.version
  } catch (error) {
    console.error("[Version] Error fetching from npm:", (error as Error).message)
    return null
  }
}

/**
 * Obtiene la versión más reciente desde GitHub Releases
 */
async function getLatestVersionFromGitHub(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch("https://api.github.com/repos/johpaz/hiveCode /releases/latest", {
      signal: controller.signal,
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Hive-Version-Checker"
      }
    })

    clearTimeout(timeout)

    if (!response.ok) {
      return null
    }

    const data = await response.json()
    // Remover prefijo "v" si existe (ej: "v1.7.15" -> "1.7.15")
    return data.tag_name?.replace(/^v/, "") || null
  } catch (error) {
    console.error("[Version] Error fetching from GitHub:", (error as Error).message)
    return null
  }
}

/**
 * Compara dos versiones semánticas
 * Retorna: 1 si v1 > v2, -1 si v1 < v2, 0 si son iguales
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number)
  const parts2 = v2.split(".").map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const n1 = parts1[i] || 0
    const n2 = parts2[i] || 0

    if (n1 > n2) return 1
    if (n1 < n2) return -1
  }

  return 0
}

/**
 * Handler para obtener información de versión
 */
export async function handleGetVersion(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  const installationType = detectInstallationType()

  // Responder inmediatamente con la versión actual y estado "checking"
  let versionInfo: VersionInfo = {
    current: CURRENT_VERSION,
    status: "checking",
    installationType
  }

  // Siempre verificar en npm registry (es donde se publica @johpaz/hive-agents)
  // GitHub Releases solo como fallback si npm falla
  const latest = await getLatestVersionFromNpm()
    .then(v => v ?? getLatestVersionFromGitHub())

  if (latest) {
    const isUpdateAvailable = compareVersions(latest, CURRENT_VERSION) > 0
    versionInfo = {
      current: CURRENT_VERSION,
      latest,
      status: isUpdateAvailable ? "update-available" : "up-to-date",
      installationType
    }
  } else {
    versionInfo = {
      current: CURRENT_VERSION,
      status: "error",
      error: "No se pudo verificar la última versión. Verifica tu conexión a internet.",
      installationType
    }
  }

  return addCorsHeaders(Response.json(versionInfo), req)
}

/**
 * Handler para triggerar una actualización
 */
export async function handleTriggerUpdate(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response
): Promise<Response> {
  const installationType = detectInstallationType()

  try {
    let command: string[]
    let message: string

    switch (installationType) {
      case "bun":
        command = ["bun", "install", "-g", "@johpaz/hive-agents@latest"]
        message = "Actualizando Hive desde npm..."
        break

      case "npm":
        command = ["npm", "install", "-g", "@johpaz/hive-agents@latest"]
        message = "Actualizando Hive desde npm..."
        break

      case "binary":
        return addCorsHeaders(Response.json({
          success: false,
          error: "Para actualizar el binario, descarga la última versión desde https://github.com/johpaz/hive/releases/latest",
          instructions: [
            "1. Visita https://github.com/johpaz/hive/releases/latest",
            "2. Descarga el binario para tu sistema operativo",
            "3. Reemplaza el archivo existente",
            "4. Ejecuta: hive start"
          ]
        }), req)

      default:
        return addCorsHeaders(Response.json({
          success: false,
          error: "Tipo de instalación no reconocido"
        }), req)
    }

    // Ejecutar comando de actualización
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])

    if (exitCode === 0) {
      return addCorsHeaders(Response.json({
        success: true,
        message: "Hive actualizado correctamente. Reinicia el gateway para aplicar los cambios.",
        output: stdout || stderr,
        instructions: [
          "1. Ejecuta: hive stop",
          "2. Luego ejecuta: hive start",
          "3. Recarga esta página para ver la nueva versión"
        ]
      }), req)
    } else {
      return addCorsHeaders(Response.json({
        success: false,
        error: "Error durante la actualización",
        output: stderr || stdout
      }), req)
    }
  } catch (error) {
    return addCorsHeaders(Response.json({
      success: false,
      error: (error as Error).message
    }), req)
  }
}

export function getSystemStats(startTime: number) {
  const mem = process.memoryUsage()
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000)
  const uptimeStr = new Date(uptimeSeconds * 1000).toISOString().substr(11, 8)

  return {
    cpu: 0, // Placeholder - Node.js doesn't provide per-process CPU
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024), // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
      heapPercent: Math.round((mem.heapUsed / mem.heapTotal) * 100 * 100) / 100,
      external: Math.round((mem.external || 0) / 1024 / 1024), // MB
    },
    uptime: uptimeStr,
    connections: 0, // Placeholder
    cores: navigator.hardwareConcurrency,
    recentMessages: 0, // Placeholder
  }
}

export async function handleGetActivityStats(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const hours = parseInt(url.searchParams.get("hours") || "12", 10)

  // Get message counts per hour from conversations table
  const now = Date.now()
  const startTime = now - (hours * 60 * 60 * 1000)

  const buckets = new Map<string, number>()
  const rows = (await (await col<ConversationDoc>("conversations")).scan()).map((entry) => entry.doc)
  for (const row of rows) {
    if (row.created_at < startTime) continue
    const hour = new Date(row.created_at).toISOString().slice(0, 13).replace("T", " ") + ":00"
    buckets.set(hour, (buckets.get(hour) ?? 0) + 1)
  }

  // Format as array expected by frontend
  const activityData = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, count]) => ({ time, count }))

  return addCorsHeaders(Response.json(activityData), req)
}

export async function handleGetSystemStats(req: Request, addCorsHeaders: (r: Response, req: Request) => Response, startTime: number): Promise<Response> {
  return addCorsHeaders(Response.json(getSystemStats(startTime)), req)
}

export async function handleGetUsageStats(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  // Get hours parameter from URL (default to 24 hours)
  const url = new URL(req.url)
  const hours = parseInt(url.searchParams.get("hours") || "24", 10)
  const since = Date.now() - (hours * 3600 * 1000)
  const records = (await (await col<UsageRecordDoc>("usageRecords")).scan())
    .map((entry) => entry.doc)
    .filter((record) => record.created_at >= since)

  const normal = records.filter((record) => record.provider !== "toon")
  const toon = records.filter((record) => record.provider === "toon")
  const totals = normal.reduce((acc, record) => ({
    inputTokens: acc.inputTokens + record.input_tokens,
    outputTokens: acc.outputTokens + record.output_tokens,
    costUsd: acc.costUsd + record.cost_usd,
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 })

  const toonTotals = toon.reduce((acc, record) => ({
    toonSavedTokens: acc.toonSavedTokens + record.toon_saved_tokens,
    toonSavedCost: acc.toonSavedCost + record.toon_saved_cost,
    toonSavedBytes: acc.toonSavedBytes + record.toon_saved_bytes,
    toonSavedPercent: acc.toonSavedPercent + record.toon_saved_percent,
    toonJsonTokens: acc.toonJsonTokens + record.toon_json_tokens,
    toonToonTokens: acc.toonToonTokens + record.toon_toon_tokens,
    toonJsonBytes: acc.toonJsonBytes + record.toon_json_bytes,
    toonSavedTokensPct: acc.toonSavedTokensPct + record.toon_saved_tokens_pct,
  }), {
    toonSavedTokens: 0,
    toonSavedCost: 0,
    toonSavedBytes: 0,
    toonSavedPercent: 0,
    toonJsonTokens: 0,
    toonToonTokens: 0,
    toonJsonBytes: 0,
    toonSavedTokensPct: 0,
  })
  if (toon.length > 0) {
    toonTotals.toonSavedPercent /= toon.length
    toonTotals.toonSavedTokensPct /= toon.length
  }

  const byProviderRows = aggregateUsage(normal, "provider")
  const byModelRows = aggregateUsage(normal, "model")

  const totalTokens = (totals.inputTokens || 0) + (totals.outputTokens || 0)
  const totalCostUsd = totals.costUsd || 0

  // Use TOON totals directly from DB - no calculations needed
  const toonSavedTokens = toonTotals?.toonSavedTokens || 0
  const toonSavedCost = toonTotals?.toonSavedCost || 0
  const toonSavedBytes = toonTotals?.toonSavedBytes || 0
  const toonJsonBytes = toonTotals?.toonJsonBytes || 0
  const toonJsonTokens = toonTotals?.toonJsonTokens || 0
  const toonToonTokens = toonTotals?.toonToonTokens || 0

  // Use saved_percent directly from DB (calculated at record time by toon-format-parser)
  const toonSavedBytesPercent = toonTotals?.toonSavedPercent || 0

  // Use saved_tokens_pct directly from DB (calculated at record time by toon-format-parser)
  const toonSavingsPercent = toonTotals?.toonSavedTokensPct || 0

  const stats: UsageStats = {
    totalTokens,
    totalInputTokens: totals.inputTokens || 0,
    totalOutputTokens: totals.outputTokens || 0,
    totalCostUsd,
    toonSavedTokens,
    toonSavedCost,
    toonSavedBytes,
    toonSavedBytesPercent,
    toonJsonTokens,
    toonToonTokens,
    toonSavingsPercent,
    byProvider: Object.fromEntries(
      byProviderRows.map(r => [r.provider, {
        tokens: (r.inputTokens || 0) + (r.outputTokens || 0),
        costUsd: r.costUsd || 0,
        inputTokens: r.inputTokens || 0,
        outputTokens: r.outputTokens || 0,
      }])
    ),
    byModel: Object.fromEntries(
      byModelRows.map(r => [r.model, {
        tokens: (r.inputTokens || 0) + (r.outputTokens || 0),
        costUsd: r.costUsd || 0,
        provider: "unknown",
        inputTokens: r.inputTokens || 0,
        outputTokens: r.outputTokens || 0,
      }])
    ),
  }

  return addCorsHeaders(Response.json(stats), req)
}

function aggregateUsage(records: UsageRecordDoc[], field: "provider" | "model") {
  const grouped = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>()
  for (const record of records) {
    const key = record[field]
    const cur = grouped.get(key) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    cur.inputTokens += record.input_tokens
    cur.outputTokens += record.output_tokens
    cur.costUsd += record.cost_usd
    grouped.set(key, cur)
  }
  return [...grouped.entries()].map(([key, value]) => ({
    [field]: key,
    ...value,
  })) as Array<Record<typeof field, string> & { inputTokens: number; outputTokens: number; costUsd: number }>
}

// Add UsageStats interface for backend
interface UsageStats {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  toonSavedTokens: number;
  toonSavedCost: number;
  toonSavedBytes: number;
  toonSavedBytesPercent: number;
  toonJsonTokens: number;
  toonToonTokens: number;
  toonSavingsPercent: number;
  byProvider: Record<string, { tokens: number; costUsd: number; inputTokens: number; outputTokens: number }>;
  byModel: Record<string, { tokens: number; costUsd: number; provider: string; inputTokens: number; outputTokens: number }>;
}

export async function handleSystemReload(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  return addCorsHeaders(Response.json({ success: true, message: "Reload triggered" }), req)
}

export async function handleApiReload(
  req: Request,
  addCorsHeaders: (r: Response, req: Request) => Response,
  agent?: any
): Promise<Response> {
  try {
    const newConfig = await loadConfig()
    if (agent) {
      await agent.updateConfig(newConfig)
      await agent.reload()
    }
    return addCorsHeaders(Response.json({ success: true, message: "Configuration reloaded" }), req)
  } catch (error) {
    return addCorsHeaders(Response.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    ), req)
  }
}
