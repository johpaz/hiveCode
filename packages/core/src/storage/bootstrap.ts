/**
 * HiveDB bootstrap for hiveCode.
 *
 * New installs start directly on HiveDB. It opens the database, ensures
 * equality indexes and reseeds static catalogs.
 */

import { getHiveDb } from "./hivedb";
import { col } from "./hive";
import { seedAllData } from "./seed";
import { ensureCoreAgentProfiles } from "../agent/agent-profiles";
import { resolveUserId } from "./onboarding";
import type { AgentDoc, AgentRunDoc, CodeConfigDoc, JobDoc, ModelDoc } from "./collections";
import {
  HIVEAGENTS_DEFAULT_LOAD_CTX,
  HIVEAGENTS_MODEL_ID,
} from "../agent/llm-providers/hiveagents";

interface IndexSpec {
  collection: string;
  field: string;
  unique?: boolean;
}

const INDEXES: IndexSpec[] = [
  { collection: "models", field: "provider_id" },
  { collection: "models", field: "model_type" },
  { collection: "agents", field: "user_id" },
  { collection: "agents", field: "model_id" },
  { collection: "agents", field: "provider_id" },
  { collection: "agents", field: "parent_id" },
  { collection: "agents", field: "role" },
  { collection: "agents", field: "status" },
  { collection: "agents", field: "agent_type" },
  { collection: "channels", field: "user_id" },
  { collection: "channels", field: "type" },
  { collection: "userIdentities", field: "user_id" },
  { collection: "userIdentities", field: "channel" },
  { collection: "userChannels", field: "user_id" },
  { collection: "userChannels", field: "channel" },
  { collection: "onboardingProgress", field: "user_id" },
  { collection: "onboardingProgress", field: "step" },
  { collection: "providerFreeOverrides", field: "enabled" },
  { collection: "refreshTokens", field: "token_hash", unique: true },
  { collection: "refreshTokens", field: "user_id" },
  { collection: "skills", field: "category" },
  { collection: "skills", field: "active" },
  { collection: "tools", field: "category" },
  { collection: "tools", field: "active" },
  { collection: "ethics", field: "active" },
  { collection: "mcpServers", field: "enabled" },
  { collection: "mcpServers", field: "active" },
  { collection: "mcpServers", field: "status" },
  { collection: "mcpTools", field: "server_id" },
  { collection: "mcpTools", field: "active" },
  { collection: "playbook", field: "active" },
  { collection: "playbook", field: "category" },
  { collection: "toolCache", field: "expires_at" },
  { collection: "meetingSessions", field: "user_id" },
  { collection: "meetingSessions", field: "status" },
  { collection: "meetingSegments", field: "meeting_id" },
  { collection: "sessions", field: "project_path" },
  { collection: "sessions", field: "mode" },
  { collection: "messages", field: "session_id" },
  { collection: "messages", field: "role" },
  { collection: "agentContext", field: "session_id" },
  { collection: "agentContext", field: "status" },
  { collection: "agentContext", field: "type" },
  { collection: "agentContext", field: "file_path" },
  { collection: "agentConflicts", field: "session_id" },
  { collection: "agentConflicts", field: "resolved" },
  { collection: "agentAwareness", field: "session_id" },
  { collection: "agentAwareness", field: "observer" },
  { collection: "agentAwareness", field: "observed" },
  { collection: "checkpoints", field: "session_id" },
  { collection: "checkpointFiles", field: "checkpoint_id" },
  { collection: "adrs", field: "file_path", unique: true },
  { collection: "adrs", field: "status" },
  { collection: "fileRisks", field: "session_id" },
  { collection: "fileRisks", field: "file_path" },
  { collection: "workerActivity", field: "session_id" },
  { collection: "workerActivity", field: "worker" },
  { collection: "agentMemory", field: "project_id" },
  { collection: "agentMemory", field: "session_id" },
  { collection: "agentMemory", field: "type" },
  { collection: "conversations", field: "thread_id" },
  { collection: "conversations", field: "role" },
  { collection: "scratchpad", field: "thread_id" },
  { collection: "traces", field: "thread_id" },
  { collection: "traces", field: "agent_id" },
  { collection: "traces", field: "success" },
  { collection: "projects", field: "user_id" },
  { collection: "projects", field: "agent_id" },
  { collection: "projects", field: "status" },
  { collection: "projects", field: "parent_id" },
  { collection: "tasks", field: "project_id" },
  { collection: "tasks", field: "agent_id" },
  { collection: "tasks", field: "status" },
  { collection: "cronJobs", field: "status" },
  { collection: "cronJobs", field: "task_type" },
  { collection: "cronJobs", field: "agent_id" },
  { collection: "taskRuns", field: "task_id" },
  { collection: "taskRuns", field: "status" },
  { collection: "agentBusMessages", field: "to_worker_id" },
  { collection: "agentBusMessages", field: "from_worker_id" },
  { collection: "agentBusMessages", field: "event_type" },
  { collection: "codeSessions", field: "project_path" },
  { collection: "codeSessions", field: "status" },
  { collection: "codeFiles", field: "session_id" },
  { collection: "codeFiles", field: "file_path" },
  { collection: "codeTurns", field: "session_id" },
  { collection: "codeTurns", field: "task_id" },
  { collection: "codeSessionModes", field: "session_id" },
  { collection: "codeSessionModes", field: "task_id" },
  { collection: "codeTasks", field: "session_id" },
  { collection: "codeTasks", field: "status" },
  { collection: "codeTaskPhases", field: "task_id" },
  { collection: "codeTaskPhases", field: "status" },
  { collection: "codeFileChanges", field: "task_id" },
  { collection: "codeNarrative", field: "task_id" },
  { collection: "codeNarrative", field: "session_id" },
  { collection: "codeNarrative", field: "coordinator" },
  { collection: "codeTraces", field: "task_id" },
  { collection: "codeTraces", field: "analyzed" },
  { collection: "codeDecisions", field: "task_id" },
  { collection: "codeDecisions", field: "status" },
  { collection: "codeFileSnapshots", field: "task_id" },
  { collection: "codePlaybook", field: "active" },
  { collection: "codePlaybook", field: "coordinator" },
  { collection: "codeContextState", field: "active_provider" },
  { collection: "codeContextState", field: "active_mode" },
  { collection: "codeContextCache", field: "expires_at" },
  { collection: "codeGraph", field: "session_id" },
  { collection: "codeGraph", field: "file_path" },
  { collection: "codeRecoveryPoints", field: "task_id" },
  { collection: "learningFailures", field: "task_id" },
  { collection: "learningFailures", field: "agent" },
  { collection: "learningFailures", field: "resolved" },
  { collection: "learningProposals", field: "status" },
  { collection: "learningProposals", field: "source_agent" },
  { collection: "harnessTasks", field: "sessionId" },
  { collection: "harnessTasks", field: "stage" },
  { collection: "harnessTasks", field: "mutating" },
  { collection: "agentRuns", field: "status" },
  { collection: "agentRuns", field: "thread_id" },
  { collection: "agentRuns", field: "agent_id" },
  { collection: "agentRuns", field: "task_id" },
  { collection: "jobQueue", field: "status" },
  { collection: "jobQueue", field: "lane" },
  { collection: "jobQueue", field: "type" },
  { collection: "jobQueue", field: "run_id" },
  { collection: "toolRuns", field: "run_id" },
  { collection: "toolRuns", field: "task_id" },
  { collection: "toolRuns", field: "status" },
  { collection: "cursors", field: "value" },
];

let bootstrapped = false;

async function ensureIndexes(): Promise<void> {
  for (const spec of INDEXES) {
    const c = await col(spec.collection);
    await c.createIndex(spec.field, { unique: spec.unique });
  }
}

async function reconcileInterruptedHarnessState(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ownerAlive = (owner: string): boolean => {
    const match = /:(\d+)$/.exec(owner);
    if (!match) return false;
    try {
      process.kill(Number(match[1]), 0);
      return true;
    } catch {
      return false;
    }
  };
  const agentRuns = await col<AgentRunDoc>("agentRuns");
  for (const entry of await agentRuns.scan()) {
    if (!["running", "waiting_tool"].includes(entry.doc.status)) continue;
    if (entry.doc.lease_expires_at > now && ownerAlive(entry.doc.lease_owner)) continue;
    await agentRuns.put(entry.id, {
      ...entry.doc,
      status: "resumable",
      blocker: "process_interrupted",
      next_action: "resume_from_durable_task",
      lease_owner: "",
      lease_expires_at: 0,
      updated_at: now,
    }, { expectedVersion: entry.version });
  }

  const jobs = await col<JobDoc>("jobQueue");
  for (const entry of await jobs.scan()) {
    if (!["claimed", "running"].includes(entry.doc.status)) continue;
    if (entry.doc.lease_expires_at > now && ownerAlive(entry.doc.lease_owner)) continue;
    await jobs.put(entry.id, {
      ...entry.doc,
      status: "interrupted",
      lease_owner: "",
      lease_expires_at: 0,
      updated_at: now,
    }, { expectedVersion: entry.version });
  }
}

async function enforceHiveAgentsPreset(): Promise<void> {
  const models = await col<ModelDoc>("models");
  const hiveAgentsModel = await models.get(HIVEAGENTS_MODEL_ID);
  if (hiveAgentsModel && hiveAgentsModel.doc.context_window === 8192) {
    await models.put(HIVEAGENTS_MODEL_ID, {
      ...hiveAgentsModel.doc,
      context_window: HIVEAGENTS_DEFAULT_LOAD_CTX,
    }, { expectedVersion: hiveAgentsModel.version });
  }

  const codeConfig = await col<CodeConfigDoc>("codeConfig");
  const modelKey = "provider_model_hiveagents";
  const existingModel = await codeConfig.get(modelKey);
  await codeConfig.put(modelKey, {
    key: modelKey,
    value: HIVEAGENTS_MODEL_ID,
    updated_at: Date.now(),
  }, { expectedVersion: existingModel?.version ?? 0 });

  const agents = await col<AgentDoc>("agents");
  for (const entry of await agents.findBy("provider_id", "hiveagents")) {
    if (entry.doc.model_id === HIVEAGENTS_MODEL_ID) continue;
    await agents.put(entry.id, {
      ...entry.doc,
      model_id: HIVEAGENTS_MODEL_ID,
      updated_at: Date.now(),
    }, { expectedVersion: entry.version });
  }
}

export async function ensureHiveDb(): Promise<void> {
  await getHiveDb();
  await ensureIndexes();
  await seedAllData();
  await ensureCoreAgentProfiles(await resolveUserId());
  await enforceHiveAgentsPreset();
  await reconcileInterruptedHarnessState();

  const meta = await col<{ value: number }>("meta");
  const existing = await meta.get("schemaVersion");
  if (!existing) await meta.put("schemaVersion", { value: 1 }, { expectedVersion: 0 });

  bootstrapped = true;
}

export function isBootstrapped(): boolean {
  return bootstrapped;
}
