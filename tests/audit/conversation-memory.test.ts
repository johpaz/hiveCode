import { test, expect, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getHiveDb, closeHiveDb } from "../../packages/core/src/storage/hivedb";
import { saveSummary, getSummary } from "../../packages/core/src/agent/conversation-store";
import { relevantConversationMemory, rememberConversationSummary } from "../../packages/core/src/agent/conversation-memory";
import { estimateTokens } from "../../packages/core/src/utils/toon";

test("historical summaries are searchable within session/project with bounded context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-conversation-memory-"));
  const original = process.env.HIVE_DB_PATH;
  closeHiveDb(); process.env.HIVE_DB_PATH = path.join(root, "db");
  try {
    let db = await getHiveDb();
    const sessions = db.collection<any>("codeSessions");
    for (const [id, project] of [["current", "one"], ["previous", "one"], ["other", "two"]]) {
      await sessions.put(id!, { project_path: path.join(root, project!) });
    }
    await saveSummary("current", "Las facturas usan numeración secuencial.", 5, 5);
    await saveSummary("current", "La interfaz usa botones accesibles.", 10, 10);
    await saveSummary("previous", "Las facturas requieren validar impuestos.", 6, 6);
    await saveSummary("other", "Las facturas de OTRO_PROYECTO usan reglas privadas.", 6, 6);
    await saveSummary("unscoped", "Las facturas de SESION_PRIVADA requieren revisión.", 6, 6);
    expect((await getSummary("current"))?.summary).toContain("botones");
    const memory = await relevantConversationMemory({ threadId: "current", query: "facturas" });
    expect(memory).toContain("numeración"); expect(memory).toContain("impuestos");
    expect(memory).not.toContain("OTRO_PROYECTO"); expect(memory).not.toContain("SESION_PRIVADA");
    expect(await relevantConversationMemory({ threadId: "unscoped", query: "facturas" })).toContain("SESION_PRIVADA");
    expect(await relevantConversationMemory({ threadId: "unknown", query: "facturas" })).toBe("");
    expect(await relevantConversationMemory({ threadId: "current", query: "zzzznonexistent" })).toBe("");
    expect(await relevantConversationMemory({ threadId: "current", query: "" })).toBe("");
    const excluded = await relevantConversationMemory({ threadId: "current", query: "facturas", excludeSummary: "Las facturas usan numeración secuencial." });
    expect(excluded).not.toContain("numeración"); expect(excluded).toContain("impuestos");
    await db.collection<any>("codeTasks").put("task", { session_id: "current" });
    expect(await relevantConversationMemory({ threadId: "task", query: "facturas" })).toContain("impuestos");
    const index = spyOn(db, "upsertBatch");
    try {
      await rememberConversationSummary("previous", "Las facturas requieren validar impuestos.", 6);
      expect(index).not.toHaveBeenCalled();
      index.mockRejectedValueOnce(new Error("unavailable"));
      await saveSummary("previous", "Las facturas incluyen recuperación PENDIENTE.", 12, 12);
      expect((await getSummary("previous"))?.summary).toContain("PENDIENTE");
      expect(await relevantConversationMemory({ threadId: "current", query: "PENDIENTE" })).toContain("PENDIENTE");
    } finally { index.mockRestore(); }
    await rememberConversationSummary("previous", "facturas " + "contenido largo ".repeat(500), 20);
    const bounded = await relevantConversationMemory({ threadId: "current", query: "facturas", maxTokens: 150 });
    expect(bounded).not.toBe(""); expect(estimateTokens(bounded)).toBeLessThanOrEqual(150);
    expect(await relevantConversationMemory({ threadId: "current", query: "facturas", maxTokens: 0 })).toBe("");
    closeHiveDb(); db = await getHiveDb();
    expect(await relevantConversationMemory({ threadId: "current", query: "numeración" })).toContain("numeración");
    await Promise.all([
      rememberConversationSummary("current", "prueba concurrente anterior", 30),
      rememberConversationSummary("current", "prueba concurrente definitiva", 30),
    ]);
    expect(await relevantConversationMemory({ threadId: "current", query: "definitiva" })).toContain("definitiva");
    expect(await relevantConversationMemory({ threadId: "current", query: "anterior" })).toBe("");
  } finally {
    closeHiveDb(); process.env.HIVE_DB_PATH = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
