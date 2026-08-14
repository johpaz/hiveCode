/**
 * ACE Curator — converts reflections into playbook rules.
 *
 * Runs after the Reflector. Performs incremental edits to the HiveDB playbook:
 * new insights become rules, repeated patterns reinforce existing rules, and
 * unused workers are archived.
 */

import { col, nextId, toIndexable } from "../storage/hive"
import type { AgentDoc, CursorDoc, PlaybookDoc, ReflectionDoc } from "../storage/collections"
import { logger } from "../utils/logger"

const log = logger.child("curator")

const DAYS_BEFORE_ARCHIVE = 14
const MAX_HARMFUL_BEFORE_PRUNE = 3
const CURSOR_ID = "curator:lastReflection"

export async function runCurator(): Promise<void> {
  try {
    const cursors = await col<CursorDoc>("cursors")
    const playbook = await col<PlaybookDoc>("playbook")
    const reflections = await col<ReflectionDoc>("reflections")
    const agents = await col<AgentDoc>("agents")

    const cursorEntry = await cursors.get(CURSOR_ID)
    const lastProcessed = cursorEntry?.doc.value ?? null
    let candidates = lastProcessed
      ? await reflections.scan({ start: lastProcessed })
      : await reflections.scan({})
    if (lastProcessed && candidates[0]?.id === lastProcessed) candidates = candidates.slice(1)

    if (candidates.length === 0) {
      log.debug("[curator] No new reflections to process")
    } else {
      log.info(`[curator] Processing ${candidates.length} new reflections`)
      const allPlaybook = await playbook.scan()
      for (const entry of candidates) {
        await processReflection(playbook, allPlaybook, entry.doc)
      }
      const newCursor = candidates[candidates.length - 1].id
      await cursors.put(CURSOR_ID, { value: newCursor, updated_at: Date.now() }, { expectedVersion: cursorEntry?.version ?? 0 })
    }

    for (const entry of await playbook.scan()) {
      if (
        entry.doc.active &&
        entry.doc.harmful_count > entry.doc.helpful_count &&
        entry.doc.harmful_count >= MAX_HARMFUL_BEFORE_PRUNE
      ) {
        await playbook.put(entry.id, { ...entry.doc, active: false, updated_at: Date.now() }, { expectedVersion: entry.version })
      }
    }

    const cutoff = Date.now() - DAYS_BEFORE_ARCHIVE * 86400_000
    const staleWorkers = (await agents.scan()).filter((entry) =>
      entry.doc.role === "worker" &&
      entry.doc.status !== "archived" &&
      entry.doc.enabled &&
      (entry.doc.lastTraceAt ?? 0) < cutoff
    )

    for (const worker of staleWorkers) {
      await agents.put(worker.id, { ...worker.doc, status: "archived", updated_at: Date.now() }, { expectedVersion: worker.version })
      await addOrUpdateRule(playbook, await playbook.scan(), {
        rule: `Worker '${worker.doc.name}' was archived due to inactivity (>${DAYS_BEFORE_ARCHIVE} days unused).`,
        category: "agent_creation",
        applicable_to: null,
        sourceReflectionId: null,
      })
      log.info(`[curator] Archived inactive worker: ${worker.doc.name} (${worker.id})`)
    }

    log.info("[curator] Playbook updated")
  } catch (err) {
    log.warn("[curator] Error:", err)
  }
}

async function processReflection(
  playbook: Awaited<ReturnType<typeof col<PlaybookDoc>>>,
  allPlaybook: Array<{ id: string; version: number; doc: PlaybookDoc }>,
  reflection: ReflectionDoc
): Promise<void> {
  const category = mapInsightTypeToCategory(reflection.insight_type)
  const prefix = reflection.description.substring(0, 60)
  const existing = allPlaybook.find((entry) => entry.doc.active && entry.doc.rule.startsWith(prefix))

  if (existing) {
    await playbook.put(existing.id, {
      ...existing.doc,
      helpful_count: existing.doc.helpful_count + 1,
      updated_at: Date.now(),
    }, { expectedVersion: existing.version })
    return
  }

  const id = await nextId("playbook")
  const now = Date.now()
  const doc: PlaybookDoc = {
    id,
    rule: reflection.description,
    category,
    applicable_to: reflection.affected_tools ? JSON.stringify(JSON.parse(reflection.affected_tools)) : null,
    helpful_count: 1,
    harmful_count: 0,
    source_reflection_id: toIndexable(reflection.id),
    active: true,
    created_at: now,
    updated_at: now,
  }
  await playbook.put(id, doc, { expectedVersion: 0 })
  allPlaybook.push({ id, version: 1, doc })
}

function mapInsightTypeToCategory(
  type: string
): "tool_selection" | "response_quality" | "error_avoidance" | "optimization" | "agent_creation" {
  const map: Record<string, any> = {
    success_pattern: "tool_selection",
    failure_pattern: "error_avoidance",
    optimization: "optimization",
    ethics_violation: "error_avoidance",
  }
  return map[type] ?? "optimization"
}

async function addOrUpdateRule(
  playbook: Awaited<ReturnType<typeof col<PlaybookDoc>>>,
  allPlaybook: Array<{ id: string; version: number; doc: PlaybookDoc }>,
  opts: {
    rule: string
    category: string
    applicable_to: string | null
    sourceReflectionId: string | null
  }
): Promise<void> {
  const prefix = opts.rule.substring(0, 60)
  const existing = allPlaybook.find((entry) => entry.doc.rule.startsWith(prefix))

  if (existing) {
    await playbook.put(existing.id, {
      ...existing.doc,
      helpful_count: existing.doc.helpful_count + 1,
      updated_at: Date.now(),
    }, { expectedVersion: existing.version })
    return
  }

  const id = await nextId("playbook")
  const now = Date.now()
  await playbook.put(id, {
    id,
    rule: opts.rule,
    category: opts.category,
    applicable_to: opts.applicable_to,
    helpful_count: 1,
    harmful_count: 0,
    source_reflection_id: toIndexable(opts.sourceReflectionId),
    active: true,
    created_at: now,
    updated_at: now,
  }, { expectedVersion: 0 })
}
