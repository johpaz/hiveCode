import { WORKERS } from '../../../data/mockData'
import type { WorkerStatus } from '../../../data/types'

export function CodeLayout({ workersState }: { workersState: WorkerStatus[] }) {
  const activeWorkers = workersState.filter((w) => w.state !== 'idle')
  const idleCount = workersState.length - activeWorkers.length

  return (
    <div className="split">
      <div className="pane pane-left">
        <div className="diff-head">
          <span>⬡</span>
          <span className="path">sin diff activo</span>
          <span className="dim">· esperando actividad de workers</span>
        </div>
        <div className="diff scroll" style={{ color: 'var(--text-disabled)', padding: '18px 12px', fontSize: 12, letterSpacing: 0.5 }}>
          ⬡ ─── el diff aparecerá cuando un worker edite un archivo ─── ⬡
        </div>
      </div>

      <div className="pane pane-right">
        <div className="panel-title">
          <span className="hex">⬡</span> WORKERS · estado live
        </div>
        <div className="workers scroll">
          {activeWorkers.length === 0 ? (
            <div style={{ color: 'var(--text-disabled)', fontSize: 11, padding: '8px 6px' }}>
              ⬡ todos los workers en standby
            </div>
          ) : (
            activeWorkers.map((w) => {
              const wm = WORKERS[w.id]
              if (!wm) return null
              return (
                <div
                  key={w.id}
                  className={`worker-row ${w.active ? 'active' : ''}`}
                  style={{ '--w-color': wm.color } as React.CSSProperties}
                >
                  <div className="name">
                    <span>⬡</span>
                    <span>{wm.label}</span>
                  </div>
                  <div className={`state ${w.state}`}>{w.state}</div>
                  <div className="action">{w.action}</div>
                </div>
              )
            })
          )}
          {idleCount > 0 && (
            <div style={{ color: 'var(--text-disabled)', fontSize: 10.5, letterSpacing: 1.2, padding: '4px 6px 2px' }}>
              ⬡ ─── {idleCount} agent{idleCount !== 1 ? 's' : ''} idle ─── ⬡
            </div>
          )}
        </div>
        <div className="checkpoint-card">
          <span className="hex-tag">⬡ CHECKPOINT · sin checkpoints aún</span>
          <div className="desc">los checkpoints aparecen al completar hitos</div>
        </div>
      </div>
    </div>
  )
}
