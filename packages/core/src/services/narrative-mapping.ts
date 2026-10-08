import type { CodeDecisionDoc } from "../storage/collections";
export function mapDecision(r: CodeDecisionDoc) {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    context: r.context,
    options: r.options,
    decision: r.decision,
    consequences: r.consequences,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function narrativeMatches(entry: {entry: string; coordinator: string; phase?: string | null}, query: string): boolean {
  const needle = query.toLowerCase();
  return entry.entry.toLowerCase().includes(needle) || entry.coordinator.toLowerCase().includes(needle)
    || (entry.phase ?? "").toLowerCase().includes(needle);
}
