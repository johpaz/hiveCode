/**
 * Shared HiveDB collection helpers.
 */

import { getHiveDb } from "./hivedb";

const MAX_RETRIES = 5;

export const NO_PARENT = "__none__";
export const BROADCAST = "*";

export function toIndexable(value: string | null | undefined): string {
  return value ?? NO_PARENT;
}

export function fromIndexable(value: string | null | undefined): string | null {
  return value === NO_PARENT ? null : value ?? null;
}

export async function col<T>(name: string) {
  const db = await getHiveDb();
  return db.collection<T>(name);
}

export async function nextId(counterName: string): Promise<string> {
  const counters = await col<{ value: number }>("counters");
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const cur = await counters.get(counterName);
    const next = (cur?.doc.value ?? 0) + 1;
    try {
      await counters.put(counterName, { value: next }, { expectedVersion: cur?.version ?? 0 });
      return String(next).padStart(15, "0");
    } catch {
      // Version conflict: retry with a fresh read.
    }
  }
  throw new Error(`nextId: too much contention on counter "${counterName}"`);
}

export async function putIfAbsent<T>(collection: string, id: string, doc: T): Promise<boolean> {
  const c = await col<T>(collection);
  if (await c.get(id)) return false;
  await c.put(id, doc, { expectedVersion: 0 });
  return true;
}

export async function updateDoc<T extends object>(
  collection: string,
  id: string,
  patch: Partial<T>
): Promise<T> {
  const c = await col<T>(collection);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const existing = await c.get(id);
    if (!existing) throw new Error(`${collection}/${id} not found`);
    const merged = { ...existing.doc, ...patch };
    try {
      await c.put(id, merged, { expectedVersion: existing.version });
      return merged;
    } catch {
      // Version conflict: retry.
    }
  }
  throw new Error(`updateDoc: too much contention on ${collection}/${id}`);
}

export async function updateManyByIndex<T extends object>(
  collection: string,
  field: string,
  value: string | number | boolean,
  patch: Partial<T>
): Promise<number> {
  const c = await col<T>(collection);
  const rows = await c.findBy(field, value);
  for (const row of rows) await updateDoc<T>(collection, row.id, patch);
  return rows.length;
}

export async function findByAny<T>(
  collection: string,
  field: string,
  values: Array<string | number | boolean>
) {
  const c = await col<T>(collection);
  const uniq = [...new Set(values)];
  const chunks = await Promise.all(uniq.map((value) => c.findBy(field, value)));
  return chunks.flat();
}

export async function bumpRollup(
  collection: string,
  id: string,
  delta: Record<string, number>,
  nested?: { field: string; key: string }
): Promise<void> {
  const c = await col<Record<string, any>>(collection);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const existing = await c.get(id);
    const doc: Record<string, any> = existing ? { ...existing.doc } : {};
    for (const [key, value] of Object.entries(delta)) {
      doc[key] = (doc[key] ?? 0) + value;
    }
    if (nested) {
      doc[nested.field] = { ...(doc[nested.field] ?? {}) };
      doc[nested.field][nested.key] = { ...(doc[nested.field][nested.key] ?? {}) };
      for (const [key, value] of Object.entries(delta)) {
        doc[nested.field][nested.key][key] = (doc[nested.field][nested.key][key] ?? 0) + value;
      }
    }
    try {
      await c.put(id, doc, { expectedVersion: existing?.version ?? 0 });
      return;
    } catch {
      // Version conflict: retry.
    }
  }
  throw new Error(`bumpRollup: too much contention on ${collection}/${id}`);
}
