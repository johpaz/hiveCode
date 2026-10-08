import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader } from "../../packages/skills/src/loader";

test("cache removes deleted workspace skills and size limit is enforced", () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-skills-"));
 try {
  const dir = path.join(root, "skills", "temporary"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: temporary\ndescription: test\nrules: [keep]\n---\nhello");
  const loader = new SkillLoader({ workspacePath: root, skills: { managedDir: path.join(root, "managed"), maxSkillSizeKB: 1 } });
  loader.loadAllSkills(); expect(loader.getSkill("temporary")?.rules).toEqual(["keep"]);
  fs.rmSync(dir, { recursive: true }); loader.loadAllSkills(); expect(loader.getSkill("temporary")).toBeUndefined();
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "SKILL.md"), "x".repeat(1025));
  expect(loader.loadSkill(dir, "workspace")).toBeNull();
 } finally { fs.rmSync(root, { recursive: true }); }
});

test("bundled metadata survives static generation", () => {
 const loader = new SkillLoader({ skills: { managedDir: "/nonexistent-hive-audit" } });
 const skills = loader.loadBundledSkills();
 expect(skills.length).toBeGreaterThan(0);
 for (const skill of skills) {
  expect(skill.raw).toContain("---");
  expect(skill.metadata.name).toBe(skill.name);
  if (skill.metadata.rules) expect(skill.rules).toEqual(skill.metadata.rules);
 }
});
