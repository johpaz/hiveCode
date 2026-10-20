import { expect, test } from "bun:test"
import { exposeNativeRequire } from "../../scripts/build-binary"

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
