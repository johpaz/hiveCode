import { resolve, join } from "node:path";
import { mkdirSync, chmodSync, copyFileSync, cpSync, existsSync, writeFileSync } from "node:fs";

const root = resolve(import.meta.dir, "../../..");
const dist = resolve(process.argv[2] ?? join(process.cwd(), "dist"));
const generated = Bun.spawn([process.execPath, join(root, "packages/skills/scripts/generate-bundle.ts")], { stdout: "inherit", stderr: "inherit" });
if (await generated.exited !== 0) throw new Error("Skill generation failed");
mkdirSync(dist, { recursive: true });
const dbManifest = Bun.resolveSync("@johpaz/hive-db/package.json", join(root, "packages/core"));
const dbPackage = resolve(dbManifest, "..");
const dependencyDir = join(dist, "node_modules/@johpaz");
mkdirSync(dependencyDir, { recursive: true });
cpSync(dbPackage, join(dependencyDir, "hive-db"), { recursive: true, dereference: true });
// Native loader resolves the installed platform package relative to HiveDB.
const manifest = await Bun.file(dbManifest).json();
let nativeCount = 0;
for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
  try {
    const nativeManifest = Bun.resolveSync(`${name}/package.json`, dbPackage);
    cpSync(resolve(nativeManifest, ".."), join(dist, "node_modules", name), { recursive: true, dereference: true });
    nativeCount++;
  } catch { /* Other platform optional dependencies need not be installed. */ }
}
if (!nativeCount) throw new Error("HiveDB native platform dependency is missing");
const cli = await Bun.build({ entrypoints: [join(root, "packages/cli/src/index.ts")], outdir: dist, naming: "hivecode.js", target: "bun", external: ["@johpaz/hive-db"] });
if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed");
// Worker URLs in the runtime intentionally retain their source extension. Bun
// executes these bundled modules as TypeScript, including in an installed package.
const workerDir = join(root, "packages/code/src/workers");
const workers = [...new Bun.Glob("*.worker.ts").scanSync(workerDir)].map(file => join(workerDir, file));
const built = await Bun.build({ entrypoints: workers, outdir: dist, naming: "[name].ts", target: "bun", external: ["@johpaz/hive-db"] });
if (!built.success) throw new AggregateError(built.logs, "Worker build failed");
const suffix = process.platform === "win32" ? ".exe" : "";
const tui = join(root, `packages/hivetui/target/release/hivetui${suffix}`);
if (!existsSync(tui)) throw new Error("Build the TUI first: cargo build --release --manifest-path packages/hivetui/Cargo.toml");
copyFileSync(tui, join(dist, `hivetui${suffix}`));
chmodSync(join(dist, `hivetui${suffix}`), 0o755);
writeFileSync(join(dist, "hivecode"), '#!/usr/bin/env sh\nexec bun "$(dirname "$0")/hivecode.js" "$@"\n');
chmodSync(join(dist, "hivecode"), 0o755);
writeFileSync(join(dist, "hivecode.cmd"), '@echo off\nbun "%~dp0hivecode.js" %*\n');
writeFileSync(join(dist, "hivecode.ps1"), '$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path\n& bun "$scriptDir/hivecode.js" @args\n');
console.log(`Built CLI, ${workers.length} workers and TUI → ${dist}`);
