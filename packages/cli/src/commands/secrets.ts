export async function secrets(subcommand?: string, args?: string[]): Promise<void> {
  switch (subcommand) {
    case "list":
      try {
        const secrets = Bun.secrets ? Object.keys(Bun.secrets) : []
        if (secrets.length === 0) {
          console.log("No secrets configured.")
        } else {
          console.log("Secrets (names only):")
          for (const name of secrets) console.log(`  - ${name}`)
        }
      } catch {
        console.log("Bun.secrets not available in this environment.")
      }
      break

    case "set": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode secret set <name>"); return }
      const value = await readPassword(`Enter value for ${name}: `)
      try {
        Bun.secrets[name] = value
        console.log(`✅ Secret '${name}' saved.`)
      } catch {
        console.log("Bun.secrets not available. Storing in environment...")
        process.env[`HIVE_SECRET_${name}`] = value
        console.log(`✅ Secret stored in HIVE_SECRET_${name}`)
      }
      break
    }

    case "delete": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode secret delete <name>"); return }
      try {
        delete Bun.secrets[name]
        console.log(`✅ Secret '${name}' deleted.`)
      } catch {
        console.log(`Could not delete '${name}'. Bun.secrets not available.`)
      }
      break
    }

    case "rotate": {
      const name = args?.[0]
      if (!name) { console.log("Usage: hivecode secret rotate <name>"); return }
      const oldValue = await readPassword(`Enter NEW value for ${name}: `)
      try {
        Bun.secrets[name] = oldValue
        console.log(`✅ Secret '${name}' rotated.`)
      } catch {
        process.env[`HIVE_SECRET_${name}`] = oldValue
        console.log(`✅ Secret '${name}' rotated (env fallback).`)
      }
      break
    }

    default:
      console.log("Usage:")
      console.log("  hivecode secret list           Listar secrets (solo nombres)")
      console.log("  hivecode secret set <name>     Establecer secret")
      console.log("  hivecode secret delete <name>  Eliminar secret")
      console.log("  hivecode secret rotate <name>  Rotar secret")
  }
}

async function readPassword(prompt: string): Promise<string> {
  console.log(prompt)
  const buf = new Uint8Array(1024)
  const n = (Bun.stdin as any).read(buf)
  if (n === null) return ""
  return new TextDecoder().decode(buf.subarray(0, n)).trim()
}
