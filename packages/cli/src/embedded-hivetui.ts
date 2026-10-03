/**
 * Embeds the hivetui Rust binary into the compiled hivecode executable.
 * At runtime, extracts it to ~/.hivecode/bin/ and returns the path.
 *
 * Bun's --compile embeds files imported with { type: "file" }.
 * The import resolves to a BunFile in compiled mode.
 */

import { existsSync, mkdirSync, chmodSync } from "node:fs"
import path from "node:path"

// Static import — Bun --compile embeds this file into the binary.
// Points at the committed empty placeholder (packages/hivetui/hivetui.bin) so the
// import always resolves in `bun run dev` (cargo build only produces target/debug).
// `build:binary*` scripts copy the real release binary over the placeholder right
// before `bun build --compile` and truncate it back afterwards.
// @ts-ignore — Bun-specific asset import
import hivetuiAsset from "../../hivetui/hivetui.bin" with { type: "file" }

const CACHE_DIR = path.join(process.env.HOME ?? "/tmp", ".hivecode", "bin")
const CACHED_PATH = path.join(CACHE_DIR, "hivetui")

let extracted = false

export async function extractHivetui(): Promise<string | null> {
  // Already extracted in this session
  if (extracted && existsSync(CACHED_PATH)) return CACHED_PATH

  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const src = Bun.file(hivetuiAsset)
    if ((await src.size) === 0) return null
    await Bun.write(CACHED_PATH, src)
    chmodSync(CACHED_PATH, 0o755)
    extracted = true
    return CACHED_PATH
  } catch {
    return null
  }
}

export function cachedHivetuiPath(): string {
  return CACHED_PATH
}
