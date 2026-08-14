import { col } from "../../storage/hive"
import type { ModelDoc, ProviderDoc } from "../../storage/collections"
import { getProviderApiKey } from "../../storage/crypto"
import { logger } from "../../utils/logger"
import {
  HIVEAGENTS_DEFAULT_LOAD_CTX,
  HIVEAGENTS_MODEL_ID,
  HIVEAGENTS_OPENAI_BASE_URL,
  getHiveAgentsModelStatus,
  ensureHiveAgentsModelReady,
  type HiveAgentsLoadResult,
  type HiveAgentsStatusResult,
} from "./hiveagents"

export {
  HIVEAGENTS_DEFAULT_LOAD_CTX,
  HIVEAGENTS_BASE_URL,
  HIVEAGENTS_MODEL_ID,
  HIVEAGENTS_OPENAI_BASE_URL,
} from "./hiveagents"

const log = logger.child("hiveagents-loader")

export interface HiveAgentsResolvedLoadConfig {
  modelId: string
  apiKey: string | null
  baseUrl?: string
  ctx: number
}

export interface HiveAgentsModelLoadResult extends HiveAgentsLoadResult {
  model_id: string
  ctx: number
  skipped?: boolean
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export async function resolveHiveAgentsModelLoadConfig(
  modelId: string,
  explicitCtx?: number
): Promise<HiveAgentsResolvedLoadConfig> {
  const providersCol = await col<ProviderDoc>("providers")
  const modelsCol = await col<ModelDoc>("models")
  const providerRow = (await providersCol.get("hiveagents"))?.doc
  const modelRow = (await modelsCol.get(modelId))?.doc

  return {
    modelId: HIVEAGENTS_MODEL_ID,
    apiKey: await getProviderApiKey("hiveagents"),
    baseUrl: providerRow?.base_url ?? HIVEAGENTS_OPENAI_BASE_URL,
    ctx: positiveNumber(modelRow?.context_window)
      ?? positiveNumber(explicitCtx)
      ?? HIVEAGENTS_DEFAULT_LOAD_CTX,
  }
}

export async function loadHiveAgentsModelFromDb(
  modelId: string,
  explicitCtx?: number
): Promise<HiveAgentsModelLoadResult> {
  const config = await resolveHiveAgentsModelLoadConfig(modelId, explicitCtx)
  if (!config.apiKey) {
    return {
      success: false,
      model_id: HIVEAGENTS_MODEL_ID,
      ctx: config.ctx,
      error: "API key not configured for hiveagents",
    }
  }

  log.info(`[hiveagents] Loading ${HIVEAGENTS_MODEL_ID} with ctx=${config.ctx} and waiting until ready`)
  const result = await ensureHiveAgentsModelReady(
    config.apiKey,
    undefined,
    1000,
    300000,
    config.ctx,
  )
  return {
    ...result,
    model_id: HIVEAGENTS_MODEL_ID,
    ctx: config.ctx,
  }
}

export async function maybeLoadHiveAgentsModelFromDb(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  explicitCtx?: number
): Promise<HiveAgentsModelLoadResult> {
  if (providerId !== "hiveagents" || !modelId) {
    return {
      success: true,
      skipped: true,
      model_id: modelId || "",
      ctx: positiveNumber(explicitCtx) ?? HIVEAGENTS_DEFAULT_LOAD_CTX,
    }
  }

  return loadHiveAgentsModelFromDb(modelId, explicitCtx)
}

export async function getHiveAgentsModelStatusFromDb(): Promise<HiveAgentsStatusResult> {
  const providersCol = await col<ProviderDoc>("providers")
  const providerRow = (await providersCol.get("hiveagents"))?.doc
  const apiKey = await getProviderApiKey("hiveagents")
  if (!apiKey) return { loaded: false }
  return getHiveAgentsModelStatus(apiKey, providerRow?.base_url ?? undefined)
}
