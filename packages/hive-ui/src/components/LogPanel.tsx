import { useState } from 'react';
import { Filter, X, Terminal } from 'lucide-react';

export interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
}

interface LogPanelProps {
  logs: LogEntry[];
  onClose?: () => void;
}

const LEVEL_CONFIG: Record<string, { color: string; bg: string; glow: string }> = {
  debug: { color: '#22d3ee', bg: 'rgba(34,211,238,0.08)', glow: 'rgba(34,211,238,0.2)' },
  info: { color: '#4ade80', bg: 'rgba(74,222,128,0.08)', glow: 'rgba(74,222,128,0.2)' },
  warn: { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', glow: 'rgba(251,191,36,0.2)' },
  error: { color: '#f87171', bg: 'rgba(248,113,113,0.08)', glow: 'rgba(248,113,113,0.2)' },
};

export default function LogPanel({ logs, onClose }: LogPanelProps) {
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<string | null>(null);

  const filtered = logs.filter((log) => {
    const matchesText = !filter ||
      log.message.toLowerCase().includes(filter.toLowerCase()) ||
      log.source.toLowerCase().includes(filter.toLowerCase());
    const matchesLevel = !levelFilter || log.level.toLowerCase() === levelFilter;
    return matchesText && matchesLevel;
  });

  const levels = ['debug', 'info', 'warn', 'error'];

  return (
    <div className="flex flex-col h-full relative z-10">
      <div className="absolute inset-0 glass-panel border-l border-white/[0.06]" />

      <div className="relative flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Terminal size={12} className="text-neutral-500" />
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-400">
            System Logs
          </span>
          <span className="text-[9px] text-neutral-600 font-mono">{filtered.length}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 transition-colors">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="relative flex gap-2 px-4 py-2 border-b border-white/[0.06]">
        <div className="relative flex-1">
          <Filter size={10} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600" />
          <input
            type="text"
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-white/[0.03] border border-white/[0.06] rounded-md
              pl-7 pr-3 py-1.5 text-[11px] text-neutral-300 placeholder-neutral-600
              focus:outline-none focus:border-amber-500/30 focus:bg-white/[0.05]
              transition-all"
          />
        </div>
      </div>

      <div className="relative flex gap-1 px-4 py-2 border-b border-white/[0.06]">
        {levels.map((lvl) => {
          const cfg = LEVEL_CONFIG[lvl];
          const isActive = levelFilter === lvl;
          return (
            <button
              key={lvl}
              onClick={() => setLevelFilter(isActive ? null : lvl)}
              className={`px-2 py-1 rounded-md text-[9px] uppercase tracking-[0.15em] font-bold
                transition-all duration-200 border
                ${isActive ? 'border-white/10' : 'border-transparent hover:border-white/5'}`}
              style={{
                color: isActive ? cfg.color : '#525252',
                backgroundColor: isActive ? cfg.bg : 'transparent',
                boxShadow: isActive ? `0 0 12px ${cfg.glow}` : 'none',
              }}
            >
              {lvl}
            </button>
          );
        })}
      </div>

      <div className="relative flex-1 overflow-y-auto p-3 space-y-0.5 font-mono text-[10px]">
        {filtered.slice(-200).map((log, i) => {
          const cfg = LEVEL_CONFIG[log.level.toLowerCase()] || LEVEL_CONFIG.info;
          return (
            <div
              key={i}
              className="flex gap-2 rounded-md px-2 py-1 hover:bg-white/[0.03] transition-colors group"
            >
              <span className="text-neutral-700 shrink-0 font-mono">
                {log.timestamp?.split('T')[1]?.slice(0, 8) || '--:--:--'}
              </span>
              <span
                className="uppercase shrink-0 w-8 font-bold text-[9px] tracking-wider"
                style={{ color: cfg.color }}
              >
                {log.level.slice(0, 4)}
              </span>
              <span className="text-neutral-600 shrink-0 w-20 truncate group-hover:text-neutral-500 transition-colors">
                {log.source}
              </span>
              <span className="text-neutral-400 break-all leading-relaxed">
                {log.message}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
