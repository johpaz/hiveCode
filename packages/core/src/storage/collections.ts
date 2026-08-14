/**
 * HiveDB document shapes for hiveCode.
 *
 * Keep these types import-only: no runtime imports here, to avoid storage
 * cycles across gateway, tools, workers and the agent loop.
 */

export interface UserDoc {
  id: string;
  name: string | null;
  language: string | null;
  timezone: string | null;
  occupation: string | null;
  notes: string | null;
  master_key_hash: string | null;
  email: string | null;
  password_hash: string | null;
  preferred_cron_channel: string;
  created_at: number;
}

export interface ProviderDoc {
  id: string;
  name: string;
  base_url: string | null;
  category: "llm" | "stt" | "tts";
  num_ctx: number | null;
  num_gpu: number;
  enabled: boolean;
  active: boolean;
  is_free_tier?: boolean;
  created_at: number;
}

export interface ModelDoc {
  id: string;
  provider_id: string;
  name: string;
  model_type: "llm" | "stt" | "tts" | "vision" | "embedding";
  context_window: number;
  capabilities: string | null;
  enabled: boolean;
  active: boolean;
}

export interface AgentDoc {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  tone: string | null;
  role: "coordinator" | "worker";
  /** Stable v1 harness identity. Legacy/custom agents may omit this field. */
  agent_type?: "bee" | "scout" | "builder" | "verifier" | "reviewer";
  status: string;
  enabled: boolean;
  provider_id: string;
  model_id: string;
  tools_json: string | null;
  skills_json: string | null;
  parent_id: string;
  max_iterations: number;
  /** Optional per-profile controls exposed by the Dashboard. */
  fallback_provider_id?: string;
  fallback_model_id?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_cost_usd?: number;
  permission_profile?: "orchestrate" | "read_only" | "write_workspace" | "verify" | "review";
  user_instructions?: string;
  config_version?: number;
  workspace: string | null;
  lastTraceAt?: number;
  created_at: number;
  updated_at: number;
}

export interface ChannelDoc {
  id: string;
  user_id: string;
  type: string;
  enabled: boolean;
  active: boolean;
  status: string;
  last_active: number | null;
  voice_enabled: boolean;
  tts_enabled: boolean;
  stt_provider: string | null;
  tts_provider: string | null;
  tts_voice_id: string | null;
  step_delivery_mode: string;
  vision_enabled: boolean;
  ocr_provider: string | null;
  vision_provider: string | null;
  vision_model_id: string | null;
}

export interface UserIdentityDoc {
  user_id: string;
  channel: string;
  channel_user_id: string;
  linked_at: number;
}

export interface UserChannelDoc {
  id: string;
  user_id: string;
  channel: string;
  account_id: string;
  config: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface RefreshTokenDoc {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
  revoked: boolean;
}

export interface ToolDoc {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  enabled: boolean;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface SkillDoc {
  id: string;
  name: string;
  description: string | null;
  version: string;
  author: string;
  icon: string;
  category: string;
  permissions: string;
  dependencies: string;
  tools: string;
  triggers: string;
  preferred_agents: string;
  body: string;
  version_num: number;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface EthicsDoc {
  id: string;
  name: string;
  description: string | null;
  content: string;
  is_default: boolean;
  enabled: boolean;
  active: boolean;
}

export interface McpServerDoc {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env_encrypted?: string | null;
  env_iv?: string | null;
  headers_encrypted?: string | null;
  headers_iv?: string | null;
  url: string | null;
  enabled: boolean;
  active: boolean;
  builtin: boolean;
  status: string;
  tools_count: number;
  user_id?: string;
}

export interface McpToolDoc {
  id: string;
  server_id: string;
  server_name: string;
  tool_name: string;
  description: string | null;
  category: string | null;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface PlaybookDoc {
  id: string;
  rule: string;
  category: string;
  applicable_to: string | null;
  helpful_count: number;
  harmful_count: number;
  source_reflection_id: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface ReflectionDoc {
  id: string;
  trace_ids: string;
  insight_type: "success_pattern" | "failure_pattern" | "optimization" | "ethics_violation";
  description: string;
  affected_tools: string | null;
  affected_agents: string | null;
  confidence: number;
  created_at: number;
}

export interface ConversationDoc {
  id: string;
  thread_id: string;
  channel: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  content_multimodal: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  reasoning_content: string | null;
  token_count: number;
  created_at: number;
  updated_at: number;
}

export interface SummaryDoc {
  thread_id: string;
  summary: string;
  messages_covered: number;
  last_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScratchpadDoc {
  id: string;
  thread_id: string;
  key: string;
  value: string;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export interface TraceDoc {
  id: string;
  thread_id: string;
  agent_id: string;
  agent_name: string;
  tool_used: string | null;
  input_summary: string;
  output_summary: string;
  success: boolean;
  error_message: string | null;
  duration_ms: number | null;
  tokens_used: number | null;
  created_at: number;
}

export interface CodeConfigDoc {
  key: string;
  value: string | null;
  updated_at: number;
}

export interface OnboardingProgressDoc {
  id: string;
  user_id: string;
  step: string;
  completed: boolean;
  data: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderFreeOverrideDoc {
  provider_id: string;
  is_free_tier: boolean;
  daily_token_cap: number;
  global_daily_token_cap: number;
  enabled: boolean;
  notes: string | null;
  updated_at: number;
}

export interface ToolCacheDoc {
  key: string;
  value: string;
  expires_at: number | null;
  created_at: number;
}

export interface SchemaMigrationDoc {
  id: string;
  version?: string;
  applied_at: string | number;
}

export interface CursorDoc {
  value: string;
  updated_at?: number;
}

export interface MeetingSessionDoc {
  id: string;
  user_id: string;
  title: string | null;
  status: "active" | "stopped" | "report_ready";
  started_at: number;
  stopped_at: number | null;
  report: string | null;
}

export interface MeetingSegmentDoc {
  id: string;
  meeting_id: string;
  speaker: string | null;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  created_at: number;
}

export interface SessionDoc {
  id: string;
  project_path: string;
  project_name: string;
  started_at: number;
  ended_at: number | null;
  mode: string;
  provider: string;
  model: string;
  version: string;
  token_count: number;
  cost_usd: number;
}

export interface MessageDoc {
  id: string;
  session_id: string;
  role: string;
  agent: string | null;
  content: string;
  content_type: string;
  created_at: number;
}

export interface AgentContextDoc {
  id: string;
  session_id: string;
  agent: string;
  type: string;
  content: string;
  status: string;
  scope: string | null;
  file_path: string | null;
  parent_id: string | null;
  resolved_by: string | null;
  /**
   * What the writer considered before landing on `content` — options discarded and
   * why, assumptions made. Cognition's "share full agent traces, not just individual
   * messages": a bare decision lets parallel writers' unstated assumptions collide;
   * the trace lets a reader spot a conflicting assumption before it becomes a bug.
   */
  trace_summary: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentConflictDoc {
  id: string;
  session_id: string;
  agent_a: string;
  agent_b: string;
  type: string;
  description: string;
  file_path: string | null;
  context_id_a: string | null;
  context_id_b: string | null;
  severity: string;
  resolved: boolean;
  resolved_by: string | null;
  resolution: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface AgentAwarenessDoc {
  id: string;
  session_id: string;
  observer: string;
  observed: string;
  phase: string | null;
  status: string | null;
  last_known_action: string | null;
  last_known_file: string | null;
  pending_question: string | null;
  confidence: number;
  updated_at: number;
}

export interface CheckpointDoc {
  id: string;
  session_id: string;
  created_by: string;
  description: string;
  file_count: number;
  git_stash_ref: string | null;
  created_at: number;
  restored_at: number | null;
}

export interface CheckpointFileDoc {
  id: string;
  checkpoint_id: string;
  file_path: string;
  content: string;
  content_hash: string;
  operation: "created" | "modified" | "deleted";
}

export interface AdrDoc {
  id: string;
  file_path: string;
  title: string;
  status: string;
  content: string;
  summary: string | null;
  updated_at: number;
}

export interface FileRiskDoc {
  id: string;
  session_id: string;
  file_path: string;
  risk_level: string;
  operation: string | null;
  adr_ref: string | null;
  reason: string | null;
  agent: string | null;
  updated_at: number;
}

export interface WorkerActivityDoc {
  id: string;
  session_id: string;
  worker: string;
  phase: string;
  level: number;
  status: string;
  current_action: string | null;
  input_tokens: number;
  output_tokens: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface AgentMemoryDoc {
  id: string;
  project_id: string;
  session_id: string | null;
  type: string;
  content: string;
  metadata: string | null;
  tags: string | null;
  severity: string | null;
  confidence: number | null;
  confirmed_count: number;
  /** Times a later session found this record contradicted by reality. */
  refuted_count: number;
  /** Set once refuted_count > confirmed_count + 2; never injected into future context. */
  deprecated: boolean;
  created_at: number;
  updated_at: number;
}

export interface CodeSessionDoc {
  id: string;
  project_path: string;
  status: "active" | "closed";
  created_at: string;
  last_active: string;
}

export interface CodeTurnDoc {
  id: string;
  session_id: string;
  task_id: string | null;
  user_message: string;
  agent_response: string;
  created_at: string;
  completed_at: string | null;
}

export interface CodeSessionModeDoc {
  id: string;
  session_id: string;
  task_id: string | null;
  mode: "plan" | "approval" | "auto";
  changed_at: string;
  phase_at_change: string | null;
  triggered_by: string;
}

export interface CodeTaskDoc {
  id: string;
  session_id: string;
  description: string;
  status: "pending" | "planning" | "running" | "paused" | "completed" | "failed" | "cancelled" | "rolled_back";
  mode: "plan" | "approval" | "auto" | null;
  branch_name: string | null;
  pr_url: string | null;
  tokens_in: number;
  tokens_out: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  duration_ms: number;
  created_at: string;
  completed_at: string | null;
}

export interface CodeTaskPhaseDoc {
  id: string;
  task_id: string;
  phase_name: string;
  coordinator: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  result_summary: string | null;
  approved_at: string | null;
  approved_by: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface CodeFileChangeDoc {
  id: string;
  task_id: string;
  phase_id: string | null;
  file_path: string;
  change_type: "added" | "modified" | "deleted";
  lines_added: number;
  lines_removed: number;
  created_at: string;
}

export interface CodeNarrativeDoc {
  id: string;
  task_id: string | null;
  session_id: string | null;
  coordinator: string;
  phase: string | null;
  entry: string;
  is_draft: boolean;
  is_override: boolean;
  created_at: string;
}

export interface CodeDecisionDoc {
  id: string;
  task_id: string | null;
  title: string;
  context: string;
  options: string;
  decision: string;
  consequences: string;
  status: "active" | "superseded" | "deprecated";
  created_at: string;
}

export interface CodeFileSnapshotDoc {
  id: string;
  task_id: string;
  file_path: string;
  content: string;
  hash: string;
  snapshot_at: string;
}

export interface CodeTraceDoc {
  id: string;
  task_id: string | null;
  agent_id: string;
  coordinator: string;
  tool_name: string;
  input_summary: string | null;
  output_summary: string | null;
  success: boolean;
  duration_ns: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  analyzed: boolean;
  created_at: string;
}

export interface CodePlaybookDoc {
  id: string;
  rule: string;
  coordinator: string | null;
  source: string;
  helpful_count: number;
  harmful_count: number;
  confidence: number;
  active: boolean;
  created_at: string;
  last_applied: string | null;
}

export interface CodeReflectionDoc {
  id: string;
  traces_analyzed: number;
  insights: string;
  ethics_violation: boolean;
  created_at: string;
}

export interface CodeContextStateDoc {
  session_id: string;
  active_provider: string;
  active_model: string;
  active_mode: "plan" | "approval" | "auto";
  active_mcp: string;
  active_skills: string;
  updated_at: string;
}

export interface CodeContextCacheDoc {
  cache_key: string;
  compiled: string;
  expires_at: string;
  created_at: string;
}

export interface CodeGraphDoc {
  id: string;
  session_id: string;
  file_path: string;
  imports: string;
  exported_by: string;
  exports: string;
  functions: string;
  classes: string;
  complexity: number;
  last_modified: string | null;
  indexed_at: string;
}

export interface CodeRecoveryPointDoc {
  id: string;
  task_id: string;
  phase_id: string | null;
  level: number;
  git_ref: string | null;
  completed_phases: string;
  pending_phases: string;
  last_narrative_id: string | null;
  created_at: string;
}

/**
 * The dependency-ordered plan (ParsedPhase[]) a task is executing, persisted so a
 * later process can re-enter the phase loop at a recovery point's level instead of
 * restarting from scratch. Keyed by task_id (one plan per task).
 */
export interface CodeTaskPlanDoc {
  id: string;
  task_id: string;
  /** JSON-serialised ParsedPhase[] (name, coordinator, description, dependsOn). */
  phases_json: string;
  description: string;
  provider: string;
  model: string;
  arch_narrative: string | null;
  interfaces: string | null;
  mode: string;
  created_at: string;
}

export interface LearningFailureDoc {
  id: string;
  task_id: string | null;
  phase_id: string | null;
  agent: string;
  failure_type: "tool_error" | "phase_failure" | "invalid_output" | "plan_drift" | "timeout";
  error_message: string;
  context_summary: string | null;
  resolved: boolean;
  resolution: string | null;
  created_at: string;
}

export interface LearningProposalDoc {
  id: string;
  source_agent: string;
  proposal_type: "skill_adjust" | "new_skill" | "prompt_change" | "phase_order" | "escalate_to_human";
  description: string;
  failure_ids: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export interface CodeBridgeDoc {
  id: string;
  user_id: string;
  name: string;
  cli_command: string;
  enabled: boolean;
  active: boolean;
  port: number;
  config: string | null;
}

export interface CodeBridgeConfigDoc {
  id: string;
  user_id: string;
  key: string;
  value: string | null;
}

export interface CodeFileDoc {
  id: string;
  session_id: string;
  file_path: string;
  content: string;
  imports: string;
  exports: string;
  functions: string;
  classes: string;
  updated_at: number;
}

export interface ProjectDoc {
  id: string;
  user_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  type: string;
  task: string | null;
  progress: number;
  status: "pending" | "active" | "paused" | "done" | "failed";
  context: string | null;
  parent_id: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface TaskDoc {
  id: string;
  project_id: string;
  agent_id: string;
  parent_task_id: string;
  name: string;
  description: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  progress: number;
  priority: number;
  depends_on: string | null;
  result: string | null;
  error: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CronJobDoc {
  id: string;
  name: string;
  task: string;
  task_type: "recurring" | "one_shot";
  cron_expression: string | null;
  fire_at: string | null;
  timezone: string;
  start_at: string | null;
  stop_at: string | null;
  dom_and_dow: boolean;
  max_runs: number | null;
  protect: boolean;
  interval_sec: number | null;
  agent_id: string;
  channel: string;
  payload: string;
  tool_name: string | null;
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  run_count: number;
  error_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  completed_at: string | null;
}

export interface TaskRunDoc {
  id: string;
  task_id: string;
  status: "running" | "success" | "failed" | "timeout";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  payload_snapshot: string | null;
  agent_response: string | null;
}

export interface AgentBusMessageDoc {
  id: string;
  event_type: string;
  from_worker_id: string;
  to_worker_id: string;
  topic: string | null;
  content: string;
  metadata: string | null;
  created_at: number;
  read: boolean;
}

export interface UsageRecordDoc {
  id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  toon_saved_tokens: number;
  toon_saved_cost: number;
  toon_json_bytes: number;
  toon_toon_bytes: number;
  toon_saved_bytes: number;
  toon_saved_percent: number;
  toon_json_tokens: number;
  toon_toon_tokens: number;
  toon_saved_tokens_pct: number;
  created_at: number;
}

export interface UsageRollupDoc {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toonSavedTokens: number;
  toonSavedCost: number;
  toonSavedBytes: number;
  toonJsonTokens: number;
  toonToonTokens: number;
  toonJsonBytes: number;
  byProvider: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

export type AgentRunStatus =
  | "pending"
  | "running"
  | "waiting_tool"
  | "waiting_user"
  | "resumable"
  | "needs_budget"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentRunDoc {
  id: string;
  task_id: string;
  thread_id: string;
  session_id: string;
  agent_id: string;
  kind: "chat" | "worker" | "harness" | "verification" | "review";
  parent_run_id?: string | null;
  profile_type?: "bee" | "scout" | "builder" | "verifier" | "reviewer";
  objective: string;
  status: AgentRunStatus;
  turn: number;
  max_turns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  checkpoint_json: string | null;
  handoff_json?: string | null;
  blocker: string | null;
  next_action: string | null;
  lease_owner: string;
  lease_expires_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface JobDoc {
  id: string;
  type: string;
  lane: string;
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  payload_json: string;
  run_id: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  lease_owner: string;
  lease_expires_at: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface HarnessTaskDoc {
  taskId: string;
  sessionId: string;
  title: string;
  stage:
    | "understanding"
    | "planning"
    | "ready"
    | "executing"
    | "waiting_user"
    | "reviewing"
    | "integrating"
    | "completed"
    | "failed"
    | "cancelled"
    | "blocked";
  executionPolicy: "auto" | "approval";
  priority: "interactive" | "background";
  contextRevision: number;
  parentTaskId?: string;
  planId?: string;
  workspaceId?: string;
  worktreePath?: string;
  branchName?: string;
  mutating: boolean;
  blocker?: string;
  nextAction?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ToolRunDoc {
  id: string;
  run_id: string;
  task_id: string;
  tool_name: string;
  call_id: string;
  args_json: string;
  result_json: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  read_only: boolean;
  mutates_workspace: boolean;
  mutates_db: boolean;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  error: string | null;
}
