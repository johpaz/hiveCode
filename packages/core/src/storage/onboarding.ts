import { getDb } from "./sqlite.ts";

export function resolveUserId(): string {
  try {
    const row = getDb().query("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    return row?.id ?? "default";
  } catch {
    return "default";
  }
}

export function resolveAgentId(): string {
  try {
    const db = getDb();
    const row = db.query(
      "SELECT id FROM agents WHERE role = 'coordinator' AND enabled = 1 ORDER BY created_at ASC LIMIT 1"
    ).get() as { id: string } | undefined;
    if (row) return row.id;

    // No coordinator exists — create a minimal default one
    const userId = resolveUserId();
    const userRef = userId !== "default"
      ? db.query("SELECT id FROM users WHERE id = ?").get(userId) as { id: string } | undefined
      : undefined;

    db.query(`
      INSERT OR IGNORE INTO agents (id, name, description, role, status, enabled, max_iterations)
      VALUES ('default', 'Bee', 'Asistente coordinador principal', 'coordinator', 'idle', 1, 15)
    `).run();

    if (userRef) {
      db.query("UPDATE agents SET user_id = ? WHERE id = 'default'").run(userId);
    }

    return "default";
  } catch {
    return "default";
  }
}

export function runStartupMigrations(): void {
}
