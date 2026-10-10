/**
 * Test database isolation.
 *
 * HiveDB opens exclusively — there is no shared or read-only mode. A running
 * hivecode gateway holds the lock on ./hivecode, and any test process that
 * tries to open the same path fails with "Database already open". That is the
 * store behaving correctly, not a flaky test.
 *
 * So tests get their own database under the OS temp dir. Nothing here seeds:
 * each test that needs rows writes them, which is what makes them independent of
 * install state as well as of each other.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "hivecode-test-"))

// Resolved relative to cwd by getHiveDbPath(); an absolute path passes through.
process.env.HIVE_DB_PATH = dir
import { beforeEach } from "bun:test";
// A test that checks path resolution may temporarily remove the override.
// Restore it before every following test, even when that test has no own fixture.
beforeEach(() => { process.env.HIVE_DB_PATH ??= dir; });
// Keep the fallback installation inside the temporary tree as well.
process.env.HIVE_HOME = join(dir, "home");

// ── Llavero en memoria ────────────────────────────────────────────────────────
// `Bun.secrets` habla con libsecret/D-Bus (Linux), Keychain (macOS) o el
// Credential Manager (Windows). En un runner de CI no hay llavero y falla con
// "Cannot autolaunch D-Bus without X11 $DISPLAY"; en una máquina de desarrollo
// los tests escribían en el llavero real del usuario. La DB ya está aislada
// arriba: las credenciales también. Los tests que necesitan que el llavero
// "no esté disponible" lo inyectan ellos mismos.
const memorySecrets = new Map<string, string>()
const secretKey = (o: { service: string; name: string }) => `${o.service}\u0000${o.name}`
;(Bun as unknown as { secrets: unknown }).secrets = {
  async get(o: { service: string; name: string }) {
    return memorySecrets.get(secretKey(o)) ?? null
  },
  async set(o: { service: string; name: string; value: string }) {
    // Igual que el llavero real: un valor vacío equivale a borrar.
    if (o.value === "") memorySecrets.delete(secretKey(o))
    else memorySecrets.set(secretKey(o), o.value)
  },
  async delete(o: { service: string; name: string }) {
    return memorySecrets.delete(secretKey(o))
  },
}
