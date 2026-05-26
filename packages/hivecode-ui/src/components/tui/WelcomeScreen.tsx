import { useEffect } from 'react'
import { BeeMascot } from './BeeMascot'
import { BunLogo } from './BunLogo'

interface WelcomeScreenProps {
  onDismiss: () => void
}

const BOOT_LINES = [
  { k: 'load',   t: 'cargando 13 agents · L0 bee · L1 product/arch · L2 engineers · L3 quality · L4 reviewer · L5 on-demand' },
  { k: 'sqlite', t: 'sqlite + FTS5 · .hivecode/state.db · WAL mode (~0.6ms)' },
  { k: 'memory', t: 'agent_memory · 47 patterns · 14 ADRs · 3 forensic_lessons cargados' },
  { k: 'ready',  t: 'listo · ⬡ press [enter] to enter' },
]

export function WelcomeScreen({ onDismiss }: WelcomeScreenProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
        e.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div className="welcome-overlay" onClick={onDismiss}>
      <div className="welcome-inner" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-left">
          <BeeMascot scale={1} />
        </div>
        <div className="welcome-right">
          <div className="welcome-title">
            <span className="ttl-name">hivecode</span>
            <span className="ttl-ver">v1.0.0</span>
          </div>
          <div className="welcome-tag">Gateway de agentes de código</div>
          <div className="welcome-sub">
            local-first · <BunLogo size={18} /> Bun runtime · sqlite + FTS5
          </div>
          <div className="welcome-author">@johpaz</div>

          <div className="welcome-rule">⬡ ──────────────────────── ⬡</div>

          <div className="welcome-boot">
            {BOOT_LINES.map((l, i) => (
              <div
                key={l.k}
                className="boot-line"
                style={{ animationDelay: 0.25 + i * 0.32 + 's' }}
              >
                <span className="boot-tag">[{l.k.padEnd(5)}]</span>
                <span className="boot-text">{l.t}</span>
                {i < BOOT_LINES.length - 1
                  ? <span className="boot-ok">OK</span>
                  : <span className="boot-cursor">▌</span>}
              </div>
            ))}
          </div>

          <div className="welcome-hints">
            <div><span className="key">enter</span> entrar</div>
            <div><span className="key">/welcome</span> volver a esta pantalla</div>
            <div><span className="key">/layout focus|plan|code|review|dashboard</span> cambiar vista</div>
          </div>
        </div>
      </div>
    </div>
  )
}
