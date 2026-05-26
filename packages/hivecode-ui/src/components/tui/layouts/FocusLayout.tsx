import { useRef, useEffect } from 'react'
import type { Message } from '../../../data/types'
import { WORKERS } from '../../../data/mockData'

interface FocusLayoutProps {
  messages: Message[]
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <span>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`')
          ? <span key={i} className="inline-code">{p.slice(1, -1)}</span>
          : <span key={i}>{p}</span>
      )}
    </span>
  )
}

export function FocusLayout({ messages }: FocusLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div className="focus scroll" ref={scrollRef}>
      {messages.map((m) => {
        const w = WORKERS[m.who]
        const color = m.who === 'user' ? 'var(--user)' : w ? w.color : 'var(--text-main)'
        const glyph = m.who === 'user' ? '👤' : '⬡'
        return (
          <div className="msg" key={m.id}>
            <div className="msg-head">
              <span className="msg-author" style={{ color }}>
                <span className="hex-mark" style={{ color }}>{glyph}</span>
                {' '}{m.name}
              </span>
              <span className="msg-time">{m.time}</span>
            </div>
            <div className="msg-body">
              {m.body}
              {m.bullets && (
                <div style={{ marginTop: 6 }}>
                  {m.bullets.map((b, i) => (
                    <div key={i}>
                      <span className="bullet">  {i + 1}. </span>
                      <Inline text={b} />
                    </div>
                  ))}
                </div>
              )}
              {m.tail && (
                <div style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
                  {m.tail}
                </div>
              )}
            </div>
            {m.tool && <div className="msg-tool">{m.tool}</div>}
          </div>
        )
      })}
      <div className="sep-hex">⬡ ─── ⬡ ─── ⬡ ─── ⬡</div>
    </div>
  )
}
