import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export interface FlowPhase {
  id: string;
  coordinator: string;
  status: 'idle' | 'thinking' | 'completed' | 'error' | 'blocked';
  label: string;
}

interface FlowCanvasProps {
  phases: FlowPhase[];
}

const COORDINATOR_THEME: Record<string, { bg: string; glow: string; border: string }> = {
  bee: {
    bg: 'rgba(245, 158, 11, 0.08)',
    glow: 'rgba(245, 158, 11, 0.4)',
    border: 'rgba(245, 158, 11, 0.5)',
  },
  architecture: {
    bg: 'rgba(168, 85, 247, 0.08)',
    glow: 'rgba(168, 85, 247, 0.4)',
    border: 'rgba(168, 85, 247, 0.5)',
  },
  backend: {
    bg: 'rgba(59, 130, 246, 0.08)',
    glow: 'rgba(59, 130, 246, 0.4)',
    border: 'rgba(59, 130, 246, 0.5)',
  },
  frontend: {
    bg: 'rgba(34, 197, 94, 0.08)',
    glow: 'rgba(34, 197, 94, 0.4)',
    border: 'rgba(34, 197, 94, 0.5)',
  },
  security: {
    bg: 'rgba(239, 68, 68, 0.08)',
    glow: 'rgba(239, 68, 68, 0.4)',
    border: 'rgba(239, 68, 68, 0.5)',
  },
  test: {
    bg: 'rgba(251, 191, 36, 0.08)',
    glow: 'rgba(251, 191, 36, 0.4)',
    border: 'rgba(251, 191, 36, 0.5)',
  },
  devops: {
    bg: 'rgba(156, 163, 175, 0.08)',
    glow: 'rgba(156, 163, 175, 0.4)',
    border: 'rgba(156, 163, 175, 0.5)',
  },
};

function HexNode(props: any) {
  const { label, coordinator, status } = props.data || {};
  const theme = COORDINATOR_THEME[coordinator] || COORDINATOR_THEME.devops;
  const isActive = status === 'thinking';
  const isCompleted = status === 'completed';
  const isError = status === 'error';

  const borderColor = isError ? '#ef4444' : theme.border;
  const bgColor = isError ? 'rgba(127,29,29,0.2)' : theme.bg;
  const glowColor = isError ? 'rgba(239,68,68,0.5)' : theme.glow;

  return (
    <div className="relative" style={{ width: 140, height: 120 }}>
      {/* Glow effect */}
      {isActive && (
        <div
          className="absolute inset-0 rounded-2xl animate-pulse-glow"
          style={{
            background: `radial-gradient(ellipse at center, ${glowColor}40 0%, transparent 70%)`,
            transform: 'scale(1.3)',
            filter: 'blur(12px)',
          }}
        />
      )}

      {/* Hexagon shape using clip-path */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center gap-1
          transition-all duration-500 ${isActive ? 'animate-float' : ''}`}
        style={{
          clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          backgroundColor: bgColor,
          border: `1.5px solid ${borderColor}`,
          boxShadow: isActive
            ? `0 0 24px ${glowColor}, inset 0 0 20px ${glowColor}20`
            : 'none',
        }}
      >
        <span
          className="text-[10px] font-bold uppercase tracking-[0.15em]"
          style={{ color: isError ? '#ef4444' : theme.border }}
        >
          {coordinator}
        </span>
        <span className="text-[9px] text-neutral-400 text-center px-3 leading-tight">
          {label}
        </span>
        <span
          className="text-[8px] uppercase tracking-[0.2em] mt-0.5"
          style={{ color: isError ? '#ef4444' : isCompleted ? '#22c55e' : theme.border }}
        >
          {status}
        </span>
      </div>

      {/* Status ring */}
      {isActive && (
        <div
          className="absolute inset-[-4px] rounded-2xl animate-spin"
          style={{
            background: `conic-gradient(from 0deg, transparent, ${borderColor}, transparent)`,
            clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
            opacity: 0.3,
            animationDuration: '3s',
          }}
        />
      )}
    </div>
  );
}

const nodeTypes = { hex: HexNode };

export default function FlowCanvas({ phases }: FlowCanvasProps) {
  const nodes: Node[] = useMemo(() => {
    return phases.map((phase, i) => ({
      id: phase.id,
      type: 'hex',
      position: {
        x: 80 + i * 170,
        y: 60 + (i % 2) * 100,
      },
      data: {
        label: phase.label,
        coordinator: phase.coordinator,
        status: phase.status,
      },
    }));
  }, [phases]);

  const edges: Edge[] = useMemo(() => {
    return phases.slice(0, -1).map((phase, i) => {
      const nextTheme = COORDINATOR_THEME[phases[i + 1]?.coordinator] || COORDINATOR_THEME.devops;
      const isAnimated = phases[i + 1]?.status === 'thinking';

      return {
        id: `${phase.id}->${phases[i + 1].id}`,
        source: phase.id,
        target: phases[i + 1].id,
        animated: isAnimated,
        style: {
          stroke: nextTheme.border,
          strokeWidth: isAnimated ? 2.5 : 1.5,
        },
        type: 'smoothstep',
      };
    });
  }, [phases]);

  return (
    <div className="w-full h-full relative" style={{ background: 'transparent' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes as any}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background
          color="rgba(240, 160, 48, 0.06)"
          gap={24}
          size={1}
        />
        <Controls
          className="bg-black/40 border border-white/10 backdrop-blur-md rounded-lg"
          showInteractive={false}
        />
        <MiniMap
          nodeColor={(n: any) => {
            const t = COORDINATOR_THEME[n.data?.coordinator as string];
            return t ? t.border : '#6b7280';
          }}
          className="bg-black/40 border border-white/10 rounded-lg backdrop-blur-md"
          maskColor="rgba(0,0,0,0.6)"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
        />
      </ReactFlow>
    </div>
  );
}
