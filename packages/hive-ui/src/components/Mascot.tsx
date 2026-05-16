import { useEffect, useRef } from 'react';

interface MascotProps {
  coordinator?: string;
  status?: string;
}

const COORDINATOR_THEMES: Record<string, { primary: string; secondary: string; accent: string; label: string }> = {
  bee: { primary: '#f59e0b', secondary: '#d97706', accent: '#fbbf24', label: 'BEE' },
  architecture: { primary: '#a855f7', secondary: '#7c3aed', accent: '#c084fc', label: 'ARCH' },
  backend: { primary: '#3b82f6', secondary: '#2563eb', accent: '#60a5fa', label: 'BACK' },
  frontend: { primary: '#22c55e', secondary: '#16a34a', accent: '#4ade80', label: 'FRONT' },
  security: { primary: '#ef4444', secondary: '#dc2626', accent: '#f87171', label: 'SEC' },
  test: { primary: '#fbbf24', secondary: '#d97706', accent: '#fcd34d', label: 'TEST' },
  devops: { primary: '#9ca3af', secondary: '#6b7280', accent: '#d1d5db', label: 'OPS' },
};

export default function Mascot({ coordinator = 'bee', status = 'idle' }: MascotProps) {
  const theme = COORDINATOR_THEMES[coordinator] || COORDINATOR_THEMES.bee;
  const isThinking = status === 'thinking' || status === 'running';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 120;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const draw = () => {
      timeRef.current += 0.016;
      const t = timeRef.current;
      ctx!.clearRect(0, 0, size, size);

      const cx = size / 2;
      const cy = size / 2;
      const baseRadius = 36;
      const floatY = isThinking ? Math.sin(t * 2.5) * 3 : Math.sin(t * 1.2) * 1.5;
      const wingSpeed = isThinking ? 18 : 6;
      const wingAmp = isThinking ? 0.4 : 0.15;

      // Glow
      const glow = ctx!.createRadialGradient(cx, cy + floatY, 0, cx, cy + floatY, baseRadius * 2);
      glow.addColorStop(0, theme.primary + (isThinking ? '40' : '18'));
      glow.addColorStop(1, 'transparent');
      ctx!.fillStyle = glow;
      ctx!.fillRect(0, 0, size, size);

      // Wings
      const wingPhase = Math.sin(t * wingSpeed) * wingAmp;
      ctx!.save();
      ctx!.translate(cx, cy + floatY);

      // Left wing
      ctx!.save();
      ctx!.rotate(-0.3 + wingPhase);
      ctx!.beginPath();
      ctx!.ellipse(-22, -8, 16, 8, -0.3, 0, Math.PI * 2);
      ctx!.fillStyle = theme.primary + '30';
      ctx!.strokeStyle = theme.primary + '60';
      ctx!.lineWidth = 1;
      ctx!.fill();
      ctx!.stroke();
      ctx!.restore();

      // Right wing
      ctx!.save();
      ctx!.rotate(0.3 - wingPhase);
      ctx!.beginPath();
      ctx!.ellipse(22, -8, 16, 8, 0.3, 0, Math.PI * 2);
      ctx!.fillStyle = theme.primary + '30';
      ctx!.strokeStyle = theme.primary + '60';
      ctx!.lineWidth = 1;
      ctx!.fill();
      ctx!.stroke();
      ctx!.restore();

      // Body (hexagon-ish)
      ctx!.beginPath();
      const r = baseRadius;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r * 1.1;
        if (i === 0) ctx!.moveTo(px, py);
        else ctx!.lineTo(px, py);
      }
      ctx!.closePath();
      const bodyGrad = ctx!.createLinearGradient(-r, -r, r, r);
      bodyGrad.addColorStop(0, theme.primary + '20');
      bodyGrad.addColorStop(1, theme.secondary + '15');
      ctx!.fillStyle = bodyGrad;
      ctx!.strokeStyle = theme.primary + '50';
      ctx!.lineWidth = 1.5;
      ctx!.fill();
      ctx!.stroke();

      // Stripes
      ctx!.beginPath();
      ctx!.moveTo(-r * 0.7, -r * 0.3);
      ctx!.lineTo(r * 0.7, -r * 0.3);
      ctx!.moveTo(-r * 0.8, r * 0.2);
      ctx!.lineTo(r * 0.8, r * 0.2);
      ctx!.strokeStyle = theme.primary + '30';
      ctx!.lineWidth = 2;
      ctx!.stroke();

      // Eyes
      const eyeOffset = isThinking ? Math.sin(t * 4) * 1 : 0;
      ctx!.fillStyle = theme.accent;
      ctx!.beginPath();
      ctx!.arc(-10 + eyeOffset, -6, 4, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.beginPath();
      ctx!.arc(10 + eyeOffset, -6, 4, 0, Math.PI * 2);
      ctx!.fill();

      // Pupils
      ctx!.fillStyle = '#0a0a0a';
      ctx!.beginPath();
      ctx!.arc(-10 + eyeOffset, -6, 1.8, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.beginPath();
      ctx!.arc(10 + eyeOffset, -6, 1.8, 0, Math.PI * 2);
      ctx!.fill();

      // Antennae
      ctx!.beginPath();
      ctx!.moveTo(-6, -r * 1.05);
      ctx!.quadraticCurveTo(-12, -r * 1.5, -18, -r * 1.4 + Math.sin(t * 2) * 2);
      ctx!.moveTo(6, -r * 1.05);
      ctx!.quadraticCurveTo(12, -r * 1.5, 18, -r * 1.4 + Math.cos(t * 2) * 2);
      ctx!.strokeStyle = theme.primary + '60';
      ctx!.lineWidth = 1.5;
      ctx!.stroke();

      // Antennae tips
      ctx!.fillStyle = theme.accent;
      ctx!.beginPath();
      ctx!.arc(-18, -r * 1.4 + Math.sin(t * 2) * 2, 2.5, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.beginPath();
      ctx!.arc(18, -r * 1.4 + Math.cos(t * 2) * 2, 2.5, 0, Math.PI * 2);
      ctx!.fill();

      ctx!.restore();

      animRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [coordinator, status, theme]);

  return (
    <div className="flex flex-col items-center gap-3 p-5">
      <div className="relative">
        <div
          className="absolute inset-0 blur-3xl rounded-full"
          style={{ backgroundColor: theme.primary + '20', transform: 'scale(1.5)' }}
        />
        <canvas
          ref={canvasRef}
          width={120}
          height={120}
          className="relative"
          style={{ width: 120, height: 120 }}
        />
      </div>

      <div className="flex flex-col items-center gap-1">
        <span
          className="text-[10px] font-bold uppercase tracking-[0.2em]"
          style={{ color: theme.primary }}
        >
          {theme.label}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${isThinking ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: theme.primary }}
          />
          <span className="text-[9px] text-neutral-500 uppercase tracking-wider">
            {isThinking ? 'Processing...' : 'Idle'}
          </span>
        </div>
      </div>
    </div>
  );
}
