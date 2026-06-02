#!/usr/bin/env bun
/**
 * setup-agent-browser.ts
 *
 * Downloads the correct agent-browser native binary for the current platform.
 * Runs automatically via `predev` / `prestart` hooks — no manual step needed.
 *
 * Platforms: linux-x64, linux-arm64, linux-musl-x64, darwin-x64, darwin-arm64, win32-x64
 */

import { existsSync, chmodSync, mkdirSync } from "node:fs";
import { platform, arch } from "node:os";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Locate the installed package ──────────────────────────────────────────────

import { realpathSync } from "node:fs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

function findAgentBrowserPkg(): string | null {
  // Bun installs @vercel/agent-browser as a scoped package in packages/core.
  // It's a symlink into the .bun content-addressed cache — resolve to the real path
  // so the native binary lands next to agent-browser.js.
  const candidates = [
    join(workspaceRoot, "packages", "core", "node_modules", "@vercel", "agent-browser"),
    join(workspaceRoot, "node_modules", "@vercel", "agent-browser"),
    join(workspaceRoot, "node_modules", "agent-browser"),
  ];

  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) {
      try {
        return realpathSync(c); // resolve symlink so binary goes to the real dir
      } catch {
        return c;
      }
    }
  }
  return null;
}

const pkgRoot = findAgentBrowserPkg();

if (!pkgRoot) {
  console.log("⚠  agent-browser package not found — run `bun install` first.");
  process.exit(0);
}

// ── Platform detection ────────────────────────────────────────────────────────

function isMusl(): boolean {
  if (platform() !== "linux") return false;
  try {
    const out = execSync("ldd --version 2>&1 || true", { encoding: "utf8" });
    if (out.toLowerCase().includes("musl")) return true;
  } catch { /* ignore */ }
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

const os = platform(); // 'linux' | 'darwin' | 'win32'
const cpu = arch();    // 'x64' | 'arm64'
const osKey = os === "linux" && isMusl() ? "linux-musl" : os;
const platformKey = `${osKey}-${cpu}`;
const ext = os === "win32" ? ".exe" : "";
const binaryName = `agent-browser-${platformKey}${ext}`;
const binDir = join(pkgRoot, "bin");
const binaryPath = join(binDir, binaryName);

// ── Skip if binary already present ───────────────────────────────────────────

if (existsSync(binaryPath)) {
  if (os !== "win32") chmodSync(binaryPath, 0o755);
  console.log(`✓ agent-browser ready (${platformKey})`);
  process.exit(0);
}

// ── Download from GitHub Releases ────────────────────────────────────────────

const pkgJson = JSON.parse(await Bun.file(join(pkgRoot, "package.json")).text());
const version: string = pkgJson.version;
const url = `https://github.com/vercel-labs/agent-browser/releases/download/v${version}/${binaryName}`;

console.log(`⬇  Downloading agent-browser ${version} for ${platformKey}...`);

if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

async function download(url: string, dest: string, redirects = 5): Promise<void> {
  if (redirects === 0) throw new Error("Too many redirects");
  const res = await fetch(url);
  if (res.status === 301 || res.status === 302) {
    return download(res.headers.get("location")!, dest, redirects - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  await Bun.write(dest, res);
}

try {
  await download(url, binaryPath);
  if (os !== "win32") chmodSync(binaryPath, 0o755);
  console.log(`✓ agent-browser ${version} installed (${platformKey})`);
} catch (err) {
  console.warn(`⚠  Could not download agent-browser: ${(err as Error).message}`);
  console.warn("   Browser automation will fall back to Bun.WebView screenshots.");
  console.warn(`   To build locally: cd node_modules/agent-browser && npm run build:native`);
  // Non-fatal: hiveCode works without it (screenshot fallback)
  process.exit(0);
}
