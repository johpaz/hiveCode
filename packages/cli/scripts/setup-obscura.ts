#!/usr/bin/env bun
/**
 * setup-obscura.ts
 *
 * Installs the Obscura headless browser CLI (obscura + obscura-worker) used by the
 * browser_* automation tools (packages/core/src/tools/web/obscura.ts — direct MCP).
 *
 * Runs automatically via `predev` / `prestart` hooks — no manual step needed.
 * Install location: ~/.hivecode/bin (same convention as the extracted hivetui).
 *
 * Sources:
 *   - GitHub Releases: https://github.com/h4ckf0r0day/obscura/releases
 *   - Docs:            https://docs.obscura.sh/quickstart/installation
 *
 * Escape hatches:
 *   - OBSCURA_PATH=<path>            → skip everything, use that binary
 *   - Obscura already on PATH        → skip
 *   - ~/.hivecode/bin/obscura works  → skip
 */

import { existsSync, chmodSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { platform, arch } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME_BIN = join(process.env.HOME ?? tmpdir(), ".hivecode", "bin");

// ── Skip conditions ──────────────────────────────────────────────────────────

// 1. Explicit override — the user manages the binary
if (process.env.OBSCURA_PATH && existsSync(process.env.OBSCURA_PATH)) {
  console.log(`✓ OBSCURA_PATH set — using ${process.env.OBSCURA_PATH}`);
  process.exit(0);
}

function versionWorks(bin: string): boolean {
  try {
    const out = execSync(`"${bin}" --version`, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// 2. Already on PATH
try {
  const which = execSync("which obscura", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (which && versionWorks(which)) {
    console.log(`✓ obscura already available (${which})`);
    process.exit(0);
  }
} catch { /* not on PATH */ }

// 3. Managed install already works
const managedBin = join(HOME_BIN, "obscura");
if (existsSync(managedBin) && versionWorks(managedBin)) {
  console.log(`✓ obscura ready (${managedBin})`);
  process.exit(0);
}

// ── Platform detection ───────────────────────────────────────────────────────

function isMusl(): boolean {
  if (platform() !== "linux") return false;
  try {
    const out = execSync("ldd --version 2>&1 || true", { encoding: "utf8" });
    if (out.toLowerCase().includes("musl")) return true;
  } catch { /* ignore */ }
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

const os = platform();   // 'linux' | 'darwin' | 'win32'
const cpu = arch();      // 'x64' | 'arm64'

if (os === "linux" && isMusl()) {
  console.warn("⚠  Musl libc detected: official Linux builds target glibc 2.35+ (Ubuntu 22.04).");
  console.warn("   The download may not run — use the Docker image or build from source:");
  console.warn("   https://docs.obscura.sh/guides/build-from-source");
}

const ARCH_MAP: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
const assetArch = ARCH_MAP[cpu];
if (!assetArch) {
  console.warn(`⚠  Unsupported architecture: ${cpu}. Install Obscura manually:`);
  console.warn("   https://docs.obscura.sh/quickstart/installation");
  process.exit(0);
}

let asset: string | null = null;
if (os === "linux") asset = `obscura-${assetArch}-linux.tar.gz`;
else if (os === "darwin") asset = `obscura-${assetArch}-macos.tar.gz`;
else if (os === "win32") asset = `obscura-${assetArch}-windows.zip`;

if (!asset) {
  console.warn(`⚠  Unsupported platform: ${os}. Install Obscura manually:`);
  console.warn("   https://docs.obscura.sh/quickstart/installation");
  process.exit(0);
}

const url = `https://github.com/h4ckf0r0day/obscura/releases/latest/download/${asset}`;

// ── Download ─────────────────────────────────────────────────────────────────

console.log(`⬇  Downloading Obscura for ${os}-${cpu} (${asset})...`);

if (!existsSync(HOME_BIN)) mkdirSync(HOME_BIN, { recursive: true });
const tmpDir = mkdtempSync(join(tmpdir(), "obscura-setup-"));
const archivePath = join(tmpDir, asset);

async function download(dlUrl: string, dest: string, redirects = 5): Promise<void> {
  if (redirects === 0) throw new Error("Too many redirects");
  const res = await fetch(dlUrl);
  if (res.status === 301 || res.status === 302) {
    return download(res.headers.get("location")!, dest, redirects - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${dlUrl}`);
  await Bun.write(dest, res);
}

try {
  await download(url, archivePath);

  // ── Extract (tar handles .tar.gz; bsdtar on Windows 10+ also handles .zip) ──
  const tarFlags = asset.endsWith(".zip") ? "-xf" : "xzf";
  const extract = Bun.spawnSync(["tar", tarFlags, archivePath, "-C", tmpDir], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  if (extract.exitCode !== 0) {
    throw new Error(`tar failed: ${extract.stderr.toString().trim() || `exit ${extract.exitCode}`}`);
  }

  // ── Install obscura + obscura-worker into ~/.hivecode/bin ───────────────────
  // The archive is flat: obscura (+ obscura-worker) at the top level.
  const files = ["obscura", "obscura-worker"].map(f =>
    os === "win32" && f === "obscura" ? "obscura.exe" : f,
  );

  let installedMain = false;
  for (const file of files) {
    const src = join(tmpDir, file);
    if (!existsSync(src)) continue;
    const dest = join(HOME_BIN, file);
    await Bun.write(dest, Bun.file(src));
    if (os !== "win32") chmodSync(dest, 0o755);
    if (file === "obscura" || file === "obscura.exe") installedMain = true;
  }

  if (!installedMain) {
    throw new Error(`archive did not contain the obscura binary (found: ${files.join(", ")})`);
  }

  // ── Verify ───────────────────────────────────────────────────────────────────
  if (!versionWorks(managedBin)) {
    throw new Error("downloaded binary failed `obscura --version` (wrong arch or libc?)");
  }

  const version = (() => {
    try {
      return execSync(`"${managedBin}" --version`, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch { return ""; }
  })();

  console.log(`✓ Obscura installed → ${managedBin} (${version || "version unknown"})`);
  console.log("  browser_* tools connect to it via direct MCP (`obscura mcp`).");
} catch (err) {
  console.warn(`⚠  Could not install Obscura: ${(err as Error).message}`);
  console.warn("   Browser automation tools will return an install error until Obscura is available.");
  console.warn("   Manual install: https://docs.obscura.sh/quickstart/installation");
  console.warn("   Or point OBSCURA_PATH at an existing binary.");
  // Non-fatal: hiveCode works without it (web_search/web_fetch remain available)
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
