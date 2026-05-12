export const BEE = {
  happy:    '\\(^ᴗ^)/',
  thinking: ' (~ᴗ~) ',
  done:     ' (★ᴗ★)',
  error:    ' (×ᴗ×)',
  idle:     ' (-ᴗ-) ',
  plan:     ' (oᴗo)',
  waiting:  ' (?ᴗ?) ',
  neutral:  ' (·ᴗ·)',
} as const

export const BEE_FULL = `
  \\( ${BEE.happy} )/
  \u2590\u2593\u2593\u2593\u2593\u2593\u258c
  \u2590\u2593\u2593\u2593\u2593\u2593\u258c
  \u255a\u2550\u2550\u2550\u255d
`

export const BEE_COORDINATOR = {
  architecture: '\u2b21',
  backend:      '\u2b21',
  frontend:     '\u2b21',
  security:     '\u2b21',
  test:         '\u2b21',
  devops:       '\u2b21',
  principal:    '\u2b21',
  done:         '\u2b22',
} as const
