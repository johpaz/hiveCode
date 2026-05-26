export type WorkerState = 'running' | 'done' | 'waiting' | 'warn' | 'idle' | 'error'
export type Mode = 'AUTO' | 'APPROVAL' | 'PLAN'
export type TabId = 'focus' | 'plan' | 'code' | 'review' | 'dashboard'
export type RiskLevel = 'warn' | 'crit' | 'done' | 'wait'

export interface Worker {
  color: string
  label: string
  role: string
  tier: number
}

export interface WorkerStatus {
  id: string
  state: WorkerState
  action: string
  tokens: string
  cost: string
  active: boolean
  conflict: boolean
}

export interface Message {
  id: number
  who: string
  name: string
  time: string
  body: string
  bullets?: string[]
  tail?: string
  tool?: string
}

export interface Checkpoint {
  time: string
  label: string
}

export interface Conflict {
  a: string
  b: string
  file: string
  level: 'CRITICAL' | 'WARN'
  detail: string
}

export type FileTreeItem =
  | { type: 'folder'; path: string }
  | { type: 'file'; risk: RiskLevel; name: string; note: string }
  | { type: 'adr'; text: string }

export type DiffLineType = 'hunk' | 'add' | 'rem' | 'ctx'

export type DiffLine =
  | { type: 'hunk'; text: string }
  | { type: 'add' | 'rem' | 'ctx'; l: number | ''; r: number | ''; code: string }

export interface Tier {
  id: string
  label: string
  hint: string
  ids: string[]
}

export interface AdrMeta {
  id: string
  title: string
  meta: string
}

export interface FileRisk {
  path: string
  risk: string
  operation: string
  reason: string
  agent: string
}

export interface AdrEntry {
  path: string
  title: string
  content: string
  status: string
}

export interface NarrativeLine {
  id: number
  coordinator: string
  content: string
}
