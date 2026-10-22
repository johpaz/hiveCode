/**
 * What each core agent starts a turn with: its tools and skills, and what they cost in context. No model is called.
 *
 *   bun scripts/audit-loadouts.ts [dir]
 *
 * Compiles the context of every profile the way a real run does (isolated for the workers, a plain turn for BEE)
 * against an index of `dir` (default: the current directory) in a throwaway database, and prints the loadout.
 * The point is to see, per agent, what is in the context of EVERY turn before it has done anything.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.HIVE_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "audit-loadouts-")), "db")
const R = new URL("../", import.meta.url).pathname
const { ensureHiveDb } = await import(R + "packages/core/src/storage/bootstrap.ts")
const { col } = await import(R + "packages/core/src/storage/hive.ts")
const { ensureCoreAgentProfiles } = await import(R + "packages/core/src/agent/agent-profiles.ts")
const { ensureProject, projectIdentity } = await import(R + "packages/core/src/agent/project-identity.ts")
const { reconcileCodeIndex } = await import(R + "packages/code/src/agent/code-indexer.ts")
const { compileContext } = await import(R + "packages/core/src/agent/context-compiler.ts")

const workspace = path.resolve(process.argv[2] ?? process.cwd())
await ensureHiveDb()
await ensureCoreAgentProfiles()
const project = projectIdentity(workspace)
await ensureProject(workspace)
await ((await col("codeSessions")) as any).put("audit", { id: "audit", project_path: workspace, status: "active", created_at: new Date().toISOString(), last_active: new Date().toISOString() }, { expectedVersion: 0 })
await reconcileCodeIndex(project.id, project.root)

const tok = (s: string) => Math.round(s.length / 3.5)
const task = "Revisa packages/core/src/harness y dime los riesgos."
let grand = 0
for (const agentId of ["bee", "scout", "planner", "builder", "verifier", "spider"]) {
  const isBee = agentId === "bee"
  const ctx: any = await compileContext({ agentId, threadId: `audit-${agentId}`, userMessage: task, taskContext: isBee ? undefined : task, codeSessionId: "audit", workspace, isolated: !isBee })
  const tools = ctx.tools.map((t: any) => ({ name: t.function.name, tokens: tok(JSON.stringify(t)) })).sort((a: any, b: any) => b.tokens - a.tokens)
  const skills = (ctx.skills ?? []).map((s: any) => ({ name: s.name, tokens: tok(s.body ?? "") })).sort((a: any, b: any) => b.tokens - a.tokens)
  const toolTokens = tools.reduce((s: number, t: any) => s + t.tokens, 0)
  const skillTokens = skills.reduce((s: number, t: any) => s + t.tokens, 0)
  grand += toolTokens + skillTokens
  console.log(`\n## ${agentId} · total del contexto ≈ ${ctx.contextMetrics.total} tok · herramientas ${tools.length} = ${toolTokens} tok · skills ${skills.length} = ${skillTokens} tok · paquete de proyecto ${ctx.contextMetrics.project} tok`)
  console.log(`   herramientas: ${tools.map((t: any) => `${t.name}(${t.tokens})`).join(" ")}`)
  console.log(`   skills:       ${skills.map((s: any) => `${s.name}(${s.tokens})`).join(" ") || "—"}`)
  console.log(`   search_knowledge presente: ${tools.some((t: any) => t.name === "search_knowledge") ? "sí" : "NO"}`)
}
rmSync(path.dirname(process.env.HIVE_DB_PATH!), { recursive: true, force: true })
process.exit(0)
