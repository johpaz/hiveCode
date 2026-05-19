import { useEffect, useRef, useState } from 'react';
import { Brain, X, ChevronRight } from 'lucide-react';
import { hiveWs, type WsMessage } from '../lib/ws';

interface ThinkingBlock {
  id: number;
  coordinator: string;
  content: string;
  timestamp: string;
}

interface ThinkingPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function ThinkingPanel({ open, onClose }: ThinkingPanelProps) {
  const [blocks, setBlocks] = useState<ThinkingBlock[]>([]);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = hiveWs.onMessage((msg: WsMessage) => {
      if (msg.type === 'thinking' && msg.data) {
        const content = (msg.data.content as string) ?? (msg.content ?? '');
        if (!content) return;
        idRef.current += 1;
        setBlocks(prev => [...prev.slice(-99), {
          id: idRef.current,
          coordinator: (msg.data?.coordinator as string) ?? 'bee',
          content,
          timestamp: new Date().toISOString(),
        }]);
      } else if (msg.type === 'task_end') {
        setBlocks([]);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [blocks]);

  if (!open) {
    return (
      <button
        onClick={onClose}
        style={{
          position: 'fixed',
          right: 0,
          top: '50%',
          transform: 'translateY(-50%)',
          background: '#1a1a2e',
          border: '1px solid #333',
          borderRight: 'none',
          borderRadius: '6px 0 0 6px',
          padding: '10px 6px',
          cursor: 'pointer',
          color: '#888',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px',
          zIndex: 50,
        }}
        title="Show thinking panel"
      >
        <Brain size={14} color="#56ccf2" />
        <ChevronRight size={10} />
      </button>
    );
  }

  return (
    <div style={{
      width: '320px',
      flexShrink: 0,
      background: '#0d0d1a',
      borderLeft: '1px solid #1e1e3a',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid #1e1e3a',
        background: '#1a1a2e',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#56ccf2', fontWeight: 600 }}>
          <Brain size={13} />
          THINKING
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#555', padding: '2px' }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Content */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {blocks.length === 0 ? (
          <div style={{ fontSize: '12px', color: '#444', textAlign: 'center', marginTop: '40px' }}>
            Waiting for thinking events...
          </div>
        ) : (
          blocks.map(block => (
            <div key={block.id} style={{
              background: '#111124',
              borderRadius: '6px',
              padding: '10px 12px',
              borderLeft: '2px solid #56ccf244',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '10px', color: '#56ccf2', fontWeight: 600, textTransform: 'uppercase' }}>
                  {block.coordinator}
                </span>
                <span style={{ fontSize: '10px', color: '#444' }}>
                  {new Date(block.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <pre style={{
                margin: 0,
                fontSize: '11px',
                color: '#9a9ab8',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'monospace',
                lineHeight: 1.5,
              }}>
                {block.content}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
