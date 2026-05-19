export type PhaseName =
  | "bee"
  | "architecture"
  | "backend"
  | "frontend"
  | "security"
  | "test"
  | "devops"

export type CoordinatorStatus =
  | "idle"
  | "busy"
  | "completed"
  | "failed"
  | "blocked"
  | "needs_approval"

export type TaskStatus =
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

export type PhaseStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"

export type SessionMode = "plan" | "approval" | "auto"

export interface ConversationTurn {
  role: "user" | "agent"
  content: string
  createdAt: string
}

export interface CoordinatorTask {
  taskId: string
  phaseId: number
  phase: PhaseName
  description: string
  adr?: string
  interfaces?: string
  narrative: string
  previousPhaseOutput?: string
  mode: SessionMode
  projectPath: string
  /** Secrets distributed by the main thread (fallback when setEnvironmentData unavailable) */
  secrets?: Record<string, string>
  /** LLM provider to use (e.g., "anthropic", "openai", "groq") */
  provider?: string
  /** LLM model to use (e.g., "claude-sonnet-4-6", "gpt-4o") */
  model?: string
  /** Tools available to this coordinator (injected by manager) */
  tools?: any[]
  /** Pre-compiled context from Context Compiler (skills, playbook, scratchpad) */
  compiledContext?: string
  /** Recent conversation turns in this session — gives BEE chat context */
  conversationHistory?: ConversationTurn[]
}

export interface CoordinatorResult {
  taskId: string
  phaseId: number
  coordinator: string
  status: CoordinatorStatus
  narrativeEntry: string
  filesModified: string[]
  blockerDescription?: string
  approvalPreview?: string
  durationMs: number
  tokensIn?: number
  tokensOut?: number
}

/** Messages sent FROM workers TO the manager */
export interface WorkerToManagerMessage {
  type: "RESULT" | "TOOL_CALL" | "THINKING"
  taskId: string
  phaseId: number
  coordinator: string
  result?: CoordinatorResult
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolCallId?: string
  /** Thinking message content (for THINKING type) */
  content?: string
  /** Stream ID for grouping thinking chunks into a single display block.
   *  Same streamId = same streaming block (append), different streamId = new block. */
  streamId?: string
}

/** Messages sent FROM manager TO workers */
export interface ManagerToWorkerMessage {
  type: "TASK" | "TOOL_RESULT"
  task?: CoordinatorTask
  toolCallId?: string
  result?: unknown
  error?: string
}

export interface ControlMessage {
  type: "MODE_CHANGED" | "TASK_CANCELLED" | "PAUSE" | "RESUME" | "SHUTDOWN"
  sessionId: string
  payload: {
    mode?: SessionMode
    taskId?: string
  }
}

export interface NarrativeEntry {
  id?: number
  taskId: string
  sessionId: string
  coordinator: string
  phase?: string
  entry: string
  isDraft: boolean
  isOverride: boolean
  createdAt?: string
}

export interface ADR {
  id: string
  taskId: string
  title: string
  context: string
  options: string
  decision: string
  consequences: string
  status: "active" | "superseded" | "deprecated"
  createdAt?: string
}

export interface FileSnapshot {
  id?: number
  taskId: string
  filePath: string
  content: string
  hash: string
  snapshotAt?: string
}

export interface Trace {
  id?: number
  taskId: string
  agentId: string
  coordinator: string
  toolName: string
  inputSummary: string
  outputSummary: string
  success: boolean
  durationNs: number
  tokensIn?: number
  tokensOut?: number
  analyzed?: boolean
  createdAt?: string
}

export interface BeeDecision {
  /** How BEE decided to handle the task */
  action: "respond" | "fix" | "architecture" | "dispatch"
  /** Direct answer or summary of fix applied (required for "respond" and "fix") */
  content?: string
  /** Why BEE made this decision */
  reason: string
  /** Coordinators to dispatch directly (only for "dispatch" action) */
  phases?: Array<{
    coordinator: Exclude<PhaseName, "bee">
    description: string
    dependsOn: Array<Exclude<PhaseName, "bee">>
  }>
  /** Files BEE modified directly (only for "fix" action) */
  filesModified?: string[]
  /** Structured harness document (plan/approval modes only, for dispatch/architecture actions) */
  harness?: string
}

export interface PlaybookRule {
  id?: number
  rule: string
  coordinator?: string
  helpfulCount: number
  harmfulCount: number
  confidence: number
  active: boolean
  createdAt?: string
  lastApplied?: string
}
