import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { relative } from "node:path"
import { ROOT, cargoLockVersion, cargoTomlVersion, versionFiles } from "../../scripts/set-version"

/**
 * El monorepo versiona en lockstep: un release es UN número. Si un package.json,
 * el Cargo.toml de la TUI o su Cargo.lock se quedan atrás, los binarios y los
 * paquetes npm publicados mienten sobre qué versión son. `scripts/set-version.ts`
 * (que usa `scripts/release.sh`) es la forma de moverlos todos juntos.
 */
describe("versión en lockstep", () => {
  const files = versionFiles()
  const expected = JSON.parse(readFileSync(files.json[0], "utf8")).version as string

  test("la raíz declara una versión semver", () => {
    expect(expected).toMatch(/^\d+\.\d+\.\d+/)
  })

  for (const f of files.json.slice(1)) {
    test(`${relative(ROOT, f)} coincide con la raíz`, () => {
      expect(JSON.parse(readFileSync(f, "utf8")).version).toBe(expected)
    })
  }

  test("Cargo.toml de la TUI coincide con la raíz", () => {
    expect(cargoTomlVersion(readFileSync(files.cargoToml, "utf8"))).toBe(expected)
  })

  test("Cargo.lock de la TUI coincide con la raíz", () => {
    expect(cargoLockVersion(readFileSync(files.cargoLock, "utf8"), "hivetui")).toBe(expected)
  })
})
