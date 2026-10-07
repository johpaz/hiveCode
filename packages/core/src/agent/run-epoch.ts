/**
 * Run epoch — the exact conditions a run executed under.
 *
 * Provider, model, app version and a fingerprint of the tool catalog. A change
 * in any of them is a requalification event: the same agent, asked the same
 * thing, is no longer the same system, so patterns measured across the boundary
 * are not comparable.
 *
 * The consumer is the reflector (see analyzeTracesLocally's epoch check): a trace
 * batch that spans two catalogs produces insights whose confidence cannot be
 * trusted, and this is what lets it notice.
 */
import rootPackage from "../../../../package.json"

/** Stable non-cryptographic hash (djb2) over sorted tool names. */
function hashToolNames(names: string[]): string {
  const sorted = [...names].sort().join(",")
  let hash = 5381
  for (let i = 0; i < sorted.length; i++) {
    hash = ((hash * 33) ^ sorted.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

export interface RunEpoch {
  provider: string;
  model: string;
  app_version: string;
  tool_catalog_hash: string;
}

export function buildRunEpoch(opts: { provider: string; model: string; toolNames: string[] }): RunEpoch {
  return {
    provider: opts.provider,
    model: opts.model,
    app_version: (rootPackage as { version?: string }).version ?? "0.0.0",
    tool_catalog_hash: hashToolNames(opts.toolNames),
  }
}

/** Compact, sortable form persisted alongside a trace. */
export function formatEpochKey(epoch: RunEpoch): string {
  return `${epoch.provider}/${epoch.model}@${epoch.app_version}#${epoch.tool_catalog_hash}`
}

/** Parse a stored key back, for callers that want the fields rather than the string. */
export function parseEpochKey(key: string): RunEpoch | null {
  const at = key.lastIndexOf("@")
  const hash = key.indexOf("#")
  if (at === -1 || hash === -1 || hash < at) return null
  const modelPart = key.slice(0, at)
  const slash = modelPart.indexOf("/")
  if (slash === -1) return null
  return {
    provider: modelPart.slice(0, slash),
    model: modelPart.slice(slash + 1),
    app_version: key.slice(at + 1, hash),
    tool_catalog_hash: key.slice(hash + 1),
  }
}

/** The distinct epochs in a batch. Traces with no epoch are ignored. */
export function distinctEpochKeys(keys: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  for (const k of keys) if (k) seen.add(k)
  return [...seen]
}

/**
 * The shared epoch of a batch, or undefined when it straddles a requalification
 * boundary. Absent keys count as their own kind: an unstamped trace is not
 * evidence that the rest of the batch agrees.
 */
export function commonEpochKey(keys: Array<string | null | undefined>): string | undefined {
  const present = keys.filter((k): k is string => !!k)
  if (present.length === 0) return undefined
  const distinct = new Set(present)
  return distinct.size === 1 && keys.every(k => !!k) ? present[0] : undefined
}