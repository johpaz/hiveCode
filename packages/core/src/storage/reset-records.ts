import fs from "node:fs";
import path from "node:path";
import { getHiveDir } from "../config/loader";
import { stopVerifiedProcess } from "../runtime/process-identity";
import { getHiveDb, getHiveDbPath, closeHiveDb } from "./hivedb";
import { ensureHiveDb } from "./bootstrap";

/** Explicit developer operation. Acquire the database lock before replacing records. */
export async function resetRecords(): Promise<void> {
  const target = path.resolve(getHiveDbPath());
  if (fs.existsSync(target)) {
    const permitted = new Set(["collections.redb", "semantic.redb", "meta.json", "fts", "fts.generation", "shards", "hnsw", "vectors.0.dat", "vectors.1.dat"]);
    if (fs.readdirSync(target).some(entry => !permitted.has(entry))) {
      throw new Error("La ruta contiene archivos ajenos a HiveDB; no se reinició");
    }
  }
  console.log(`Base de datos a reiniciar: ${target}`);
  await stopVerifiedProcess(path.join(getHiveDir(), "gateway.pid"));
  await getHiveDb();
  closeHiveDb();
  // Retain the previous store until seeding succeeds, allowing recovery on error.
  const backup = `${target}.reset-${Date.now()}`;
  fs.renameSync(target, backup);
  try {
    await ensureHiveDb();
    closeHiveDb();
  } catch (error) {
    closeHiveDb();
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(backup, target);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  console.log("Registros reiniciados y catálogos reconstruidos. Credenciales conservadas.");
}
