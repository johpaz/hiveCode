export interface Phase {
  name: string;
  coordinator: string;
  status: 'idle' | 'thinking' | 'completed' | 'error' | 'blocked';
  durationMs?: number;
}

interface PhaseTimelineProps {
  phases: Phase[];
}

const COORDINATOR_CONFIG: Record<string, { color: string; glow: string; label: string }> = {
  bee: { color: 'var(--color-bee)', glow: 'rgba(240,160,48,0.15)', label: 'BEE' },
  architecture: { color: 'var(--color-arch)', glow: 'rgba(168,85,247,0.15)', label: 'ARCH' },
  backend: { color: 'var(--color-backend)', glow: 'rgba(59,130,246,0.15)', label: 'BACK' },
  frontend: { color: 'var(--color-frontend)', glow: 'rgba(34,197,94,0.15)', label: 'FRONT' },
  security: { color: 'var(--color-security)', glow: 'rgba(239,68,68,0.15)', label: 'SEC' },
  test: { color: 'var(--color-test)', glow: 'rgba(251,191,36,0.15)', label: 'TEST' },
  devops: { color: 'var(--color-devops)', glow: 'rgba(156,163,175,0.15)', label: 'OPS' },
};

const STATUS_CONFIG: Record<string, { icon: string; pulse: boolean }> = {
  idle: { icon: '○', pulse: false },
  thinking: { icon: '◉', pulse: true },
  completed: { icon: '⬢', pulse: false },
  error: { icon: '✕', pulse: false },
  blocked: { icon: '⊘', pulse: false },
};

export default function PhaseTimeline({ phases }: PhaseTimelineProps) {
  return (
    <div className="flex flex-col h-full relative z-10">
      <div className="absolute inset-0 glass-panel border-r border-white/[0.06]" />

      <div className="relative px-4 py-3 border-b border-white/[0.06]">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
          Swarm Timeline
        </span>
      </div>

      <div className="relative flex-1 overflow-y-auto py-3 space-y-1">
        {/* Vertical connector line */}
        <div className="absolute left-[22px] top-3 bottom-3 w-px bg-white/5" />

        {phases.map((phase, i) => {
          const config = COORDINATOR_CONFIG[phase.coordinator] || COORDINATOR_CONFIG.devops;
          const status = STATUS_CONFIG[phase.status];
          const isActive = phase.status === 'thinking';

          return (
            <div
              key={i}
              className={`relative flex items-center gap-3 px-3 py-2 mx-2 rounded-lg
                transition-all duration-300 cursor-default group
                ${isActive ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}
              style={isActive ? { boxShadow: `inset 0 0 20px ${config.glow}` } : undefined}
            >
              {/* Status dot */}
              <div className="relative z-10 flex items-center justify-center w-5 h-5 shrink-0">
                <span
                  className={`text-sm font-mono ${status.pulse ? 'animate-pulse' : ''}`}
                  style={{ color: config.color }}
                >
                  {status.icon}
                </span>
              </div>

              {/* Content */}
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: config.color }}
                  >
                    {config.label}
                  </span>
                  {phase.durationMs && phase.status === 'completed' && (
                    <span className="ml-auto text-[9px] text-neutral-600 font-mono">
                      {(phase.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-neutral-500 truncate group-hover:text-neutral-400 transition-colors">
                  {phase.name}
                </span>
              </div>

              {/* Active glow bar */}
              {isActive && (
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-full animate-pulse-glow"
                  style={{ backgroundColor: config.color }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
