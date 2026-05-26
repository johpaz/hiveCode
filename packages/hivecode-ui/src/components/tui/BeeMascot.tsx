interface BeeMascotProps {
  scale?: number
}

export function BeeMascot({ scale = 1 }: BeeMascotProps) {
  const A = 'var(--bee-body)'
  const D = 'var(--bee-stripe)'
  const W = 'var(--bee-wing)'

  const G = [
    [0, W, W, 0, A, A, A, A, A, 0, W, W, 0],
    [0, W, W, 0, A, A, A, A, A, 0, W, W, 0],
    [0, W, W, 0, D, D, D, D, D, 0, W, W, 0],
    [0, 0, 0, 0, A, A, A, A, A, 0, 0, 0, 0],
    [0, 0, 0, 0, D, D, D, D, D, 0, 0, 0, 0],
    [0, 0, 0, 0, A, A, A, A, A, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, A, A, A, 0, 0, 0, 0, 0],
  ]

  const px = 14 * scale

  return (
    <div className="bee" style={{ '--px': px + 'px' } as React.CSSProperties}>
      <div className="bee-top">
        <pre className="bee-text">{
`  \\       /
   \\     /
    \\   /
   ( o o )   `
        }</pre>
      </div>
      <div className="bee-grid">
        {G.map((row, i) => (
          <div className="bee-row" key={i}>
            {row.map((c, j) => (
              <div
                key={j}
                className="bee-px"
                style={{ background: c || 'transparent' }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="bee-stinger">▼ ▼ ▼</div>
    </div>
  )
}
