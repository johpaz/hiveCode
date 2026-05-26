import type { AdrEntry } from '../../../data/types'

export function ReviewLayout({ adrs }: { adrs: AdrEntry[] }) {
  const latest = adrs[adrs.length - 1] ?? null

  if (!latest) {
    return (
      <div className="review">
        <div className="adr scroll" style={{ color: 'var(--text-disabled)', padding: '24px 16px' }}>
          <h1>⬡ sin ADRs aún</h1>
          <p>Los ADRs aparecen cuando el agente <span className="amber">architecture</span> los genera durante la tarea.</p>
        </div>
        <div className="approval-strip scroll">
          <div className="label">⬡ ARCHIVOS PARA APROBAR · 0</div>
          <div className="hint">→ escribe <span className="cmd">/approve</span> para aceptar · <span className="cmd">/reject &lt;razón&gt;</span> para devolver</div>
        </div>
      </div>
    )
  }

  const adrId = latest.path.split('/').pop()?.replace(/\.md$/, '').toUpperCase() ?? 'ADR'

  return (
    <div className="review">
      <div className="adr scroll">
        <h1>⬡ {adrId} · {latest.title}</h1>
        <div className="adr-meta">Status: {latest.status.toUpperCase()} · {latest.path}</div>

        <div className="rule">═══════════════════════════════════════════════</div>
        <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6 }}>
          {latest.content}
        </div>
      </div>

      <div className="approval-strip scroll">
        <div className="label">⬡ ADRs ACTIVOS · {adrs.length}</div>
        {adrs.map((adr, i) => (
          <div className="file-line" key={i}>
            <span className={`marker ${adr.status === 'accepted' ? 'warn' : 'crit'}`}>●</span>
            <span className="path">{adr.path}</span>
            <span className="note">{adr.status} · {adr.title}</span>
          </div>
        ))}
        <div className="hint">
          → escribe <span className="cmd">/approve</span> para aceptar · <span className="cmd">/reject &lt;razón&gt;</span> para devolver al worker
        </div>
      </div>
    </div>
  )
}
