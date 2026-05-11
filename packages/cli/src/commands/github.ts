import { getDb } from "@johpaz/hive-code-core/storage/sqlite"

export async function github(subcommand?: string, args?: string[]): Promise<void> {
  switch (subcommand) {
    case "connect":
      console.log("🔗 GitHub OAuth flow:")
      console.log("   1. Create a GitHub Personal Access Token at:")
      console.log("      https://github.com/settings/tokens")
      console.log("   2. Run: hive-code secret set GITHUB_TOKEN")
      console.log("   3. Then run: hive-code github status")
      break

    case "disconnect":
      try { delete Bun.secrets["GITHUB_TOKEN"] } catch { /* noop */ }
      console.log("✅ GitHub disconnected.")
      break

    case "status": {
      let token: string | undefined
      try { token = Bun.secrets?.["GITHUB_TOKEN"] as string } catch { /* noop */ }
      if (!token) token = process.env.GITHUB_TOKEN
      if (!token) {
        console.log("❌ No GitHub token configured.")
        console.log("   Run: hive-code github connect")
        return
      }
      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "hive-code" },
        })
        if (res.ok) {
          const user = await res.json() as any
          console.log(`✅ Connected as: ${user.login} (${user.name || "no name"})`)
          const rateRes = await fetch("https://api.github.com/rate_limit", {
            headers: { Authorization: `Bearer ${token}`, "User-Agent": "hive-code" },
          })
          if (rateRes.ok) {
            const rate = await rateRes.json() as any
            const core = rate.resources.core
            console.log(`   API Rate limit: ${core.remaining}/${core.limit} remaining`)
          }
        } else {
          console.log("❌ Token invalid or expired.")
        }
      } catch (err) {
        console.log(`❌ Could not reach GitHub: ${(err as Error).message}`)
      }
      break
    }

    case "set-repo": {
      const repo = args?.[0]
      if (!repo) { console.log("Usage: hive-code github set-repo <owner/repo>"); return }
      const db = getDb()
      db.query("INSERT OR REPLACE INTO scratchpad (thread_id, key, value) VALUES ('github', 'repo', ?)").run(repo)
      console.log(`✅ Repo set to: ${repo}`)
      break
    }

    default:
      console.log("Usage:")
      console.log("  hive-code github connect           Conectar con GitHub")
      console.log("  hive-code github disconnect        Desconectar")
      console.log("  hive-code github status            Estado de integración")
      console.log("  hive-code github set-repo <repo>   Configurar repositorio")
  }
}
