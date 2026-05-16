import { Activity, Cpu, Users, Zap } from 'lucide-react';

interface HeaderProps {
  mode: string;
  provider: string;
  model: string;
  taskCount: number;
  tokenCount: string;
  agentCount: number;
  activeCoordinator: string;
}

const MODE_STYLES: Record<string, { label: string; gradient: string; glow: string }> = {
  plan: {
    label: 'PLAN',
    gradient: 'from-violet-500/20 to-purple-500/20',
    glow: 'shadow-violet-500/20',
  },
  approval: {
    label: 'APPROVAL',
    gradient: 'from-amber-500/20 to-orange-500/20',
    glow: 'shadow-amber-500/20',
  },
  auto: {
    label: 'AUTO',
    gradient: 'from-emerald-500/20 to-green-500/20',
    glow: 'shadow-emerald-500/20',
  },
};

const COORDINATOR_GLOW: Record<string, string> = {
  bee: 'text-[var(--color-bee)] drop-shadow-[0_0_8px_rgba(240,160,48,0.5)]',
  architecture: 'text-[var(--color-arch)] drop-shadow-[0_0_8px_rgba(168,85,247,0.5)]',
  backend: 'text-[var(--color-backend)] drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]',
  frontend: 'text-[var(--color-frontend)] drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]',
  security: 'text-[var(--color-security)] drop-shadow-[0_0_8px_rgba(239,68,68,0.5)]',
  test: 'text-[var(--color-test)] drop-shadow-[0_0_8px_rgba(251,191,36,0.5)]',
  devops: 'text-[var(--color-devops)] drop-shadow-[0_0_8px_rgba(156,163,175,0.5)]',
};

export default function Header({ mode, provider, model, taskCount, tokenCount, agentCount, activeCoordinator }: HeaderProps) {
  const modeStyle = MODE_STYLES[mode] || MODE_STYLES.plan;
  const activeGlow = COORDINATOR_GLOW[activeCoordinator] || '';

  return (
    <header className="h-14 shrink-0 relative z-10">
      <div className="absolute inset-0 glass-panel border-b border-white/[0.06]" />
      <div className={`absolute inset-0 bg-gradient-to-r ${modeStyle.gradient} opacity-50 pointer-events-none`} />

      <div className="relative h-full flex items-center px-5 gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <span className="text-xl">🐝</span>
            <div className="absolute inset-0 blur-md bg-amber-500/30 rounded-full" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="font-display font-bold text-sm tracking-tight text-neutral-100">
              hivecode
            </span>
            <span className="text-[9px] text-neutral-500 font-medium tracking-[0.2em] uppercase">
              Terminal
            </span>
          </div>
        </div>

        <div className="h-6 w-px bg-white/10" />

        {/* Mode Badge */}
        <div
          className={`px-2.5 py-1 rounded-md text-[10px] font-bold tracking-[0.15em] uppercase
            bg-white/5 border border-white/10 backdrop-blur-sm
            ${activeCoordinator ? modeStyle.glow : ''}`}
        >
          {modeStyle.label}
        </div>

        {/* Provider / Model */}
        <div className="flex items-center gap-2 text-[11px] text-neutral-400">
          <Cpu size={12} className="text-neutral-500" />
          <span className="truncate max-w-[100px] font-medium">{provider}</span>
          <span className="text-neutral-700">/</span>
          <span className="truncate max-w-[140px] text-neutral-300">{model}</span>
        </div>

        <div className="flex-1" />

        {/* Stats */}
        <div className="flex items-center gap-5 text-[11px]">
          <div className="flex items-center gap-1.5 text-neutral-400">
            <Zap size={11} className="text-amber-500/70" />
            <span className="font-mono tabular-nums">{taskCount}</span>
            <span className="text-neutral-600">tasks</span>
          </div>
          <div className="flex items-center gap-1.5 text-neutral-400">
            <Activity size={11} className="text-emerald-500/70" />
            <span className="font-mono tabular-nums">{tokenCount}</span>
            <span className="text-neutral-600">tok</span>
          </div>
          <div className="flex items-center gap-1.5 text-neutral-400">
            <Users size={11} className="text-violet-500/70" />
            <span className="font-mono tabular-nums">{agentCount}</span>
            <span className="text-neutral-600">agents</span>
          </div>

          {activeCoordinator && (
            <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider ${activeGlow}`}>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-current" />
              </span>
              {activeCoordinator}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
