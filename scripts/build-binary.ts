/**
 * Standalone binary: `bun scripts/build-binary.ts --target bun-linux-x64 --outfile dist/hivecode-linux-x64`
 *
 * Same as `bun build --compile --bytecode`, plus one patch. `@johpaz/hive-db` loads its native
 * addon with `createRequire(import.meta.url)`, which the bundler cannot follow: the `.node` file
 * was never embedded, and the binary died on start with "Cannot find module '../native.cjs'".
 * With a plain `require` the loader and the addon for the host platform are bundled.
 *
 * The addon comes from the platform package that `bun install` fetched for the machine running
 * this script, so build each target on its own platform (as release.yml does).
 */
import { parseArgs } from "node:util"

/** The loader's two lines that hide `require` from the bundler. */
export function exposeNativeRequire(source: string): string {
  const patched = source
    .replace('import { createRequire } from "node:module";', "")
    .replace("const require = createRequire(import.meta.url);", "")
  if (patched === source) throw new Error("@johpaz/hive-db ya no usa createRequire: revisa este parche")
  return patched
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: "string" }, outfile: { type: "string" } },
  })
  if (!values.outfile) {
    console.error("uso: bun scripts/build-binary.ts --outfile <ruta> [--target bun-linux-x64]")
    process.exit(2)
  }

  const result = await Bun.build({
    entrypoints: ["packages/cli/src/index.ts"],
    bytecode: true,
    compile: values.target
      ? { outfile: values.outfile, target: values.target as never }
      : { outfile: values.outfile },
    plugins: [{
      name: "hive-db-static-require",
      setup(build) {
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
  console.log(`✓ ${values.outfile}`)
}
