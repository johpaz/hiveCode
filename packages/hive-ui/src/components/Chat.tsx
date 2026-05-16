import { useRef, useEffect } from 'react';
import { User, Bot, Terminal, AlertCircle, Sparkles } from 'lucide-react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'shell';
  content: string;
  timestamp?: string;
}

interface ChatProps {
  messages: ChatMessage[];
}

const ROLE_CONFIG = {
  user: {
    icon: User,
    label: 'You',
    gradient: 'from-neutral-700/30 to-neutral-800/30',
    border: 'border-white/5',
    accent: 'text-neutral-300',
    glow: '',
  },
  assistant: {
    icon: Bot,
    label: 'BEE',
    gradient: 'from-amber-900/20 to-orange-900/20',
    border: 'border-amber-500/15',
    accent: 'text-amber-400',
    glow: 'shadow-[0_0_20px_rgba(240,160,48,0.08)]',
  },
  system: {
    icon: AlertCircle,
    label: 'System',
    gradient: 'from-red-900/20 to-rose-900/20',
    border: 'border-red-500/15',
    accent: 'text-red-400',
    glow: 'shadow-[0_0_20px_rgba(239,68,68,0.08)]',
  },
  shell: {
    icon: Terminal,
    label: 'Shell',
    gradient: 'from-emerald-900/20 to-green-900/20',
    border: 'border-emerald-500/15',
    accent: 'text-emerald-400',
    glow: 'shadow-[0_0_20px_rgba(34,197,94,0.08)]',
  },
};

function formatContent(content: string): string {
  return content
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '');
}

function parseCoordinatorFromContent(content: string): { coordinator: string; cleanContent: string } {
  const match = content.match(/^\[([^\]]+)\]\s*/);
  if (match) {
    return { coordinator: match[1], cleanContent: content.slice(match[0].length) };
  }
  return { coordinator: '', cleanContent: content };
}

export default function Chat({ messages }: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div ref={containerRef} className="flex flex-col gap-4 p-5 overflow-y-auto h-full relative">
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full gap-5">
          <div className="relative">
            <div className="absolute inset-0 blur-2xl bg-amber-500/20 rounded-full scale-150" />
            <span className="relative text-5xl animate-float">🐝</span>
          </div>
          <div className="text-center space-y-2">
            <h2 className="font-display text-xl font-semibold text-neutral-200 tracking-tight">
              Hive Terminal
            </h2>
            <p className="text-sm text-neutral-500 max-w-[280px]">
              The swarm is ready. Type a command or describe what you want to build.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-neutral-600 uppercase tracking-[0.2em]">
            <Sparkles size={10} />
            <span>Connected to gateway</span>
          </div>
        </div>
      )}

      {messages.map((msg, idx) => {
        const config = ROLE_CONFIG[msg.role];
        const Icon = config.icon;
        const isConsecutive = idx > 0 && messages[idx - 1].role === msg.role;
        const { coordinator, cleanContent } = msg.role === 'assistant'
          ? parseCoordinatorFromContent(msg.content)
          : { coordinator: '', cleanContent: msg.content };

        return (
          <div
            key={msg.id}
            className={`flex gap-3 animate-slide-in ${isConsecutive ? 'mt-1' : 'mt-2'}`}
          >
            {/* Avatar */}
            {!isConsecutive && (
              <div className="flex flex-col items-center gap-1 shrink-0 mt-0.5">
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center
                    bg-gradient-to-br ${config.gradient} ${config.border} border`}
                >
                  <Icon size={13} className={config.accent} />
                </div>
              </div>
            )}
            {isConsecutive && <div className="w-7 shrink-0" />}

            {/* Message */}
            <div className="flex-1 min-w-0">
              {!isConsecutive && (
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`text-[10px] font-bold uppercase tracking-[0.12em] ${config.accent}`}>
                    {coordinator || config.label}
                  </span>
                  {msg.timestamp && (
                    <span className="text-[9px] text-neutral-700 font-mono">
                      {new Date(msg.timestamp).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                      })}
                    </span>
                  )}
                </div>
              )}

              <div
                className={`relative rounded-xl px-4 py-3 border backdrop-blur-sm
                  bg-gradient-to-br ${config.gradient} ${config.border} ${config.glow}`}
              >
                <div className="whitespace-pre-wrap break-words leading-relaxed font-mono text-[12px] text-neutral-300">
                  {formatContent(cleanContent)}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} className="h-2 shrink-0" />
    </div>
  );
}
