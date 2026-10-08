import { test, expect, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHiveDb, closeHiveDb } from "../../packages/core/src/storage/hivedb";
import { replaceCapabilityDocs, searchCapabilities, type CapabilityDoc } from "../../packages/core/src/agent/capability-search";
import { syncSkillCatalog } from "../../packages/core/src/services/skill-catalog";
import { SkillLoader } from "../../packages/skills/src/loader";

test("catalog reconciles changes, survives reopen, and retries failed writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-incremental-"));
  const original = process.env.HIVE_DB_PATH;
  closeHiveDb(); process.env.HIVE_DB_PATH = root;
  try {
    let db = await getHiveDb();
    await db.upsertDoc({ id: "tool:legacy", body: "obsolete", filters: [{ field: "type", value: "tool" }] });
    const first: CapabilityDoc = { type: "tool", rawId: "first", body: "abrir documentos", extraFilters: [{ field: "z", value: "1" }, { field: "a", value: "2" }] };
    const second: CapabilityDoc = { type: "tool", rawId: "second", body: "enviar correo" };
    await replaceCapabilityDocs("tool", [first, second]);
    expect(await searchCapabilities("obsolete", { types: ["tool"] })).toEqual([]);
    const version = (await db.collection("capabilityCatalogs").get("tool"))!.version;
    closeHiveDb(); db = await getHiveDb();
    const writes = spyOn(db, "upsertBatch");
    const deletes = spyOn(db, "deleteDoc");
    const resets = spyOn(db, "deleteByFilter");
    try {
      await replaceCapabilityDocs("tool", [second, { ...first, extraFilters: [...first.extraFilters!].reverse() }]);
      expect(writes).not.toHaveBeenCalled(); expect(resets).not.toHaveBeenCalled();
      expect((await db.collection("capabilityCatalogs").get("tool"))!.version).toBe(version);
      const changed = { ...first, body: "consultar facturas" };
      writes.mockRejectedValueOnce(new Error("index unavailable"));
      await expect(replaceCapabilityDocs("tool", [changed])).rejects.toThrow("index unavailable");
      expect((await db.collection("capabilityCatalogs").get("tool"))!.version).toBe(version);
      await replaceCapabilityDocs("tool", [changed]);
      expect(writes.mock.calls[1]![0]).toHaveLength(1);
      expect(deletes).toHaveBeenCalledWith("tool:second");
      expect((await searchCapabilities("facturas", { types: ["tool"] }))[0]?.rawId).toBe("first");
      expect(await searchCapabilities("correo", { types: ["tool"] })).toEqual([]);
      await replaceCapabilityDocs("tool", []);
      expect(await searchCapabilities("facturas", { types: ["tool"] })).toEqual([]);
    } finally { writes.mockRestore(); deletes.mockRestore(); resets.mockRestore(); }
    const skills = new SkillLoader({}).loadBundledSkills().slice(0, 1);
    await syncSkillCatalog(skills);
    const collection = db.collection<any>("skills");
    const stored = (await collection.get(skills[0]!.name))!;
    await collection.put(stored.id, { ...stored.doc, active: false });
    const inactive = (await collection.get(stored.id))!;
    await syncSkillCatalog(skills);
    expect((await collection.get(stored.id))!.version).toBe(inactive.version);
    await syncSkillCatalog([{ ...skills[0]!, content: "updated body" }]);
    expect((await collection.get(stored.id))!.doc.active).toBe(false);
    expect((await collection.get(stored.id))!.doc.body).toBe("updated body");
    await syncSkillCatalog([]);
    expect(await collection.get(stored.id)).toBeUndefined();
  } finally {
    closeHiveDb(); process.env.HIVE_DB_PATH = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
