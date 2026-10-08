import * as path from "node:path";
import * as os from "node:os";
export function resolvePath(p: string, workspace: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1))
  }
  if (!path.isAbsolute(p)) {
    return path.resolve(workspace, p)
  }
  return path.normalize(p)
}
