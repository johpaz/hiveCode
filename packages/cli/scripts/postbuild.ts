#!/usr/bin/env bun
/**
 * Post-build script — generates shell wrapper scripts for the bundled JS.
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

// Dist dir is at project root, not inside packages/
const distDir = resolve(process.cwd(), "dist")
const entry = "hivecode.js"

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true })
}

// Unix wrapper
const unixWrapper = `#!/usr/bin/env sh
exec bun "$(dirname "$0")/${entry}" "$@"
`

// Windows CMD wrapper
const cmdWrapper = `@echo off
bun "%~dp0${entry}" %*
`

// Windows PowerShell wrapper
const psWrapper = `#!/usr/bin/env pwsh
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& bun "$scriptDir/${entry}" @args
`

writeFileSync(join(distDir, "hivecode"), unixWrapper)
chmodSync(join(distDir, "hivecode"), 0o755)

writeFileSync(join(distDir, "hivecode.cmd"), cmdWrapper)
writeFileSync(join(distDir, "hivecode.ps1"), psWrapper)

console.log("[postbuild] ✅ Shell wrappers generated")
