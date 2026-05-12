/**
 * Workspace Guard — enforces that filesystem tool paths stay inside the agent workspace.
 *
 * If the agent has no workspace configured the guard is a no-op and all paths are allowed.
 * If a workspace is set, any path that resolves outside it is rejected with a clear error.
 */

import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"

/** Expand ~ to the home directory */
export function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

/**
 * Resolve the real (canonical) path of a file, following symlinks.
 * If the file doesn't exist yet, resolves the parent directory instead.
 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    const dir = path.dirname(p)
    try {
      return path.join(fs.realpathSync(dir), path.basename(p))
    } catch {
      return p
    }
  }
}

/**
 * Resolve a user-supplied path against the workspace root.
 *
 * - If `workspace` is not set (null / undefined / empty), the call is REJECTED
 *   to prevent uncontrolled filesystem access.
 * - Relative paths are resolved relative to `workspace`.
 * - Absolute paths must be inside `workspace`; otherwise an error is thrown.
 * - Symlink escape protection: resolves real paths before containment check.
 *
 * @throws Error when no workspace is configured or the resolved path is outside the workspace.
 */
export function resolveInWorkspace(
  filePath: string,
  workspace: string | null | undefined
): string {
  if (!workspace) {
    throw new Error(
      `[Workspace] Access denied: no workspace configured. Refusing to access '${filePath}' without a workspace boundary.`
    )
  }

  const wsRoot = path.resolve(expandPath(workspace))
  const wsRealRoot = realpathSafe(wsRoot)

  let resolved: string
  if (path.isAbsolute(filePath)) {
    resolved = path.normalize(filePath)
  } else {
    resolved = path.resolve(wsRoot, filePath)
  }

  const resolvedReal = realpathSafe(resolved)

  const relative = path.relative(wsRealRoot, resolvedReal)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `[Workspace] Access denied: '${filePath}' resolves outside workspace '${wsRoot}'.`
    )
  }

  return resolved
}

/**
 * Extract workspace from tool config (passed by agent-loop as config.configurable.workspace).
 */
export function getWorkspace(config?: any): string | null | undefined {
  return config?.configurable?.workspace ?? null
}
