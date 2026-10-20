import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADDON_FOR_TARGET, exposeNativeRequire, locateAddonPackage, resolveAddonRequest } from "../../scripts/build-binary"

// @johpaz/hive-db carga su addon nativo con `createRequire(import.meta.url)`, que el
// empaquetador no puede seguir: el binario independiente compilaba, pero no arrancaba.
// Estos tests fallan si una nueva versión de hive-db cambia ese cargador y el parche
// deja de hacer lo que debe, en vez de enterarnos con un release roto.

const installed = async () =>
  Bun.file(Bun.resolveSync("@johpaz/hive-db/package.json", `${import.meta.dir}/../../packages/core`).replace("package.json", "src/index.ts")).text()

test("the installed hive-db loader still has the shape the build patch expects", async () => {
  const source = await installed()
  expect(source).toContain("createRequire(import.meta.url)")
  expect(source).toContain('require("../native.cjs")')
})

test("the patch leaves a plain require the bundler can follow", async () => {
  const patched = exposeNativeRequire(await installed())
  expect(patched).not.toContain("createRequire")
  expect(patched).toContain('require("../native.cjs")')
})

test("the patch refuses to run silently on a loader it does not recognise", () => {
  expect(() => exposeNativeRequire("export const x = 1")).toThrow(/createRequire/)
})

// ── El addon es el del target, no el de la máquina que compila ────────────────────────────────

const HIVE_DB_DIR = () => join(import.meta.dir, "../../node_modules/.bun/@johpaz+hive-db@0.7.0/node_modules/@johpaz/hive-db")

test("every release target maps to an addon package that hive-db actually publishes", async () => {
  const manifest = await Bun.file(join(HIVE_DB_DIR(), "package.json")).json() as { optionalDependencies: Record<string, string> }
  const published = new Set(Object.keys(manifest.optionalDependencies).map(name => name.replace("@johpaz/hive-db-", "")))
  for (const [target, suffix] of Object.entries(ADDON_FOR_TARGET)) {
    if (suffix === null) continue // unsupported on purpose
    expect(published.has(suffix), `${target} → ${suffix}`).toBe(true)
  }
})

test("Windows arm64 is refused: hive-db publishes no addon for it", () => {
  expect(ADDON_FOR_TARGET["bun-windows-arm64"]).toBeNull()
  expect(ADDON_FOR_TARGET["bun-windows-x64-arm64"]).toBeNull()
  const published = Object.keys(JSON.parse(require("node:fs").readFileSync(join(HIVE_DB_DIR(), "package.json"), "utf-8")).optionalDependencies)
  expect(published.some(name => name.includes("arm64-msvc") || name.includes("win32-arm64"))).toBe(false)
})

test("an addon package already installed on this machine is used as is", () => {
  const dir = locateAddonPackage("linux-x64-gnu", HIVE_DB_DIR())
  expect(dir).toContain("hive-db-linux-x64-gnu")
})

test("the loader's two requests resolve to the target package's manifest and its .node", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-addon-test-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@johpaz/hive-db-darwin-x64", version: "0.7.0", main: "hivedb-napi.darwin-x64.node" }))
  expect(resolveAddonRequest("@johpaz/hive-db-darwin-x64/package.json", dir)).toBe(join(dir, "package.json"))
  expect(resolveAddonRequest("@johpaz/hive-db-darwin-x64", dir)).toBe(join(dir, "hivedb-napi.darwin-x64.node"))
})
