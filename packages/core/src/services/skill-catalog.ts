import { SkillLoader, getClaudeSkillsDirs, type Skill } from "@johpaz/hivecode-skills";
import path from "node:path";
import { col } from "../storage/hive";
import type { SkillDoc } from "../storage/collections";
import { syncSkillsToIndex } from "../agent/skill-selector";
import type { Config } from "../config/loader";

export async function syncSkillCatalog(skills: Skill[]): Promise<void> {
  const collection = await col<SkillDoc>("skills");
  const names = new Set(skills.map(skill => skill.name));
  const now = Date.now();
  for (const skill of skills) {
    const previous = await collection.get(skill.name);
    const next: SkillDoc = {
      id: skill.name, name: skill.name, description: skill.description, version: String(skill.version ?? "0.0.1"),
      author: skill.author ?? "Anonymous", icon: skill.icon ?? "skill", category: skill.category ?? "general",
      permissions: JSON.stringify(skill.permissions ?? []), dependencies: JSON.stringify(skill.dependencies ?? []),
      tools: (skill.tools ?? []).join(","), triggers: (skill.triggers ?? []).join(","),
      preferred_agents: JSON.stringify(skill.preferred_agents ?? []), body: skill.content,
      metadata: JSON.stringify(skill.metadata), source_path: skill.path, catalog_managed: true,
      version_num: Number.parseInt(String(skill.version ?? "1"), 10) || 1,
      active: previous?.doc.active ?? true, created_at: previous?.doc.created_at ?? now, updated_at: now,
    };
    if (previous) {
      const { updated_at: ignored, ...before } = previous.doc;
      const { updated_at: nextIgnored, ...after } = next;
      if (Object.keys(after).length === Object.keys(before).length &&
          Object.entries(after).every(([key, value]) => value === before[key as keyof typeof before])) continue;
    }
    await collection.put(skill.name, next, { expectedVersion: previous?.version ?? 0 });
  }
  for (const entry of await collection.scan()) {
    if (entry.doc.catalog_managed && !names.has(entry.id)) await collection.delete(entry.id);
  }
}

export function catalogSkillLoader(config: Config): SkillLoader {
  return new SkillLoader({ workspacePath: process.cwd(), skills: {
    ...config.skills,
    extraDirs: [...getClaudeSkillsDirs(), ...(config.skills?.extraDirs ?? []),
      ...(process.env.HIVE_SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? [])],
  } });
}

let loader: SkillLoader | null = null;
export async function startSkillCatalogReload(config: Config): Promise<void> {
  if (loader || !config.skills?.hotReload) return;
  loader = catalogSkillLoader(config);
  await syncSkillCatalog(loader.loadAllSkills());
  await syncSkillsToIndex();
  loader.startHotReload(async skills => { await syncSkillCatalog(skills); await syncSkillsToIndex(); });
}
export async function stopSkillCatalogReload(): Promise<void> {
  await loader?.stopHotReload();
  loader = null;
}
