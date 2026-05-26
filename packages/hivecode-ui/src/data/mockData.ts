import type { Worker, WorkerStatus, Message, Checkpoint, Conflict, FileTreeItem, DiffLine, Tier, AdrMeta } from './types'

export const WORKERS: Record<string, Worker> = {
  bee:             { color: 'var(--w-bee)',             label: 'Bee',             role: 'coordinator', tier: 0 },
  product_manager: { color: 'var(--w-product_manager)', label: 'ProductManager',  role: 'spec',        tier: 1 },
  architecture:    { color: 'var(--w-architecture)',    label: 'Architecture',    role: 'designer',    tier: 1 },
  backend:         { color: 'var(--w-backend)',         label: 'BackendEngineer', role: 'implementer', tier: 2 },
  frontend:        { color: 'var(--w-frontend)',        label: 'FrontendEngineer',role: 'implementer', tier: 2 },
  mobile:          { color: 'var(--w-mobile)',          label: 'MobileEngineer',  role: 'implementer', tier: 2 },
  data_science:    { color: 'var(--w-data_science)',    label: 'DataScientist',   role: 'implementer', tier: 2 },
  security:        { color: 'var(--w-security)',        label: 'SecurityAuditor', role: 'auditor',     tier: 3 },
  qa:              { color: 'var(--w-qa)',              label: 'QAEngineer',      role: 'validator',   tier: 3 },
  devops:          { color: 'var(--w-devops)',          label: 'DevOpsEngineer',  role: 'infra',       tier: 3 },
  code_reviewer:   { color: 'var(--w-code_reviewer)',   label: 'CodeReviewer',    role: 'gate · L+1',  tier: 4 },
  forensic:        { color: 'var(--w-forensic)',        label: 'ForensicAgent',   role: 'on-demand',   tier: 5 },
  librarian:       { color: 'var(--w-librarian)',       label: 'Librarian',       role: 'on-demand',   tier: 5 },
}

export const WORKERS_STATE: WorkerStatus[] = [
  { id: 'bee',             state: 'running', action: 'orquestando ciclo · resolviendo conflicto medium en auth/',         tokens: '3.1k', cost: '$0.06', active: true,  conflict: false },
  { id: 'product_manager', state: 'done',    action: 'PRD-007 emitido · 6 criterios de aceptación verificables',          tokens: '0.9k', cost: '$0.02', active: false, conflict: false },
  { id: 'architecture',    state: 'done',    action: 'ADR-003 actualizado · blacklist en sqlite + FTS5 · contratos TS',   tokens: '1.8k', cost: '$0.04', active: false, conflict: false },
  { id: 'backend',         state: 'running', action: 'editando auth/middleware.ts · línea 84 · usando blacklist.has()',    tokens: '4.6k', cost: '$0.09', active: true,  conflict: true  },
  { id: 'frontend',        state: 'waiting', action: 'pregunta en blackboard · esperando contrato /auth/refresh',          tokens: '0.2k', cost: '$0.00', active: false, conflict: true  },
  { id: 'mobile',          state: 'running', action: 'expo build iOS · refresh hook · RN 0.75',                            tokens: '2.4k', cost: '$0.05', active: true,  conflict: false },
  { id: 'data_science',    state: 'waiting', action: 'idle · sin tarea ML en esta sesión',                                 tokens: '0.0k', cost: '$0.00', active: false, conflict: false },
  { id: 'security',        state: 'warn',    action: 'transversal · flag CRITICAL: localStorage → httpOnly cookie',         tokens: '1.1k', cost: '$0.02', active: true,  conflict: false },
  { id: 'qa',              state: 'running', action: 'corrigiendo revoke_after_logout · 11/12 verde',                       tokens: '1.4k', cost: '$0.03', active: true,  conflict: false },
  { id: 'devops',          state: 'waiting', action: 'idle · próximo checkpoint dispara deploy:staging',                    tokens: '0.0k', cost: '$0.00', active: false, conflict: false },
  { id: 'code_reviewer',   state: 'waiting', action: 'esperando QA verde · modelo: opus-4.1 (override)',                    tokens: '0.0k', cost: '$0.00', active: false, conflict: false },
  { id: 'forensic',        state: 'idle',    action: 'standby · activable si un worker satura iteraciones',                 tokens: '0.0k', cost: '$0.00', active: false, conflict: false },
  { id: 'librarian',       state: 'idle',    action: 'standby · activable post-aprobación para destilar agent_memory',      tokens: '0.0k', cost: '$0.00', active: false, conflict: false },
]

export const INITIAL_MESSAGES: Message[] = [
  {
    id: 1, who: 'user', name: 'Tú', time: '14:20',
    body: 'implementa JWT refresh token con blacklist',
  },
  {
    id: 2, who: 'bee', name: 'Bee', time: '14:21',
    body: 'Clasifico como `architecture`. Consultando `agent_memory` … 3 patterns relevantes + ADR-003 activo.\nMi plan:',
    bullets: [
      'Dispatcho `architecture` para actualizar ADR-003',
      'Tabla `token_blacklist` en `schema.ts`',
      'Migration con drizzle-kit (idempotente)',
      'Middleware en `auth/middleware.ts` con rate-limit',
      'L3 paralelo: `security` (transversal), `qa` espera engineers',
    ],
    tail: 'Dispatching → architecture',
  },
  {
    id: 3, who: 'architecture', name: 'Architecture', time: '14:22',
    body: 'ADR-003 §4.2 — confirma blacklist en sqlite + FTS5 (local-first), no en servicio externo. Contratos TS escritos en blackboard.',
  },
  {
    id: 4, who: 'backend', name: 'BackendEngineer', time: '14:23',
    body: 'Leyendo contratos · creando `auth/middleware.ts` …',
    tool: '↳ edit_file  auth/middleware.ts  +84 −12',
  },
  {
    id: 5, who: 'security', name: 'SecurityAuditor', time: '14:24',
    body: 'CRITICAL · transversal · el plan guardaba el refresh token en localStorage. Constraint escrito en blackboard: httpOnly cookie + SameSite=strict.',
  },
  {
    id: 6, who: 'bee', name: 'Bee', time: '14:25',
    body: 'Severidad CRITICAL · pero resoluble sin HALT (security ofreció constraint claro). Re-dispatching `backend` con el constraint aplicado.',
  },
  {
    id: 7, who: 'qa', name: 'QAEngineer', time: '14:27',
    body: '12 tests escritos a partir de los 6 criterios de aceptación del PRD-007 · 11 pass · 1 fail (revoke_after_logout). Fallo dirigido a `backend` en blackboard.',
    tool: '↳ jest  auth.test.ts  → 11/12',
  },
]

export const FILE_TREE: FileTreeItem[] = [
  { type: 'folder', path: 'src/auth/' },
  { type: 'file', risk: 'warn', name: 'middleware.ts',   note: '+84 -12' },
  { type: 'file', risk: 'warn', name: 'refresh.ts',      note: '+42  new' },
  { type: 'folder', path: 'src/database/' },
  { type: 'file', risk: 'crit', name: 'schema.ts',       note: '+22 -3' },
  { type: 'adr',  text: '↳ bloqueado por ADR-003 §4.2' },
  { type: 'file', risk: 'crit', name: '0007_token_blacklist.sql', note: 'migration' },
  { type: 'folder', path: 'src/components/' },
  { type: 'file', risk: 'done', name: 'LoginForm.tsx',   note: '+12 -4' },
  { type: 'file', risk: 'done', name: 'Button.tsx',      note: 'no change' },
  { type: 'folder', path: 'tests/' },
  { type: 'file', risk: 'warn', name: 'auth.test.ts',    note: '11/12' },
]

export const DIFF_LINES: DiffLine[] = [
  { type: 'hunk', text: '@@ src/auth/middleware.ts  · line 38 ─────────────' },
  { type: 'ctx', l: 38, r: 38, code: "import { Request, Response, NextFunction } from 'express';" },
  { type: 'ctx', l: 39, r: 39, code: "import { verifyJWT } from './jwt';" },
  { type: 'rem', l: 40, r: '',  code: "import { isRevoked } from './revoked-list';" },
  { type: 'add', l: '',  r: 40, code: "import { blacklist } from './sqlite-blacklist';" },
  { type: 'add', l: '',  r: 41, code: "import { rateLimit } from './rate-limit';" },
  { type: 'ctx', l: 41, r: 42, code: '' },
  { type: 'ctx', l: 42, r: 43, code: 'export async function authGuard(' },
  { type: 'ctx', l: 43, r: 44, code: '  req: Request, res: Response, next: NextFunction' },
  { type: 'ctx', l: 44, r: 45, code: ') {' },
  { type: 'rem', l: 45, r: '',  code: "  const token = req.headers.authorization?.split(' ')[1];" },
  { type: 'add', l: '',  r: 46, code: "  const token = req.cookies['hc_at'];" },
  { type: 'ctx', l: 46, r: 47, code: '  if (!token) return res.sendStatus(401);' },
  { type: 'ctx', l: 47, r: 48, code: '' },
  { type: 'rem', l: 48, r: '',  code: '  if (await isRevoked(token)) return res.sendStatus(401);' },
  { type: 'add', l: '',  r: 49, code: '  if (await blacklist.has(token)) {' },
  { type: 'add', l: '',  r: 50, code: "    return res.status(401).json({ code: 'TOKEN_REVOKED' });" },
  { type: 'add', l: '',  r: 51, code: '  }' },
  { type: 'ctx', l: 49, r: 52, code: '' },
  { type: 'ctx', l: 50, r: 53, code: '  try {' },
  { type: 'ctx', l: 51, r: 54, code: '    const payload = await verifyJWT(token);' },
  { type: 'add', l: '',  r: 55, code: '    await rateLimit.tap(payload.sub);' },
  { type: 'ctx', l: 52, r: 56, code: '    req.user = payload;' },
  { type: 'ctx', l: 53, r: 57, code: '    next();' },
  { type: 'ctx', l: 54, r: 58, code: '  } catch (err) {' },
  { type: 'rem', l: 55, r: '',  code: '    res.sendStatus(401);' },
  { type: 'add', l: '',  r: 59, code: "    res.status(401).json({ code: 'INVALID_TOKEN' });" },
  { type: 'ctx', l: 56, r: 60, code: '  }' },
  { type: 'ctx', l: 57, r: 61, code: '}' },
]

export const CHECKPOINTS: Checkpoint[] = [
  { time: '14:21', label: 'plan aprobado' },
  { time: '14:28', label: 'schema migrated' },
  { time: '14:32', label: 'middleware draft' },
  { time: '14:35', label: 'tests verdes (11/12)' },
]

export const CONFLICT: Conflict = {
  a: 'backend',
  b: 'frontend',
  file: 'auth/schema.ts',
  level: 'CRITICAL',
  detail: 'shape divergente · payload.exp:number vs payload.expires_at:string',
}

export const ADR_TEXT: AdrMeta = {
  id: 'ADR-003',
  title: 'Token Revocation Strategy',
  meta: 'Status: ACCEPTED · v2 · 2025-11-14 · owners: architecture, security',
}

export const TIERS: Tier[] = [
  { id: 'l0', label: 'L0 · COORDINATOR', hint: 'punto de entrada · ruteo · resolución de conflictos',     ids: ['bee'] },
  { id: 'l1', label: 'L1 · PLANNING',    hint: 'PRD → ADR → contratos TS',                                ids: ['product_manager', 'architecture'] },
  { id: 'l2', label: 'L2 · ENGINEERS',   hint: 'paralelo · escriben y modifican código',                  ids: ['backend', 'frontend', 'mobile', 'data_science'] },
  { id: 'l3', label: 'L3 · QUALITY',     hint: 'audit + tests + infra · activos durante y después de L2', ids: ['security', 'qa', 'devops'] },
  { id: 'l4', label: 'L4 · GATE',        hint: 'modelo de mayor capacidad · veredicto final',             ids: ['code_reviewer'] },
  { id: 'l5', label: 'L5 · ON-DEMAND',   hint: 'reflexión forzada · memoria post-sesión',                  ids: ['forensic', 'librarian'] },
]
