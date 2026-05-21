import { useEffect, useRef } from 'react';

export default function HexGridBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const hexSize = 28;
    const hexHeight = hexSize * Math.sqrt(3);
    let offset = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const drawHex = (x: number, y: number, size: number, alpha: number) => {
      ctx!.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + size * Math.cos(angle);
        const py = y + size * Math.sin(angle);
        if (i === 0) ctx!.moveTo(px, py);
        else ctx!.lineTo(px, py);
      }
      ctx!.closePath();
      ctx!.strokeStyle = `rgba(240, 160, 48, ${alpha})`;
      ctx!.lineWidth = 0.5;
      ctx!.stroke();
    };

    const animate = () => {
      ctx!.clearRect(0, 0, canvas.width, canvas.height);
      offset += 0.15;

      const cols = Math.ceil(canvas.width / (hexSize * 3)) + 2;
      const rows = Math.ceil(canvas.height / hexHeight) + 2;

      for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
          const x = col * hexSize * 3 + (row % 2) * hexSize * 1.5;
          const y = row * hexHeight + (offset % hexHeight);
          const distFromCenter = Math.sqrt(
            Math.pow(x - canvas.width / 2, 2) + Math.pow(y - canvas.height / 2, 2)
          );
          const maxDist = Math.sqrt(Math.pow(canvas.width / 2, 2) + Math.pow(canvas.height / 2, 2));
          const baseAlpha = 0.015 * (1 - distFromCenter / maxDist);
          const pulse = Math.sin((x + y) * 0.02 + offset * 0.01) * 0.008;
          drawHex(x, y, hexSize, Math.max(0, baseAlpha + pulse));
        }
      }

      animId = requestAnimationFrame(animate);
    };

    animate();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}
