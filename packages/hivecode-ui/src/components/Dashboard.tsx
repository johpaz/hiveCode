import { useEffect, useState } from 'react';
import { Activity, Cpu, DollarSign, Zap, Clock } from 'lucide-react';
import { hiveWs, type WsMessage } from '../lib/ws';

interface DashboardState {
  provider: string;
  model: string;
  mode: string;
  tokensIn: number;
  tokensOut: number;
  activeWorkers: string[];
  activeTask: string | null;
  taskPhases: { name: string; status: string }[];
  completedPhases: number;
  totalPhases: number;
  sessionStart: number;
}

const USD_PER_MTOK = 3;

function costUsd(tokensIn: number, tokensOut: number): string {
  return (((tokensIn + tokensOut) / 1_000_000) * USD_PER_MTOK).toFixed(4);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function elapsed(start: number): string {
  const s = Math.floor((Date.now() - start) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#6fcf97',
  running: '#f2994a',
  failed: '#eb5757',
  pending: '#4f4f6f',
  idle: '#4f4f6f',
};

export default function Dashboard() {
  const [state, setState] = useState<DashboardState>({
    provider: '—',
    model: '—',
    mode: 'auto',
    tokensIn: 0,
    tokensOut: 0,
    activeWorkers: [],
    activeTask: null,
    taskPhases: [],
    completedPhases: 0,
    totalPhases: 0,
    sessionStart: Date.now(),
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsub = hiveWs.onMessage((msg: WsMessage) => {
      if (msg.type === 'phase_start') {
        const coordinator = (msg.data?.coordinator as string) ?? '';
        setState(s => ({
          ...s,
          activeWorkers: [...new Set([...s.activeWorkers, coordinator])],
          activeTask: (msg.data?.taskId as string) ?? s.activeTask,
        }));
      } else if (msg.type === 'phase_end') {
        const coordinator = (msg.data?.coordinator as string) ?? '';
        setState(s => ({
          ...s,
          activeWorkers: s.activeWorkers.filter(w => w !== coordinator),
          completedPhases: s.completedPhases + 1,
        }));
      } else if (msg.type === 'task_end') {
        setState(s => ({ ...s, activeWorkers: [], activeTask: null, taskPhases: [], completedPhases: 0 }));
      } else if (msg.type === 'tool_start' || msg.type === 'tool_end') {
        const ti = (msg.data?.tokensIn as number) ?? 0;
        const to_ = (msg.data?.tokensOut as number) ?? 0;
        if (ti || to_) setState(s => ({ ...s, tokensIn: s.tokensIn + ti, tokensOut: s.tokensOut + to_ }));
      } else if (msg.status) {
        setState(s => ({
          ...s,
          provider: msg.status?.channel ?? s.provider,
          model: msg.status?.model ?? s.model,
          mode: msg.status?.state ?? s.mode,
        }));
      }
    });
    return unsub;
  }, []);

  const cost = costUsd(state.tokensIn, state.tokensOut);
  const totalTokens = state.tokensIn + state.tokensOut;

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', color: '#e0e0e0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '18px', color: '#f0f0f0' }}>Dashboard</h2>
        <span style={{ fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Clock size={12} /> Sesión: {elapsed(state.sessionStart)}
        </span>
      </div>

      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
        <MetricCard icon={<Zap size={16} color="#f2c94c" />} label="Provider" value={state.provider} sub={state.model} />
        <MetricCard icon={<Activity size={16} color="#56ccf2" />} label="Modo" value={state.mode.toUpperCase()} />
        <MetricCard
          icon={<Cpu size={16} color="#6fcf97" />}
          label="Tokens"
          value={formatTokens(totalTokens)}
          sub={`↑${formatTokens(state.tokensIn)} ↓${formatTokens(state.tokensOut)}`}
        />
        <MetricCard icon={<DollarSign size={16} color="#bb6bd9" />} label="Costo" value={`$${cost}`} sub="USD estimado" />
      </div>

      {/* Active workers */}
      <div style={{ background: '#1a1a2e', borderRadius: '8px', padding: '16px' }}>
        <div style={{ fontSize: '12px', color: '#888', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Workers activos ({state.activeWorkers.length})
        </div>
        {state.activeWorkers.length === 0 ? (
          <div style={{ fontSize: '13px', color: '#555' }}>💤 Ninguno</div>
        ) : (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {state.activeWorkers.map(w => (
              <span key={w} style={{
                background: '#0d2137',
                border: '1px solid #f2994a44',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '12px',
                color: '#f2994a',
              }}>
                ⚙ {w}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Active task */}
      {state.activeTask && (
        <div style={{ background: '#1a1a2e', borderRadius: '8px', padding: '16px' }}>
          <div style={{ fontSize: '12px', color: '#888', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Tarea activa
          </div>
          <div style={{ fontSize: '13px', color: '#aaa', fontFamily: 'monospace', marginBottom: '10px' }}>
            {state.activeTask.slice(0, 16)}…
          </div>
          {state.totalPhases > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                <span>Progreso</span>
                <span>{state.completedPhases}/{state.totalPhases}</span>
              </div>
              <div style={{ background: '#0d0d1a', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                <div style={{
                  width: `${(state.completedPhases / state.totalPhases) * 100}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #56ccf2, #6fcf97)',
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: '#1a1a2e', borderRadius: '8px', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', color: '#888', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: '#f0f0f0' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>{sub}</div>}
    </div>
  );
}
