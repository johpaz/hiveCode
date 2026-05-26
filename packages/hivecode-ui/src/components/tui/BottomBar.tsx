import { useState, useEffect } from 'react'
import type { Mode } from '../../data/types'

interface BottomBarProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  mode: Mode
  hasConflict: boolean
}

function Mascot() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 8), 200)
    return () => clearInterval(id)
  }, [])
  const dy = [0, -1, -2, -1, 0, -1, -2, -1][frame]
  const rot = [0, -3, 0, 3, 0, -2, 0, 2][frame]
  return (
    <span
      className="mascot"
      style={{
        transform: `translateY(${dy}px) rotate(${rot}deg)`,
        transition: 'transform 0.18s ease-in-out',
      }}
      aria-label="bee"
    >
      🐝
    </span>
  )
}

export function BottomBar({ value, onChange, onSubmit, mode, hasConflict }: BottomBarProps) {
  const modeCls = mode === 'AUTO' ? 'mode-auto' : mode === 'APPROVAL' ? 'mode-approval' : 'mode-plan'
  return (
    <form
      className="bottom-bar"
      onSubmit={(e) => { e.preventDefault(); onSubmit() }}
    >
      <Mascot />
      <span className="prompt">⬡</span>
      <div className="input-wrap">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="escribe un mensaje o /comando · prueba /layout plan, /approve, /demo"
        />
      </div>
      <span className={`mode-badge ${modeCls}`}>[{mode}]</span>
      <span
        className={`stop ${hasConflict ? 'armed' : ''}`}
        title={hasConflict ? 'conflicto crítico activo' : 'sin conflictos'}
      >
        ⛔
      </span>
    </form>
  )
}
