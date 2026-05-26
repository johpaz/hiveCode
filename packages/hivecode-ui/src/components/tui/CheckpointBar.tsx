import type { Checkpoint } from '../../data/types'

interface CheckpointBarProps {
  checkpoints: Checkpoint[]
  currentIdx: number
  selectedIdx: number
  onSelect: (idx: number) => void
}

export function CheckpointBar({ checkpoints, currentIdx, selectedIdx, onSelect }: CheckpointBarProps) {
  return (
    <div className="checkpoint-bar">
      <span className="cp-label">⬡ CHECKPOINTS</span>
      {checkpoints.map((c, i) => {
        const isCurrent = i === currentIdx
        const isSelected = i === selectedIdx
        return (
          <button
            key={i}
            className={`cp ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}`}
            onClick={() => onSelect(isSelected ? -1 : i)}
            title={c.label}
          >
            [{c.time}{isCurrent ? ' ●' : isSelected ? ' ◀' : ''}]
          </button>
        )
      })}
      {selectedIdx >= 0 && (
        <button className="rollback-btn">↩ ROLLBACK to {checkpoints[selectedIdx].time}</button>
      )}
    </div>
  )
}
