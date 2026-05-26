import type { FileRisk, NarrativeLine } from '../../../data/types'

function riskClass(risk: string): string {
  if (risk === 'critical' || risk === 'CRITICAL' || risk === 'high') return 'crit'
  if (risk === 'medium' || risk === 'MEDIUM' || risk === 'warn') return 'warn'
  return 'done'
}

export function PlanLayout({ fileRisks, narrativeLines }: { fileRisks: FileRisk[]; narrativeLines: NarrativeLine[] }) {
  return (
    <div className="split">
      <div className="pane pane-left">
        <div className="panel-title">
          <span className="hex">⬡</span> RAZONAMIENTO · streaming
        </div>
        <div className="reasoning scroll">
          {narrativeLines.length === 0 ? (
            <div className="stream-line think" style={{ color: 'var(--text-disabled)' }}>
              ↳ esperando actividad del coordinador…
              <span className="cursor-blink"></span>
            </div>
          ) : (
            narrativeLines.map((line) => (
              <div className="stream-line" key={line.id}>
                <span className="stream-author">⬡ {line.coordinator || 'bee'}</span>
                <span>{line.content}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="pane pane-right">
        <div className="panel-title">
          <span className="hex">⬡</span> MAPA DE ARCHIVOS · riesgo
        </div>
        <div className="filemap scroll">
          {fileRisks.length === 0 ? (
            <div style={{ color: 'var(--text-disabled)', fontSize: 11, padding: '8px 4px' }}>
              ⬡ sin archivos modificados aún
            </div>
          ) : (
            fileRisks.map((r, i) => (
              <div className={`file ${riskClass(r.risk)}`} key={i}>
                <span className="dot">●</span>
                <span>{r.path.split('/').pop()}</span>
                <span className="note">{r.operation} · {r.agent}</span>
              </div>
            ))
          )}
        </div>
        <div className="adr-mini scroll">
          <h4>⬡ ADRs · referencias activas</h4>
          <div className="rule">═══════════════════════════════</div>
          {fileRisks.filter(r => r.reason).length === 0 ? (
            <p className="dim">sin referencias ADR aún</p>
          ) : (
            [...new Set(fileRisks.filter(r => r.reason).map(r => r.reason))].map((reason, i) => (
              <p key={i} className="dim">— {reason}</p>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
