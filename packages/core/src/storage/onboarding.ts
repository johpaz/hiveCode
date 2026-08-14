import { col, toIndexable } from "./hive.ts";
import type { AgentDoc, UserDoc } from "./collections.ts";
import { ensureCoreAgentProfiles } from "../agent/agent-profiles.ts";

export async function resolveUserId(): Promise<string> {
  try {
    const users = await col<UserDoc>("users");
    const row = (await users.scan())
      .map((entry) => entry.doc)
      .sort((a, b) => a.created_at - b.created_at)[0];
    return row?.id ?? "default";
  } catch {
    return "default";
  }
}

export async function resolveAgentId(): Promise<string> {
  try {
    const userId = await resolveUserId();
    await ensureCoreAgentProfiles(userId);
    const bee = await (await col<AgentDoc>("agents")).get("bee");
    if (bee?.doc.enabled) return bee.doc.id;

    const agents = await col<AgentDoc>("agents");
    const coordinator = (await agents.findBy("role", "coordinator"))
      .map((entry) => entry.doc)
      .filter((agent) => agent.enabled)
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (coordinator) return coordinator.id;

    const now = Date.now();
    await agents.put("default", {
      id: "default",
      user_id: userId || toIndexable(null),
      name: "Bee",
      description: "Asistente coordinador principal",
      system_prompt: null,
      tone: null,
      role: "coordinator",
      status: "idle",
      enabled: true,
      provider_id: toIndexable(null),
      model_id: toIndexable(null),
      tools_json: null,
      skills_json: null,
      parent_id: toIndexable(null),
      max_iterations: 15,
      workspace: null,
      created_at: now,
      updated_at: now,
    }, { expectedVersion: 0 });
    return "default";
  } catch {
    return "default";
  }
}

export function runStartupMigrations(): void {
}
