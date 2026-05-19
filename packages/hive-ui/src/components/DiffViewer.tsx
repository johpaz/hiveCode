import { CheckCircle, SkipForward, XCircle, FileCode } from 'lucide-react';
import { hiveWs } from '../lib/ws';

interface DiffLine {
  type: 'added' | 'removed' | 'context' | 'header';
  content: string;
  lineNum?: number;
}

interface DiffViewerProps {
  taskId: string;
  phaseId: string | number;
  phase: string;
  diff: string;
  onDismiss: () => void;
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('@@')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+')) {
      lines.push({ type: 'added', content: line.slice(1) });
    } else if (line.startsWith('-')) {
      lines.push({ type: 'removed', content: line.slice(1) });
    } else {
      lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return lines;
}

const LINE_STYLE: Record<DiffLine['type'], { background: string; color: string; prefix: string }> = {
  added:   { background: '#0d2b1a', color: '#6fcf97', prefix: '+' },
  removed: { background: '#2b0d0d', color: '#eb5757', prefix: '-' },
  context: { background: 'transparent', color: '#7a7a9a', prefix: ' ' },
  header:  { background: '#0d1a2b', color: '#56ccf2', prefix: '' },
};

export default function DiffViewer({ taskId, phaseId, phase, diff, onDismiss }: DiffViewerProps) {
  const lines = parseDiff(diff);
  const added = lines.filter(l => l.type === 'added').length;
  const removed = lines.filter(l => l.type === 'removed').length;

  const sendAction = (action: 'approve' | 'skip' | 'cancel') => {
    hiveWs.send({ type: action === 'approve' ? 'approve_phase' : action === 'skip' ? 'skip_phase' : 'cancel_task', data: { taskId, phaseId } });
    onDismiss();
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.75)',
      zIndex: 100,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      <div style={{
        background: '#0d0d1a',
        border: '1px solid #1e1e3a',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '860px',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid #1e1e3a',
          background: '#1a1a2e',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FileCode size={15} color="#56ccf2" />
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#e0e0e0' }}>
              Fase completada: <span style={{ color: '#56ccf2' }}>{phase}</span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: '12px', fontSize: '12px' }}>
            <span style={{ color: '#6fcf97' }}>+{added}</span>
            <span style={{ color: '#eb5757' }}>-{removed}</span>
          </div>
        </div>

        {/* Diff content */}
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px' }}>
          {lines.map((line, i) => {
            const s = LINE_STYLE[line.type];
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  background: s.background,
                  color: s.color,
                  padding: '1px 0',
                  lineHeight: 1.6,
                }}
              >
                <span style={{ width: '20px', flexShrink: 0, textAlign: 'center', opacity: 0.5 }}>
                  {s.prefix}
                </span>
                <span style={{ flex: 1, paddingRight: '12px', whiteSpace: 'pre', overflowX: 'auto' }}>
                  {line.content}
                </span>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div style={{
          display: 'flex',
          gap: '10px',
          padding: '14px 20px',
          borderTop: '1px solid #1e1e3a',
          background: '#1a1a2e',
          justifyContent: 'flex-end',
        }}>
          <button
            onClick={() => sendAction('cancel')}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 16px', borderRadius: '8px',
              background: 'transparent', border: '1px solid #eb575744',
              color: '#eb5757', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
            }}
          >
            <XCircle size={13} /> Cancelar tarea
          </button>
          <button
            onClick={() => sendAction('skip')}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 16px', borderRadius: '8px',
              background: 'transparent', border: '1px solid #f2994a44',
              color: '#f2994a', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
            }}
          >
            <SkipForward size={13} /> Saltar fase
          </button>
          <button
            onClick={() => sendAction('approve')}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 16px', borderRadius: '8px',
              background: '#0d2b1a', border: '1px solid #6fcf9744',
              color: '#6fcf97', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
            }}
          >
            <CheckCircle size={13} /> Aprobar
          </button>
        </div>
      </div>
    </div>
  );
}
