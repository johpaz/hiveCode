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
