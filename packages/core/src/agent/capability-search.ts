/**
 * Capability search over HiveDB.
 *
 * Central HiveDB BM25/hybrid index for native tools, skills, playbook rules,
 * MCP tools and source-code snippets.
 */

import type { IndexDoc } from "@johpaz/hive-db";
import { getHiveDb } from "../storage/hivedb";
import { logger } from "../utils/logger";

const log = logger.child("capability-search");

export type CapabilityType = "tool" | "skill" | "playbook" | "mcp" | "code";

export interface CapabilityHit {
  id: string;
  type: CapabilityType;
  rawId: string;
  score: number;
}

export interface CapabilityDoc {
  type: CapabilityType;
  rawId: string;
  name?: string;
  body?: string;
  tags?: string;
  extraFilters?: Array<{ field: string; value: string }>;
}

export interface SearchCapabilitiesOptions {
  types?: CapabilityType[];
  k?: number;
  filters?: Array<{ field: string; value: string }>;
  boosts?: { name?: number; body?: number; tags?: number };
}

const TYPE_PREFIXES: CapabilityType[] = ["tool", "skill", "playbook", "mcp", "code"];

function splitId(id: string): { type: CapabilityType; rawId: string } | null {
  const sep = id.indexOf(":");
  if (sep === -1) return null;
  const type = id.slice(0, sep) as CapabilityType;
  if (!TYPE_PREFIXES.includes(type)) return null;
  return { type, rawId: id.slice(sep + 1) };
}

export async function searchCapabilities(
  query: string,
  opts: SearchCapabilitiesOptions = {}
): Promise<CapabilityHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const k = opts.k ?? 10;
  const db = await getHiveDb();
  const start = performance.now();
  const types = opts.types?.length ? opts.types : undefined;
  const queries = types
    ? types.map((type) => ({ filters: [{ field: "type", value: type }] }))
    : [{ filters: undefined }];

  const merged = new Map<string, CapabilityHit>();
  for (const q of queries) {
    const hits = await db.queryHybrid({
      text: trimmed,
      k,
      filters: [
        ...(q.filters ?? []),
        ...(opts.filters ?? []),
      ],
      boosts: opts.boosts,
    });
    for (const hit of hits) {
      const parsed = splitId(hit.id);
      if (!parsed) continue;
      const existing = merged.get(hit.id);
      if (!existing || hit.score > existing.score) {
        merged.set(hit.id, {
          id: hit.id,
          type: parsed.type,
          rawId: parsed.rawId,
          score: hit.score,
        });
      }
    }
  }

  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, k);
  log.debug(`[capability-search] "${trimmed.slice(0, 80)}" -> ${results.length} hits in ${(performance.now() - start).toFixed(1)}ms`);
  return results;
}

export function applyRelativeCutoff(hits: CapabilityHit[], ratio = 0.3): CapabilityHit[] {
  if (hits.length === 0) return hits;
  const top = hits[0].score;
  if (top <= 0) return [];
  return hits.filter((hit) => hit.score >= ratio * top);
}

export async function replaceCapabilityDocs(type: CapabilityType, docs: CapabilityDoc[]): Promise<void> {
  const db = await getHiveDb();
  await db.deleteByFilter({ field: "type", value: type });
  if (docs.length === 0) return;
  await db.upsertBatch(docs.map(toIndexDoc));
}

export async function upsertCapabilityDocs(docs: CapabilityDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const db = await getHiveDb();
  await db.upsertBatch(docs.map(toIndexDoc));
}

export async function deleteCapabilitiesByServer(serverId: string): Promise<void> {
  const db = await getHiveDb();
  await db.deleteByFilter({ field: "server_id", value: serverId });
}

export async function deleteCapabilitiesByFilter(field: string, value: string): Promise<void> {
  const db = await getHiveDb();
  await db.deleteByFilter({ field, value });
}

function toIndexDoc(doc: CapabilityDoc): IndexDoc {
  return {
    id: `${doc.type}:${doc.rawId}`,
    name: doc.name,
    body: doc.body,
    tags: doc.tags,
    filters: [
      { field: "type", value: doc.type },
      ...(doc.extraFilters ?? []),
    ],
  };
}
