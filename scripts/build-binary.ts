/**
 * Standalone binary: `bun scripts/build-binary.ts --target bun-linux-x64 --outfile dist/hivecode-linux-x64`
 *
 * Same as `bun build --compile --bytecode`, plus two things `@johpaz/hive-db` needs:
 *
 * 1. Its loader uses `createRequire(import.meta.url)`, which the bundler cannot follow: the native
 *    addon was never embedded and the binary died on start with "Cannot find module
 *    '../native.cjs'". With a plain `require`, the loader and the addon are bundled.
 * 2. The addon must be the TARGET's, not the build machine's. The platform package comes from
 *    node_modules when `bun install` already fetched it (same platform) and is otherwise
 *    downloaded with `npm pack`, so any target can be built from any host and embeds only its own
 *    addon.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"

/** Bun compile target → suffix of the `@johpaz/hive-db-*` package that holds its addon. */
export const ADDON_FOR_TARGET: Record<string, string | null> = {
  "bun-linux-x64": "linux-x64-gnu",
  "bun-linux-x64-baseline": "linux-x64-gnu",
  "bun-linux-x64-modern": "linux-x64-gnu",
  "bun-linux-x64-musl": "linux-x64-musl",
  "bun-linux-arm64": "linux-arm64-gnu",
  "bun-darwin-x64": "darwin-x64",
  "bun-darwin-arm64": "darwin-arm64",
  "bun-windows-x64": "win32-x64-msvc",
  // hive-db publishes no Windows arm64 addon: there is nothing to embed.
  "bun-windows-arm64": null,
  "bun-windows-x64-arm64": null,
}

/** The loader's two lines that hide `require` from the bundler. */
export function exposeNativeRequire(source: string): string {
  const patched = source
    .replace('import { createRequire } from "node:module";', "")
    .replace("const require = createRequire(import.meta.url);", "")
  if (patched === source) throw new Error("@johpaz/hive-db ya no usa createRequire: revisa este parche")
  return patched
}

/** Where the target's addon package lives on disk, downloading it if this machine does not have it. */
export function locateAddonPackage(suffix: string, hiveDbDir: string): string {
  const name = `@johpaz/hive-db-${suffix}`
  try {
    return dirname(Bun.resolveSync(`${name}/package.json`, hiveDbDir))
  } catch { /* not installed on this machine: fetch it */ }

  const version = JSON.parse(readFileSync(join(hiveDbDir, "package.json"), "utf-8")).version as string
  const work = mkdtempSync(join(tmpdir(), "hive-addon-"))
  const pack = Bun.spawnSync(["npm", "pack", `${name}@${version}`, "--silent", "--pack-destination", work])
  if (pack.exitCode !== 0) throw new Error(`npm pack ${name}@${version} falló: ${pack.stderr.toString()}`)
  const tarball = readdirSync(work).find(file => file.endsWith(".tgz"))
  if (!tarball) throw new Error(`npm pack ${name}@${version} no produjo un .tgz`)
  const untar = Bun.spawnSync(["tar", "-xzf", join(work, tarball), "-C", work])
  if (untar.exitCode !== 0) throw new Error(`no se pudo extraer ${tarball}: ${untar.stderr.toString()}`)
  const dir = join(work, "package")
  if (!existsSync(join(dir, "package.json"))) throw new Error(`${name} no tiene package.json tras extraerlo`)
  return dir
}

/** The two files the platform loader asks for: the package manifest (version check) and its addon. */
export function resolveAddonRequest(request: string, addonDir: string): string {
  const manifest = join(addonDir, "package.json")
  if (request.endsWith("/package.json")) return manifest
  return join(addonDir, JSON.parse(readFileSync(manifest, "utf-8")).main as string)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/@-]/g, "\\$&")

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: "string" }, outfile: { type: "string" } },
  })
  if (!values.outfile) {
    console.error("uso: bun scripts/build-binary.ts --outfile <ruta> [--target bun-linux-x64]")
    process.exit(2)
  }

  const suffix = values.target ? ADDON_FOR_TARGET[values.target] : undefined
  if (suffix === null) {
    console.error(`✗ ${values.target}: @johpaz/hive-db no publica un módulo nativo para esa plataforma; el binario no podría abrir su base de datos.`)
    process.exit(1)
  }
  if (values.target && suffix === undefined) {
    console.error(`✗ target desconocido: ${values.target}`)
    process.exit(2)
  }

  // Without --target the binary is for this machine, and its own addon is already installed.
  const hiveDbDir = dirname(Bun.resolveSync("@johpaz/hive-db/package.json", join(process.cwd(), "packages/core")))
  const addonName = suffix ? `@johpaz/hive-db-${suffix}` : undefined
  const addonDir = suffix ? locateAddonPackage(suffix, hiveDbDir) : undefined

  const result = await Bun.build({
    entrypoints: ["packages/cli/src/index.ts"],
    bytecode: true,
    compile: values.target
      ? { outfile: values.outfile, target: values.target as never }
      : { outfile: values.outfile },
    plugins: [{
      name: "hive-db-native",
      setup(build) {
        if (addonName && addonDir) {
          build.onResolve({ filter: new RegExp(`^${escapeRegExp(addonName)}(/package\\.json)?$`) }, ({ path }) => ({
            path: resolveAddonRequest(path, addonDir),
          }))
        }
        build.onLoad({ filter: /hive-db[\\/]src[\\/]index\.ts$/ }, async ({ path }) => ({
          contents: exposeNativeRequire(await Bun.file(path).text()),
          loader: "ts",
        }))
      },
    }],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    process.exit(1)
  }
  console.log(`✓ ${values.outfile}${addonName ? `  (addon: ${addonName})` : ""}`)
}
