import { useState, useEffect, useRef, useMemo } from 'react'
import type { TabId } from './data/types'
import { WelcomeScreen } from './components/tui/WelcomeScreen'
import { Header } from './components/tui/Header'
import { TabBar, TABS } from './components/tui/TabBar'
import { CheckpointBar } from './components/tui/CheckpointBar'
import { ConflictBar } from './components/tui/ConflictBar'
import { BottomBar } from './components/tui/BottomBar'
import { FocusLayout } from './components/tui/layouts/FocusLayout'
import { PlanLayout } from './components/tui/layouts/PlanLayout'
import { CodeLayout } from './components/tui/layouts/CodeLayout'
import { ReviewLayout } from './components/tui/layouts/ReviewLayout'
import { DashboardLayout } from './components/tui/layouts/DashboardLayout'
import { useUiSocket } from './hooks/useUiSocket'

function nowHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function App() {
  const [tab, setTab] = useState<TabId>('focus')
  const [showWelcome, setShowWelcome] = useState(true)
  const [input, setInput] = useState('')
  const [selectedCp, setSelectedCp] = useState(-1)
  const [clock, setClock] = useState(nowHHMM)

  const {
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
    submit: wsSubmit,
    changeMode,
  } = useUiSocket()

  const runningCount = useMemo(
    () => workersState.filter((w) => w.state === 'running').length,
    [workersState]
  )

  // ticking clock
  useEffect(() => {
    const id = setInterval(() => setClock(nowHHMM()), 30000)
    return () => clearInterval(id)
  }, [])

  // keyboard shortcuts 1-5 to switch tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      const num = parseInt(e.key)
      if (num >= 1 && num <= 5) {
        const t = TABS[num - 1]
        if (t) setTab(t.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const demoStep = useRef(0)
  const runDemo = () => {
    const step = demoStep.current % 4
    const t = nowHHMM()

    if (step === 0) {
      setMessages((m) => [...m, {
        id: Date.now(),
        who: 'frontend', name: 'FrontendEngineer', time: t,
        body: 'preparando hook `useAuthSession` · pregunta a backend en blackboard: shape exacto del response /auth/refresh',
        tool: '↳ scaffold  hooks/useAuthSession.ts',
      }])
    } else if (step === 1) {
      setCheckpoints((cps) => {
        const next = [...cps, { time: t, label: 'frontend integrado' }]
        setCurrentCp(next.length - 1)
        return next
      })
      setMessages((m) => [...m, {
        id: Date.now(),
        who: 'bee', name: 'Bee', time: t,
        body: '⬡ checkpoint creado · auto-save aplicado',
      }])
    } else if (step === 2) {
      setConflict({
        a: 'security', b: 'backend',
        file: 'auth/refresh.ts',
        level: 'CRITICAL',
        detail: 'cookie SameSite=strict rompe SSO flow',
      })
      setMessages((m) => [...m, {
        id: Date.now(),
        who: 'security', name: 'SecurityAuditor', time: t,
        body: 'CONFLICTO con backend · SameSite=strict rompe el SSO actual. Constraint sugerido: `SameSite=lax` + CSRF token.',
      }])
    } else {
      setConflict(null)
      setMessages((m) => [...m, {
        id: Date.now(),
        who: 'bee', name: 'Bee', time: t,
        body: 'conflicto resuelto · acepto sugerencia de security · re-dispatch backend',
      }])
    }
    demoStep.current += 1
  }

  const submit = () => {
    const v = input.trim()
    if (!v) return

    if (v.startsWith('/')) {
      const [cmd, ...rest] = v.slice(1).split(/\s+/)
      if (cmd === 'layout' && rest[0]) {
        const target = rest[0].toLowerCase() as TabId
        if (TABS.find((t) => t.id === target)) setTab(target)
      } else if (cmd === 'demo') {
        runDemo()
      } else if (cmd === 'approve') {
        changeMode('AUTO')
        setMessages((m) => [...m, {
          id: Date.now(), who: 'bee', name: 'Bee', time: nowHHMM(),
          body: '✓ aprobado · workers desbloqueados · continuando ciclo',
        }])
      } else if (cmd === 'reject') {
        setMessages((m) => [...m, {
          id: Date.now(), who: 'bee', name: 'Bee', time: nowHHMM(),
          body: `✗ rechazado · "${rest.join(' ') || 'sin razón'}" · enviado de vuelta a workers`,
        }])
      } else if (cmd === 'mode' && rest[0]) {
        changeMode(rest[0].toUpperCase() as import('./data/types').Mode)
      } else if (cmd === 'clear') {
        setMessages([])
      } else if (cmd === 'welcome') {
        setShowWelcome(true)
      }
      setInput('')
      return
    }

    const t = nowHHMM()
    setMessages((m) => [...m, { id: Date.now(), who: 'user', name: 'Tú', time: t, body: v }])
    setTab('focus')
    setInput('')

    if (connected) {
      // Send to real agents via WebSocket
      wsSubmit(v)
    } else {
      // Fallback: mock bee response when not connected to gateway
      setTimeout(() => {
        setMessages((m) => [...m, {
          id: Date.now(), who: 'bee', name: 'Bee', time: nowHHMM(),
          body: 'recibido · [sin conexión al gateway — modo demo] · dispatching workers …',
        }])
      }, 700)
    }
  }

  const layout = useMemo(() => {
    switch (tab) {
      case 'focus':     return <FocusLayout messages={messages} />
      case 'plan':      return <PlanLayout fileRisks={fileRisks} narrativeLines={narrativeLines} />
      case 'code':      return <CodeLayout workersState={workersState} />
      case 'review':    return <ReviewLayout adrs={adrs} />
      case 'dashboard': return <DashboardLayout workersState={workersState} />
      default:          return <FocusLayout messages={messages} />
    }
  }, [tab, messages, workersState, fileRisks, adrs, narrativeLines])

  return (
    <div className="app">
      {showWelcome && <WelcomeScreen onDismiss={() => setShowWelcome(false)} />}
      <Header
        mode={mode}
        runningCount={runningCount}
        tokens={tokens}
        cost={cost}
        clock={clock}
        onDemo={runDemo}
      />
      <TabBar active={tab} onChange={setTab} />
      <div className="content">{layout}</div>
      <CheckpointBar
        checkpoints={checkpoints}
        currentIdx={currentCp}
        selectedIdx={selectedCp}
        onSelect={setSelectedCp}
      />
      <ConflictBar conflict={conflict} />
      <BottomBar
        value={input}
        onChange={setInput}
        onSubmit={submit}
        mode={mode}
        hasConflict={!!conflict}
      />
    </div>
  )
}
