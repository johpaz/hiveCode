import { useState, useEffect, useCallback, useRef } from 'react';
import { PanelLeft, PanelRight, MessageSquare, GitBranch, Send } from 'lucide-react';
import Header from './components/Header';
import Chat, { type ChatMessage } from './components/Chat';
import LogPanel, { type LogEntry } from './components/LogPanel';
import PhaseTimeline, { type Phase } from './components/PhaseTimeline';
import Mascot from './components/Mascot';
import FlowCanvas, { type FlowPhase } from './components/FlowCanvas';
import HexGridBackground from './components/HexGridBackground';
import FloatingParticles from './components/FloatingParticles';
import { hiveWs, type WsMessage } from './lib/ws';

type ViewMode = 'chat' | 'flow';

const DEFAULT_PHASES: Phase[] = [
  { name: 'Analyze & Route', coordinator: 'bee', status: 'idle' },
  { name: 'Architecture Design', coordinator: 'architecture', status: 'idle' },
  { name: 'Backend Implementation', coordinator: 'backend', status: 'idle' },
  { name: 'Frontend Implementation', coordinator: 'frontend', status: 'idle' },
  { name: 'Security Audit', coordinator: 'security', status: 'idle' },
  { name: 'Testing', coordinator: 'test', status: 'idle' },
  { name: 'DevOps Deploy', coordinator: 'devops', status: 'idle' },
];

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [showLogs, setShowLogs] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phases, setPhases] = useState<Phase[]>(DEFAULT_PHASES);
  const [flowPhases, setFlowPhases] = useState<FlowPhase[]>([]);
  const [headerState, setHeaderState] = useState({
    mode: 'plan',
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    taskCount: 0,
    tokenCount: '0',
    agentCount: 7,
    activeCoordinator: '',
  });
  const [inputValue, setInputValue] = useState('');
  const msgIdRef = useRef(0);
  const logsRef = useRef<LogEntry[]>([]);

  const addMessage = useCallback((role: ChatMessage['role'], content: string) => {
    msgIdRef.current += 1;
    setMessages((prev) => [...prev, {
      id: `${Date.now()}-${msgIdRef.current}`,
      role,
      content,
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  const addLog = useCallback((entry: LogEntry) => {
    logsRef.current = [...logsRef.current.slice(-499), entry];
    setLogs(logsRef.current);
  }, []);

  const sendMessage = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    addMessage('user', text);
    hiveWs.send({ type: 'message', content: text });
    setInputValue('');
  }, [inputValue, addMessage]);

  useEffect(() => {
    hiveWs.connect();
    hiveWs.subscribeLogs();

    const unsubscribe = hiveWs.onMessage((msg: WsMessage) => {
      if (msg.type === 'log' && msg.logEntry) {
        addLog(msg.logEntry);
        return;
      }

      if (msg.type === 'narrative' && msg.data) {
        const data = msg.data as { coordinator?: string; phase?: string; content?: string };
        if (data.content) {
          addMessage('assistant', `[${data.coordinator || 'agent'}] ${data.content}`);
        }
        return;
      }

      if (msg.type === 'phase' && msg.data) {
        const data = msg.data as { name?: string; coordinator?: string; status?: string; durationMs?: number };
        setPhases((prev) =>
          prev.map((p) =>
            p.coordinator === data.coordinator
              ? { ...p, status: (data.status as Phase['status']) || p.status, durationMs: data.durationMs }
              : p
          )
        );
        setFlowPhases((prev) => {
          const existing = prev.find((p) => p.coordinator === data.coordinator);
          if (existing) {
            return prev.map((p) =>
              p.coordinator === data.coordinator
                ? { ...p, status: (data.status as FlowPhase['status']) || p.status }
                : p
            );
          }
          return [...prev, {
            id: data.coordinator || `phase-${Date.now()}`,
            coordinator: data.coordinator || 'unknown',
            status: (data.status as FlowPhase['status']) || 'idle',
            label: data.name || data.coordinator || 'unknown',
          }];
        });
        if (data.status === 'thinking') {
          setHeaderState((prev) => ({ ...prev, activeCoordinator: data.coordinator || '' }));
        }
        return;
      }

      if (msg.type === 'mode' && msg.data) {
        const data = msg.data as { mode?: string };
        if (data.mode) {
          setHeaderState((prev) => ({ ...prev, mode: data.mode || prev.mode }));
        }
        return;
      }

      if (msg.type === 'status' && msg.status) {
        if (msg.status.model) {
          const parts = msg.status.model.split('/');
          setHeaderState((prev) => ({
            ...prev,
            provider: parts[0] || prev.provider,
            model: parts.slice(1).join('/') || prev.model,
          }));
        }
        return;
      }
    });

    return () => {
      unsubscribe();
      hiveWs.disconnect();
    };
  }, [addMessage, addLog]);

  return (
    <div className="flex flex-col h-screen text-neutral-100 overflow-hidden relative">
      {/* Atmospheric layers */}
      <HexGridBackground />
      <FloatingParticles />

      {/* Background base */}
      <div className="fixed inset-0 bg-[var(--color-surface)] -z-10" />

      {/* Main UI */}
      <div className="relative z-10 flex flex-col h-full">
        <Header {...headerState} />

        <div className="flex flex-1 overflow-hidden">
          {/* Left: Timeline */}
          {showTimeline && (
            <div className="w-60 shrink-0">
              <PhaseTimeline phases={phases} />
            </div>
          )}

          {/* Center: Chat or Flow */}
          <div className="flex flex-col flex-1 min-w-0 relative">
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-4 py-2 border-b border-white/[0.06] relative">
              <div className="absolute inset-0 glass-panel opacity-50" />
              <div className="relative flex items-center gap-1">
                <button
                  onClick={() => setViewMode('chat')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium
                    transition-all duration-200 border
                    ${viewMode === 'chat'
                      ? 'bg-white/[0.06] border-white/10 text-neutral-200 shadow-[0_0_12px_rgba(240,160,48,0.08)]'
                      : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.03]'
                    }`}
                >
                  <MessageSquare size={12} />
                  Chat
                </button>
                <button
                  onClick={() => setViewMode('flow')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium
                    transition-all duration-200 border
                    ${viewMode === 'flow'
                      ? 'bg-white/[0.06] border-white/10 text-neutral-200 shadow-[0_0_12px_rgba(240,160,48,0.08)]'
                      : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.03]'
                    }`}
                >
                  <GitBranch size={12} />
                  Flow
                </button>
              </div>

              <div className="flex-1" />

              <div className="relative flex items-center gap-1">
                <button
                  onClick={() => setShowTimeline(!showTimeline)}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors p-1.5
                    rounded-lg hover:bg-white/[0.03]"
                  title="Toggle timeline"
                >
                  <PanelLeft size={14} />
                </button>
                <button
                  onClick={() => setShowLogs(!showLogs)}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors p-1.5
                    rounded-lg hover:bg-white/[0.03]"
                  title="Toggle logs"
                >
                  <PanelRight size={14} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
              {viewMode === 'chat' ? (
                <Chat messages={messages} />
              ) : (
                <FlowCanvas phases={flowPhases.length > 0 ? flowPhases : phases.map((p) => ({
                  id: p.coordinator,
                  coordinator: p.coordinator,
                  status: p.status,
                  label: p.name,
                }))} />
              )}
            </div>

            {/* Chat Input */}
            {viewMode === 'chat' && (
              <div className="shrink-0 px-4 py-3 border-t border-white/[0.06] relative">
                <div className="absolute inset-0 glass-panel opacity-50" />
                <div className="relative flex items-center gap-2">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Describe what you want to build..."
                    className="flex-1 bg-white/[0.03] border border-white/[0.06] rounded-xl
                      px-4 py-2.5 text-[13px] text-neutral-200 placeholder-neutral-600
                      focus:outline-none focus:border-amber-500/30 focus:bg-white/[0.05]
                      transition-all"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!inputValue.trim()}
                    className="flex items-center justify-center w-9 h-9 rounded-xl
                      bg-amber-500/10 border border-amber-500/20
                      text-amber-400 hover:bg-amber-500/20 hover:text-amber-300
                      disabled:opacity-30 disabled:cursor-not-allowed
                      transition-all"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right: Logs + Mascot */}
          {showLogs && (
            <div className="w-80 shrink-0 flex flex-col">
              <Mascot
                coordinator={headerState.activeCoordinator || 'bee'}
                status={headerState.activeCoordinator ? 'thinking' : 'idle'}
              />
              <div className="flex-1 min-h-0">
                <LogPanel logs={logs} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
