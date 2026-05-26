import { WORKERS, TIERS } from '../../../data/mockData'
import type { WorkerStatus } from '../../../data/types'

function HexCorner({ pos }: { pos: string }) {
  return <span className={`hex-corner ${pos}`}>⬡</span>
}

export function DashboardLayout({ workersState }: { workersState: WorkerStatus[] }) {
  const byId = Object.fromEntries(workersState.map((w) => [w.id, w]))
  const runningTotal = workersState.filter((w) => w.state === 'running').length
  const conflictTotal = workersState.filter((w) => w.conflict).length

  return (
    <div className="dashboard scroll">
      {TIERS.map((tier) => {
        const cells = tier.ids.map((id) => ({ ...(byId[id] ?? { id, state: 'idle', action: 'standby', tokens: '0.0k', cost: '$0.00', active: false, conflict: false }), id }))
        const tierRunning = cells.filter((c) => c.state === 'running').length
        return (
          <div className="tier" key={tier.id}>
            <div className="tier-header">
              <div className="tier-label">
                <span className="hex">⬡</span>
                <span>{tier.label}</span>
              </div>
              <div className="tier-hint">{tier.hint}</div>
              <div className="tier-count">
                {cells.length} agent{cells.length !== 1 ? 's' : ''}
                {tierRunning > 0 && <span style={{ color: 'var(--running)' }}>  ·  {tierRunning} running</span>}
              </div>
            </div>
            <div className="tier-grid">
              {cells.map((w) => {
                const wm = WORKERS[w.id]
                if (!wm) return null
                const cls = ['wcell']
                if (w.active) cls.push('active')
                if (w.conflict) cls.push('conflict')
                if (w.state === 'idle') cls.push('idle')
                return (
                  <div
                    className={cls.join(' ')}
                    key={w.id}
                    style={{ '--w-color': wm.color } as React.CSSProperties}
                  >
                    <HexCorner pos="tl" />
                    <HexCorner pos="tr" />
                    <HexCorner pos="bl" />
                    <HexCorner pos="br" />
                    {w.conflict && <span className="conflict-tag">⚠ CONFLICT</span>}
                    <div className="wname">
                      <span>⬡</span>
                      <span>{wm.label}</span>
                      <span className="role">{wm.role}</span>
                    </div>
                    <div className={`wstate ${w.state}`}>● {w.state}</div>
                    <div className="waction">{w.action}</div>
                    <div className="wmeta">
                      <span className="kv"><span className="k">tokens</span><span className="v">{w.tokens}</span></span>
                      <span className="kv"><span className="k">cost</span><span className="v">{w.cost}</span></span>
                      {w.active && <span className="kv"><span className="k">status</span><span className="v" style={{ color: 'var(--done)' }}>online</span></span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <div style={{ color: 'var(--text-disabled)', fontSize: 11, padding: '4px 2px 18px', letterSpacing: 1, textAlign: 'center' }}>
        ⬡ ─── {workersState.length} agents · {runningTotal} running · {conflictTotal} conflict · 0 HALT ─── ⬡
      </div>
    </div>
  )
}
