/**
 * Gives each test process its own temp directory and removes it on exit.
 * Every full pass used to leave ~1.5 GB of `mkdtemp` directories in /tmp (a tmpfs with a quota) until writes failed with EDQUOT.
 * Owning the directory, instead of matching names afterwards, means another process's files are never touched.
 */
import { afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const base = os.tmpdir()
const own = fs.mkdtempSync(path.join(base, "hive-testrun-"))
process.env.TMPDIR = own

const clean = () => { try { fs.rmSync(own, { recursive: true, force: true }) } catch { /* best effort */ } }
// `exit` does not fire under `bun test`, so the last hook of the run does it; `exit` covers a plain `bun` process.
afterAll(clean)
process.on("exit", clean)
