#!/usr/bin/env bun
/**
 * Fija UNA versión en todo el monorepo (lockstep):
 *   - package.json de la raíz y de cada packages/*
 *   - packages/hivetui/Cargo.toml y la entrada `hivetui` de Cargo.lock
 *
 * Es la única fuente de verdad del número: `scripts/release.sh` la llama y
 * `tests/contracts/version-lockstep.test.ts` falla si algo diverge.
 *
 *   bun scripts/set-version.ts 0.1.2
 */
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const ROOT = resolve(import.meta.dir, "..")
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

export function versionFiles(root = ROOT): { json: string[]; cargoToml: string; cargoLock: string } {
  const json = [join(root, "package.json")]
  const pkgs = join(root, "packages")
  for (const name of readdirSync(pkgs)) {
    const f = join(pkgs, name, "package.json")
    if (existsSync(f)) json.push(f)
  }
  const tui = join(pkgs, "hivetui")
  return { json, cargoToml: join(tui, "Cargo.toml"), cargoLock: join(tui, "Cargo.lock") }
}

/** `[package]` → primer `version = "x"` de Cargo.toml. */
export function cargoTomlVersion(text: string): string | undefined {
  const section = text.split(/^\[/m).find(s => s.startsWith("package]"))
  return section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
}

/** Versión de un paquete dentro de Cargo.lock. */
export function cargoLockVersion(text: string, crate: string): string | undefined {
  const re = new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`)
  return text.match(re)?.[1]
}

export function setVersion(version: string, root = ROOT): string[] {
  if (!SEMVER.test(version)) throw new Error(`versión inválida: ${version}`)
  const files = versionFiles(root)
  const touched: string[] = []

  for (const f of files.json) {
    const raw = readFileSync(f, "utf8")
    if (JSON.parse(raw).version === version) continue
    // Reemplazo textual de la primera clave "version": reescribir con
    // JSON.stringify cambiaba escapes y orden y ensuciaba el diff.
    const out = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
    if (JSON.parse(out).version !== version) throw new Error(`no pude actualizar ${f}`)
    writeFileSync(f, out)
    touched.push(f)
  }

  const toml = readFileSync(files.cargoToml, "utf8")
  if (cargoTomlVersion(toml) !== version) {
    const out = toml.replace(/(\[package\][^\[]*?^version\s*=\s*")[^"]+(")/ms, `$1${version}$2`)
    if (cargoTomlVersion(out) !== version) throw new Error("no pude actualizar Cargo.toml")
    writeFileSync(files.cargoToml, out)
    touched.push(files.cargoToml)
  }

  const lock = readFileSync(files.cargoLock, "utf8")
  if (cargoLockVersion(lock, "hivetui") !== version) {
    const out = lock.replace(/(\[\[package\]\]\nname = "hivetui"\nversion = ")[^"]+(")/, `$1${version}$2`)
    if (cargoLockVersion(out, "hivetui") !== version) throw new Error("no pude actualizar Cargo.lock")
    writeFileSync(files.cargoLock, out)
    touched.push(files.cargoLock)
  }
  return touched
}

if (import.meta.main) {
  const version = process.argv[2]?.replace(/^v/, "")
  if (!version) { console.error("uso: bun scripts/set-version.ts X.Y.Z"); process.exit(2) }
  const touched = setVersion(version)
  console.log(`versión ${version} → ${touched.length ? touched.map(f => f.replace(ROOT + "/", "")).join(", ") : "sin cambios"}`)
}
