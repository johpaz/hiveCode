/**
 * Resolves an import of one workspace package from another (`@scope/core/agent/loop`) to the source file
 * that package exports, so the index sees the edges between packages and not only the relative ones.
 *
 * A monorepo's biggest modules are imported through package names; with only relative imports resolved,
 * `dependents` and the "most imported" map would miss nearly everything that matters.
 */
import fs from "node:fs"
import path from "node:path"

interface WorkspacePackage { name: string; dir: string; exports: Record<string, unknown> }

const CACHE_MS = 60_000
const cache = new Map<string, { at: number; packages: WorkspacePackage[] }>()

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
}

/** Directories a root package.json lists as workspaces (`packages/*` style globs), `packages/*` when it lists none. */
function workspaceDirs(root: string): string[] {
  const manifest = readJson(path.join(root, "package.json"))
  const declared = Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages
  const patterns: string[] = Array.isArray(declared) && declared.length ? declared : ["packages/*"]
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) { dirs.push(path.join(root, pattern)); continue }
    const parent = path.join(root, pattern.slice(0, -2))
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(path.join(parent, entry.name))
    } catch { /* no such directory */ }
  }
  return dirs
}

function workspacePackages(root: string, now: number): WorkspacePackage[] {
  const hit = cache.get(root)
  if (hit && now - hit.at < CACHE_MS) return hit.packages
  const packages: WorkspacePackage[] = []
  for (const dir of workspaceDirs(root)) {
    const manifest = readJson(path.join(dir, "package.json"))
    if (!manifest?.name) continue
    const exports = typeof manifest.exports === "string" ? { ".": manifest.exports }
      : manifest.exports && typeof manifest.exports === "object" ? manifest.exports
      : { ".": manifest.module ?? manifest.main ?? "./src/index.ts" }
    packages.push({ name: manifest.name, dir, exports })
  }
  cache.set(root, { at: now, packages })
  return packages
}

/** An export target is a path, or conditions (`import`, `default`, `bun`…) around one. */
function targetOf(value: unknown): string | null {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    for (const key of ["bun", "import", "default", "types"]) {
      const inner = targetOf((value as Record<string, unknown>)[key])
      if (inner) return inner
    }
  }
  return null
}

export function resolveWorkspaceImport(root: string, specifier: string, now = Date.now()): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null
  for (const pkg of workspacePackages(root, now)) {
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue
    const subpath = specifier === pkg.name ? "." : `./${specifier.slice(pkg.name.length + 1)}`
    let target = targetOf(pkg.exports[subpath])
    if (!target) {
      for (const [key, value] of Object.entries(pkg.exports)) {
        const star = key.indexOf("*")
        if (star < 0 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue
        const matched = subpath.slice(star, subpath.length - (key.length - star - 1))
        const template = targetOf(value)
        if (template) { target = template.replace("*", matched); break }
      }
    }
    if (!target) return null
    const file = path.resolve(pkg.dir, target)
    return fs.existsSync(file) ? file : null
  }
  return null
}

export function resetWorkspacePackages(): void { cache.clear() }
