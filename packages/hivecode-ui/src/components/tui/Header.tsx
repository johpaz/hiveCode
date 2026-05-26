import type { Mode } from '../../data/types'
import { BunLogo } from './BunLogo'

interface HeaderProps {
  mode: Mode
  runningCount: number
  tokens: string
  cost: string
  clock: string
  onDemo: () => void
}

export function Header({ mode, runningCount, tokens, cost, clock, onDemo }: HeaderProps) {
  const modeCls = mode === 'AUTO' ? 'mode-auto' : mode === 'APPROVAL' ? 'mode-approval' : 'mode-plan'
  return (
    <div className="header">
      <span className="logo">⬡ hiveCode</span>
      <span className="dot">·</span>
      <span className="meta">anthropic</span>
      <span className="meta">·</span>
      <span className="meta">claude-sonnet-4.6</span>
      <span className="dot">·</span>
      <span className="meta runtime-badge" title="Bun runtime">
        <BunLogo size={13} />
        <span>bun</span>
      </span>
      <span className="dot">·</span>
      <span className={`mode-badge ${modeCls}`}>[{mode}]</span>
      <span className="dot">·</span>
      <span className="meta">⬡{runningCount}</span>
      <span className="dot">·</span>
      <span className="meta">tokens:{tokens}</span>
      <span className="dot">·</span>
      <span className="meta">{cost}</span>
      <span className="dot">·</span>
      <span className="live-dot">●</span>
      <span className="meta">{clock}</span>
      <span className="spacer"></span>
      <button className="demo-btn" onClick={onDemo} title="Simula eventos llegando">
        ▶ DEMO
      </button>
    </div>
  )
}
