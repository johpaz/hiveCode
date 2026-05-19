#!/usr/bin/env bun
/**
 * Post-build script:
 *   1. Generates shell wrapper scripts for the bundled JS
 *   2. Copies the Ratatui TUI binary to dist/
 *   3. Copies hive-ui/dist → dist/ui/
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync, copyFileSync, cpSync } from "node:fs"
import { join, resolve } from "node:path"

const rootDir = resolve(process.cwd())
const distDir = join(rootDir, "dist")
const entry   = "hivecode.js"

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })

// ── Shell wrappers ────────────────────────────────────────────────────────────
writeFileSync(join(distDir, "hivecode"), `#!/usr/bin/env sh\nexec bun "$(dirname "$0")/${entry}" "$@"\n`)
chmodSync(join(distDir, "hivecode"), 0o755)
writeFileSync(join(distDir, "hivecode.cmd"), `@echo off\nbun "%~dp0${entry}" %*\n`)
writeFileSync(join(distDir, "hivecode.ps1"), `#!/usr/bin/env pwsh\n$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path\n& bun "$scriptDir/${entry}" @args\n`)
console.log("[postbuild] ✅ Shell wrappers generated")

// ── TUI binary ────────────────────────────────────────────────────────────────
const tuiRelease = join(rootDir, "packages/tui/target/release/hivecode-tui")
const tuiDebug   = join(rootDir, "packages/tui/target/debug/hivecode-tui")
const tuiSrc     = existsSync(tuiRelease) ? tuiRelease : existsSync(tuiDebug) ? tuiDebug : null

if (tuiSrc) {
  copyFileSync(tuiSrc, join(distDir, "hivecode-tui"))
  chmodSync(join(distDir, "hivecode-tui"), 0o755)
  console.log(`[postbuild] ✅ TUI binary copied (${tuiSrc.includes("release") ? "release" : "debug"})`)
} else {
  console.warn("[postbuild] ⚠️  TUI binary not found — run: cd packages/tui && cargo build --release")
}

// ── hive-ui static assets ─────────────────────────────────────────────────────
const uiSrc = join(rootDir, "packages/hive-ui/dist")
const uiDst = join(distDir, "ui")

if (existsSync(uiSrc)) {
  cpSync(uiSrc, uiDst, { recursive: true })
  console.log(`[postbuild] ✅ UI assets copied → dist/ui/`)
} else {
  console.warn("[postbuild] ⚠️  hive-ui not built — run: cd packages/hive-ui && bun run build")
}
