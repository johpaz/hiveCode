import type { Conflict } from '../../data/types'
import { WORKERS } from '../../data/mockData'

interface ConflictBarProps {
  conflict: Conflict | null
}

export function ConflictBar({ conflict }: ConflictBarProps) {
  if (!conflict) return null
  const a = WORKERS[conflict.a]
  const b = WORKERS[conflict.b]
  return (
    <div className="conflict-bar">
      <span className="warn">⚠</span>
      <span className="who" style={{ color: a.color }}>{conflict.a}</span>
      <span style={{ color: 'var(--text-secondary)' }}>↔</span>
      <span className="who" style={{ color: b.color }}>{conflict.b}</span>
      <span style={{ color: 'var(--text-secondary)' }}>·</span>
      <span className="path" style={{ color: 'var(--text-main)' }}>{conflict.file}</span>
      <span style={{ color: 'var(--text-secondary)' }}>·</span>
      <span className="detail" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{conflict.detail}</span>
      <span className="tag">[{conflict.level}]</span>
    </div>
  )
}
