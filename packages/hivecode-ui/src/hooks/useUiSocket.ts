import { useState, useEffect, useCallback } from 'react'
import { uiWs, type BunMessage } from '../lib/uiWs'
import type { Message, Checkpoint, Conflict, Mode, WorkerStatus, FileRisk, AdrEntry, NarrativeLine } from '../data/types'
import { WORKERS } from '../data/mockData'

const INITIAL_WORKERS: WorkerStatus[] = Object.keys(WORKERS).map((id) => ({
  id,
  state: 'idle' as WorkerStatus['state'],
  action: 'standby',
  tokens: '0.0k',
  cost: '$0.00',
  active: false,
  conflict: false,
}))

export function useUiSocket() {
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [workersState, setWorkersState] = useState<WorkerStatus[]>(INITIAL_WORKERS)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [currentCp, setCurrentCp] = useState(-1)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [mode, setMode] = useState<Mode>('AUTO')
  const [tokens, setTokens] = useState('0.0k')
  const [cost, setCost] = useState('$0.00')
  const [fileRisks, setFileRisks] = useState<FileRisk[]>([])
  const [adrs, setAdrs] = useState<AdrEntry[]>([])
  const [narrativeLines, setNarrativeLines] = useState<NarrativeLine[]>([])

  const handleMessage = useCallback((msg: BunMessage) => {
    switch (msg.type) {
      case 'init': {
        setMode((msg.mode?.toUpperCase() as Mode) || 'AUTO')
        setTokens(formatTokens(msg.token_count))
        setMessages([])
        break
      }

      case 'history_append': {
        const agentId = msg.agent || (msg.role === 'user' ? 'user' : 'bee')
        setMessages((prev) => {
          if (prev.some(m => m.id === hashContent(msg.content + msg.timestamp))) return prev
          return [...prev, {
            id: hashContent(msg.content + (msg.timestamp ?? Date.now())),
            who: agentId,
            name: formatName(agentId),
            time: msg.timestamp ?? nowHHMM(),
            body: msg.content,
          }]
        })
        break
      }

      case 'workers_snapshot': {
        setWorkersState((prev) => {
          const updated = [...prev]
          for (const w of msg.workers) {
            const idx = updated.findIndex(u => u.id === w.name)
            if (idx >= 0) {
              updated[idx] = { ...updated[idx], state: mapStatus(w.status), action: w.detail ?? updated[idx].action }
            }
          }
          return updated
        })
        break
      }

      case 'activity_update': {
        if (!msg.coordinator) break
        setWorkersState((prev) => {
          const idx = prev.findIndex(w => w.id === msg.coordinator)
          if (idx < 0) return prev
          const updated = [...prev]
          updated[idx] = {
            ...updated[idx],
            state: mapStatus(msg.status),
            action: msg.activity || msg.phase || updated[idx].action,
            active: msg.status === 'running' || msg.status === 'thinking',
          }
          return updated
        })
        break
      }

      case 'checkpoint_created': {
        setCheckpoints((prev) => {
          const next = [...prev, { time: nowHHMM(), label: msg.description }]
          setCurrentCp(next.length - 1)
          return next
        })
        break
      }

      case 'checkpoint_rollback': {
        setMessages((prev) => [...prev, {
          id: Date.now(),
          who: 'bee', name: 'Bee', time: nowHHMM(),
          body: `↩ rollback aplicado · ${msg.files_restored} archivo(s) restaurado(s)`,
        }])
        break
      }

      case 'conflict_alert': {
        setConflict({
          a: msg.agent_a,
          b: msg.agent_b,
          file: msg.file,
          level: msg.severity?.toUpperCase() === 'CRITICAL' ? 'CRITICAL' : 'WARN',
          detail: msg.detail || msg.reason,
        })
        break
      }

      case 'state_update': {
        if (msg.new_mode) setMode(msg.new_mode.toUpperCase() as Mode)
        break
      }

      case 'file_risk_update': {
        setFileRisks((prev) => {
          const idx = prev.findIndex(r => r.path === msg.path)
          const entry: FileRisk = { path: msg.path, risk: msg.risk, operation: msg.operation, reason: msg.reason, agent: msg.agent }
          if (idx >= 0) { const u = [...prev]; u[idx] = entry; return u }
          return [...prev, entry]
        })
        break
      }

      case 'adr_update': {
        setAdrs((prev) => {
          const idx = prev.findIndex(a => a.path === msg.path)
          const entry: AdrEntry = { path: msg.path, title: msg.title, content: msg.content, status: msg.status }
          if (idx >= 0) { const u = [...prev]; u[idx] = entry; return u }
          return [...prev, entry]
        })
        break
      }

      case 'narrative_chunk': {
        setNarrativeLines((prev) => [...prev, { id: Date.now() + prev.length, coordinator: msg.coordinator, content: msg.content }])
        break
      }
    }
  }, [])

  useEffect(() => {
    uiWs.onConnect = () => setConnected(true)
    uiWs.onDisconnect = () => setConnected(false)

    const off = uiWs.on((msg) => {
      handleMessage(msg)
    })

    uiWs.connect()

    return () => {
      off()
      uiWs.onConnect = null
      uiWs.onDisconnect = null
    }
  }, [handleMessage])

  const submit = useCallback((input: string) => {
    uiWs.send({ type: 'submit', input })
  }, [])

  const changeMode = useCallback((newMode: Mode) => {
    setMode(newMode)
    uiWs.send({ type: 'mode_change', mode: newMode })
  }, [])

  return {
    connected,
    messages, setMessages,
    workersState,
    checkpoints, setCheckpoints,
    currentCp, setCurrentCp,
    conflict, setConflict,
    mode, setMode,
    tokens,
    cost,
    fileRisks,
    adrs,
    narrativeLines,
    submit,
    changeMode,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTokens(count: number): string {
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k'
  return String(count)
}

function formatName(agentId: string): string {
  if (agentId === 'user') return 'Tú'
  if (agentId === 'bee') return 'Bee'
  return agentId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function mapStatus(status: string): WorkerStatus['state'] {
  switch (status?.toLowerCase()) {
    case 'running': case 'thinking': case 'active': return 'running'
    case 'done': case 'completed': return 'done'
    case 'waiting': case 'pending': return 'waiting'
    case 'warn': case 'warning': return 'warn'
    case 'error': case 'failed': return 'error'
    default: return 'idle'
  }
}

function hashContent(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return Math.abs(h)
}
