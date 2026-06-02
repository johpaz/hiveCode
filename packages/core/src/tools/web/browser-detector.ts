/**
 * Detects Chrome-compatible browser executables on Linux, macOS, and Windows.
 * Used by browser.ts (Bun.WebView via BUN_CHROME_PATH) and
 * browser-agent.ts (agent-browser via --executable-path).
 *
 * Priority: native system binaries → flatpak native binary (extracted path).
 * Flatpak/Snap wrapper scripts are never returned — they sandbox the filesystem
 * and block file:// URLs. Firefox is excluded (requires Chromium engine).
 */

import { existsSync, readFileSync } from "node:fs";
import { platform, homedir } from "node:os";
import { join } from "node:path";

export interface DetectedBrowser {
  name: string;
  path: string;
}

// ── Wrapper detection ─────────────────────────────────────────────────────────

/** Returns true if the file is a flatpak or snap shell wrapper. */
function isWrapper(binPath: string): boolean {
  try {
    if (!existsSync(binPath)) return false;
    const first = readFileSync(binPath, "utf8").slice(0, 512);
    return first.includes("flatpak run") || first.includes("snap run") || first.includes("/snap/");
  } catch {
    return false;
  }
}

// ── Flatpak native binary extraction ─────────────────────────────────────────

/**
 * Locates the actual Chrome binary inside the flatpak installation directory,
 * bypassing the sandbox wrapper.
 */
function flatpakNativePath(appId: string): string | null {
  const systemBase = `/var/lib/flatpak/app/${appId}`;
  const userBase = join(homedir(), `.local/share/flatpak/app/${appId}`);

  for (const base of [systemBase, userBase]) {
    if (!existsSync(base)) continue;
    try {
      const archDir = join(base, "x86_64", "stable");
      if (!existsSync(archDir)) continue;
      const r = Bun.spawnSync(["ls", "-t", archDir], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const hash = r.stdout.toString().trim().split("\n")[0];
      if (!hash) continue;
      for (const bin of ["google-chrome", "chrome", "chromium"]) {
        const full = join(archDir, hash, "files", "extra", bin);
        if (existsSync(full)) return full;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ── Per-platform candidate resolution ────────────────────────────────────────

function linuxCandidates(): DetectedBrowser[] {
  const bins: { name: string; cmd: string; flatpakId?: string }[] = [
    { name: "Google Chrome",  cmd: "google-chrome-stable" },
    { name: "Google Chrome",  cmd: "google-chrome",       flatpakId: "com.google.Chrome" },
    { name: "Chromium",       cmd: "chromium" },
    { name: "Chromium",       cmd: "chromium-browser",    flatpakId: "org.chromium.Chromium" },
    { name: "Brave",          cmd: "brave-browser",       flatpakId: "com.brave.Browser" },
    { name: "Brave",          cmd: "brave" },
    { name: "Microsoft Edge", cmd: "microsoft-edge-stable" },
    { name: "Microsoft Edge", cmd: "microsoft-edge",      flatpakId: "com.microsoft.Edge" },
  ];

  const searchDirs = [
    "/usr/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    "/opt/google/chrome",
  ];

  const results: DetectedBrowser[] = [];

  for (const { name, cmd, flatpakId } of bins) {
    let found: string | null = null;

    try {
      const r = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      if (r.exitCode === 0) {
        const p = r.stdout.toString().trim();
        if (p.length > 0) found = p;
      }
    } catch { /* ignore */ }

    if (!found) {
      for (const dir of searchDirs) {
        const full = join(dir, cmd);
        if (existsSync(full)) { found = full; break; }
      }
    }

    if (!found) continue;

    if (isWrapper(found)) {
      if (flatpakId) {
        const native = flatpakNativePath(flatpakId);
        if (native) results.push({ name: `${name} (flatpak)`, path: native });
      }
      // Snap wrappers are skipped — strict confinement breaks headless mode
    } else {
      results.push({ name, path: found });
    }
  }

  return results;
}

function macosCandidates(): DetectedBrowser[] {
  const apps: { name: string; path: string }[] = [
    { name: "Google Chrome",        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { name: "Google Chrome Canary", path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" },
    { name: "Chromium",             path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
    { name: "Brave",                path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    { name: "Microsoft Edge",       path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  ];
  return apps.filter((a) => existsSync(a.path));
}

function windowsCandidates(): DetectedBrowser[] {
  const bases = [
    process.env["PROGRAMFILES"] ?? "C:\\Program Files",
    process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    process.env["LOCALAPPDATA"] ?? "",
  ];
  const apps: { name: string; rel: string }[] = [
    { name: "Google Chrome",  rel: "Google\\Chrome\\Application\\chrome.exe" },
    { name: "Chromium",       rel: "Chromium\\Application\\chrome.exe" },
    { name: "Brave",          rel: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
    { name: "Microsoft Edge", rel: "Microsoft\\Edge\\Application\\msedge.exe" },
  ];
  const results: DetectedBrowser[] = [];
  for (const base of bases) {
    if (!base) continue;
    for (const { name, rel } of apps) {
      const full = `${base}\\${rel}`;
      if (existsSync(full)) results.push({ name, path: full });
    }
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

let _cached: DetectedBrowser | null | undefined = undefined;

/**
 * Returns the first usable Chromium-compatible browser on this machine.
 * Skips flatpak/snap wrapper scripts and returns the native binary instead.
 * Returns null if no Chromium-based browser is found.
 *
 * Result is cached after the first call.
 */
export function detectBrowser(): DetectedBrowser | null {
  if (_cached !== undefined) return _cached;

  const os = platform();
  let candidates: DetectedBrowser[] = [];

  if (os === "linux") candidates = linuxCandidates();
  else if (os === "darwin") candidates = macosCandidates();
  else if (os === "win32") candidates = windowsCandidates();

  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.path)) return false;
    seen.add(c.path);
    return true;
  });

  _cached = unique[0] ?? null;
  return _cached;
}

/** Reset the detection cache — used in tests. */
export function _resetBrowserCache(): void {
  _cached = undefined;
}
