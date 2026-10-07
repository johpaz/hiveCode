/**
 * Identity helpers for the UUIDv7 ids HiveDB documents use.
 *
 * A UUIDv7 leads with a 48-bit millisecond timestamp, so the FIRST 8 hex
 * characters are IDENTICAL for every document created inside the same ~65 second
 * window — which is every document a person starts back to back. A chip shown
 * to the user, or typed back by one, must therefore come from the random tail.
 *
 * These helpers exist so that rule is stated once. They deliberately do NOT use
 * a secondary index: resolving a fragment has to consider both ends of the id,
 * so it reads the collection and filters, and the collections involved (tasks,
 * sessions) are small enough for that to be cheap.
 */
import { col } from "./hive";

/** The random tail of an id — the only part safe to show and accept back. */
export function shortId(id: string, length = 8): string {
  return id.slice(-length);
}

export interface IdCandidate<T> {
  id: string;
  doc: T;
  version: number;
}

export type IdResolution<T> =
  | { kind: "hit"; match: IdCandidate<T> }
  /** More than one document matches — the caller must ask, not guess. */
  | { kind: "ambiguous"; candidates: IdCandidate<T>[] }
  | { kind: "none" };

/**
 * Resolve a user-supplied id fragment to exactly one document.
 *
 * Order: a full id wins outright; otherwise both the tail and the leading-prefix
 * forms are considered TOGETHER, because a fragment can be the tail of one
 * document and the head of another — that is ambiguous, not a tail match.
 *
 * Never returns a guess. The callers are mutating commands (`cancel`,
 * `rollback`, `resume`), where picking the first of several matches would act on
 * the wrong document — and with UUIDv7 a leading-prefix "match" can be a whole
 * window of documents created seconds apart.
 */
export async function resolveIdFragment<T>(collection: string, fragment: string): Promise<IdResolution<T>> {
  const wanted = fragment.trim();
  if (!wanted) return { kind: "none" };

  const docs = await col<T>(collection);

  // A pasted full id is unambiguous regardless of the tail/head rule.
  const exact = await docs.get(wanted);
  if (exact) return { kind: "hit", match: { id: wanted, doc: exact.doc, version: exact.version } };

  const matches = (await docs.scan())
    .filter((entry) => entry.id.endsWith(wanted) || entry.id.startsWith(wanted))
    .map((entry) => ({ id: entry.id, doc: entry.doc, version: entry.version }));

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "hit", match: matches[0] };
  return { kind: "ambiguous", candidates: matches };
}

/**
 * Render an ambiguity for the user: what collided, and what to type instead.
 * Shared so the picker, the task commands and the CLI all say the same thing.
 */
export function formatIdCandidates(
  candidates: ReadonlyArray<{ id: string; label?: string }>,
): string {
  return candidates
    .map((candidate) => `  ${shortId(candidate.id)}  ${candidate.label ?? ""}`.trimEnd())
    .join("\n");
}