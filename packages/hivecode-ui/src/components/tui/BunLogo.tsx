interface BunLogoProps {
  size?: number
}

export function BunLogo({ size = 16 }: BunLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 70"
      xmlns="http://www.w3.org/2000/svg"
      style={{ verticalAlign: '-2px', display: 'inline-block' }}
      aria-label="Bun"
    >
      <path
        d="M 8 60 Q 8 8 40 8 Q 72 8 72 60 L 72 63 Q 72 67 68 67 L 12 67 Q 8 67 8 63 Z"
        fill="#F9F1E1"
        stroke="#0B0907"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <ellipse cx="22" cy="48" rx="6" ry="4" fill="#F4B6B6" />
      <ellipse cx="58" cy="48" rx="6" ry="4" fill="#F4B6B6" />
      <ellipse cx="30" cy="40" rx="2.4" ry="3.6" fill="#0B0907" />
      <ellipse cx="50" cy="40" rx="2.4" ry="3.6" fill="#0B0907" />
      <path d="M 35 50 Q 40 55 45 50" stroke="#0B0907" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  )
}
