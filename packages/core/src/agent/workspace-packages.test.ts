import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveWorkspaceImport, resetWorkspacePackages } from "./workspace-packages"

const root = mkdtempSync(path.join(tmpdir(), "ws-pkgs-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const pkg = (dir: string, manifest: object, files: string[]) => {
  mkdirSync(path.join(root, "packages", dir, "src/agent"), { recursive: true })
  writeFileSync(path.join(root, "packages", dir, "package.json"), JSON.stringify(manifest))
  for (const f of files) writeFileSync(path.join(root, "packages", dir, f), "export {}\n")
}
writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
pkg("core", { name: "@x/core", exports: { ".": "./src/index.ts", "./agent/loop": "./src/agent/loop.ts" } }, ["src/index.ts", "src/agent/loop.ts"])
pkg("code", { name: "@x/code", exports: { "./*": { import: "./src/*.ts" } } }, ["src/agent/runner.ts"])

describe("resolveWorkspaceImport", () => {
  resetWorkspacePackages()
  test("resolves the package root and an explicit subpath", () => {
    expect(resolveWorkspaceImport(root, "@x/core")).toBe(path.join(root, "packages/core/src/index.ts"))
    expect(resolveWorkspaceImport(root, "@x/core/agent/loop")).toBe(path.join(root, "packages/core/src/agent/loop.ts"))
  })

  test("resolves a wildcard export, through its conditions", () => {
    expect(resolveWorkspaceImport(root, "@x/code/agent/runner")).toBe(path.join(root, "packages/code/src/agent/runner.ts"))
  })

  test("ignores relative, node: and third-party specifiers, and exports that are not on disk", () => {
    for (const spec of ["./a", "node:fs", "react", "@x/core/agent/missing", "@x/other"]) expect(resolveWorkspaceImport(root, spec)).toBeNull()
  })
})
