import type { TabId } from '../../data/types'

const TABS: { id: TabId; label: string; num: string }[] = [
  { id: 'focus',     label: 'FOCUS',     num: '1' },
  { id: 'plan',      label: 'PLAN',      num: '2' },
  { id: 'code',      label: 'CODE',      num: '3' },
  { id: 'review',    label: 'REVIEW',    num: '4' },
  { id: 'dashboard', label: 'DASHBOARD', num: '5' },
]

interface TabBarProps {
  active: TabId
  onChange: (id: TabId) => void
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <div className="tabbar">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={`tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          <span className="hex">⬡</span>
          <span>{t.label}</span>
          <span className="tab-num">[{t.num}]</span>
        </button>
      ))}
      <span className="tab-spacer"></span>
      <span className="tab-hint">/layout {TABS.map(t => t.id).join(' | ')}</span>
    </div>
  )
}

export { TABS }
