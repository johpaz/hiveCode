import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logger } from "../../packages/mcp/src/logger"
import { MCPClientManager } from "../../packages/mcp/src/manager"
import { SkillLoader } from "../../packages/skills/src/loader"

const root = mkdtempSync(join(tmpdir(), "hive-package-audit-"))
afterEach(() => { logger.setHandler(null); logger.setLevel("info") })
test("MCP children see a handler installed after manager construction", async () => {
 const manager = new MCPClientManager({ servers: {} })
 const messages: string[] = []
 manager.setLogHandler((_level, _context, message) => { messages.push(message) })
 await manager.initialize()
 expect(messages.some(m => m.includes("initialized"))).toBe(true)
})
test("MCP log levels are applied to existing children", () => {
 const child = logger.child("audit")
 const levels: string[] = []
 logger.setHandler(level => { levels.push(level) })
 child.setHandler(level => { levels.push(level) })
 logger.setLevel("error")
 child.info("filtered")
 child.error("visible")
 expect(levels).toEqual(["error"])
})
test("bundled skills are available through cache lookups", () => {
 const loader = new SkillLoader({ workspacePath: root, skills: { managedDir: join(root, "missing") } })
 const skills = loader.loadBundledSkills()
 expect(skills.length).toBeGreaterThan(0)
 expect(loader.getSkill(skills[0]!.name)?.content).toBe(skills[0]!.content)
 expect(loader.listSkills()).toContain(skills[0]!.name)
})
test("skill frontmatter works with Windows line endings", () => {
 const dir = join(root, "crlf"); mkdirSync(dir)
 writeFileSync(join(dir, "SKILL.md"), "---\r\nname: configured-name\r\ndescription: description\r\n---\r\n# Content\r\n")
 const loader = new SkillLoader({})
 const skill = loader.loadSkill(dir, "workspace")!
 expect(skill.name).toBe("configured-name")
 expect(skill.content).toContain("# Content")
 expect(skill.content).not.toContain("name: configured-name")
})
