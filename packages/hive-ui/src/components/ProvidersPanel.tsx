import { useState, useEffect, useCallback } from 'react';
import { Settings, Plus, RefreshCw, Trash2, ChevronDown, ChevronUp, X, Save, Cpu, Key } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface Model {
  id: string;
  name: string;
  provider_id: string;
  model_type: string;
  context_window: number;
  enabled: boolean;
  active: boolean;
}

interface Provider {
  id: string;
  name: string;
  base_url: string | null;
  enabled: number;
  active: number;
  num_ctx: number | null;
  has_api_key: number;
  masked_api_key: string | null;
  models: Model[];
}

interface EditProviderForm {
  name: string;
  base_url: string;
  enabled: boolean;
  active: boolean;
  apiKey: string;
  num_ctx: string;
}

interface AddModelForm {
  id: string;
  name: string;
  model_type: string;
  context_window: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 7px', borderRadius: '99px',
      fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em',
      background: active ? 'rgba(64,208,128,0.12)' : 'rgba(80,80,100,0.18)',
      color: active ? '#40d080' : '#666',
      border: `1px solid ${active ? 'rgba(64,208,128,0.25)' : 'rgba(80,80,100,0.3)'}`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: active ? '#40d080' : '#555' }} />
      {label}
    </span>
  );
}

function ModelRow({ model, onDelete }: { model: Model; onDelete: (id: string) => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '5px 10px',
      borderRadius: '6px',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.04)',
      gap: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        <Cpu size={11} color="#666" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: '12px', color: '#c0c0c0', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model.id}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={{ fontSize: '10px', color: '#555', background: 'rgba(255,255,255,0.04)', padding: '1px 5px', borderRadius: '4px' }}>
          {model.model_type}
        </span>
        {model.context_window > 0 && (
          <span style={{ fontSize: '10px', color: '#444' }}>
            {model.context_window >= 1000 ? `${Math.round(model.context_window / 1000)}k` : model.context_window}
          </span>
        )}
        <StatusBadge label={model.enabled ? 'ON' : 'OFF'} active={model.enabled} />
        <button
          onClick={() => onDelete(model.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#444', padding: '2px', display: 'flex', borderRadius: '4px' }}
          title="Eliminar modelo"
          onMouseEnter={e => (e.currentTarget.style.color = '#eb5757')}
          onMouseLeave={e => (e.currentTarget.style.color = '#444')}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

// ── Provider Card ─────────────────────────────────────────────────────────────

function ProviderCard({
  provider,
  onRefresh,
  onEdit,
  onAddModel,
  onDeleteModel,
  onSync,
}: {
  provider: Provider;
  onRefresh: () => void;
  onEdit: (p: Provider) => void;
  onAddModel: (p: Provider) => void;
  onDeleteModel: (modelId: string) => void;
  onSync: (p: Provider) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try { await onSync(provider); } finally { setSyncing(false); }
  };

  return (
    <div style={{
      background: 'rgba(20,18,16,0.6)',
      border: `1px solid ${provider.active ? 'rgba(240,160,48,0.18)' : 'rgba(255,255,255,0.06)'}`,
      borderRadius: '10px',
      overflow: 'hidden',
      boxShadow: provider.active ? '0 0 20px rgba(240,160,48,0.06)' : 'none',
      transition: 'border-color 0.2s',
    }}>
      {/* Card header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.02)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        {/* Provider icon */}
        <div style={{
          width: 32, height: 32, borderRadius: '8px',
          background: provider.active ? 'rgba(240,160,48,0.15)' : 'rgba(255,255,255,0.05)',
          border: `1px solid ${provider.active ? 'rgba(240,160,48,0.3)' : 'rgba(255,255,255,0.08)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '14px', fontWeight: 700, color: provider.active ? '#f0a030' : '#555',
          flexShrink: 0,
        }}>
          {provider.name.charAt(0).toUpperCase()}
        </div>

        {/* Name + ID */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#e8e4dc', marginBottom: '3px' }}>
            {provider.name}
          </div>
          <div style={{ fontSize: '10px', color: '#555', fontFamily: 'monospace' }}>
            {provider.id}
          </div>
        </div>

        {/* Status badges */}
        <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
          <StatusBadge label="Habilitado" active={!!provider.enabled} />
          <StatusBadge label="Activo" active={!!provider.active} />
          {provider.has_api_key ? (
            <span title="API key configurada" style={{ color: '#f0a030' }}><Key size={12} /></span>
          ) : (
            <span title="Sin API key" style={{ color: '#444' }}><Key size={12} /></span>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          <ActionBtn title="Sincronizar modelos desde API" onClick={handleSync} spin={syncing}>
            <RefreshCw size={13} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
          </ActionBtn>
          <ActionBtn title="Agregar modelo" onClick={() => onAddModel(provider)}>
            <Plus size={13} />
          </ActionBtn>
          <ActionBtn title="Configurar provider" onClick={() => onEdit(provider)} amber>
            <Settings size={13} />
          </ActionBtn>
          <ActionBtn title={expanded ? 'Colapsar' : 'Expandir'} onClick={() => setExpanded(v => !v)}>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </ActionBtn>
        </div>
      </div>

      {/* Models list */}
      {expanded && (
        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {/* Base URL */}
          {provider.base_url && (
            <div style={{ fontSize: '10px', color: '#444', fontFamily: 'monospace', marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {provider.base_url}
            </div>
          )}

          {provider.models.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#444', padding: '8px 0' }}>
              Sin modelos — usa{' '}
              <button
                onClick={() => onAddModel(provider)}
                style={{ background: 'none', border: 'none', color: '#f0a030', cursor: 'pointer', fontSize: '12px', padding: 0 }}
              >
                + agregar
              </button>
              {' '}o{' '}
              <button
                onClick={handleSync}
                style={{ background: 'none', border: 'none', color: '#f0a030', cursor: 'pointer', fontSize: '12px', padding: 0 }}
              >
                sincronizar
              </button>
            </div>
          ) : (
            provider.models.map(m => (
              <ModelRow key={m.id} model={m} onDelete={onDeleteModel} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  children, title, onClick, amber = false, spin = false,
}: {
  children: React.ReactNode; title: string; onClick: () => void; amber?: boolean; spin?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: amber ? 'rgba(240,160,48,0.1)' : 'rgba(255,255,255,0.04)',
        border: amber ? '1px solid rgba(240,160,48,0.2)' : '1px solid rgba(255,255,255,0.06)',
        color: amber ? '#f0a030' : '#666',
        borderRadius: '6px',
        width: 28, height: 28,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = amber ? 'rgba(240,160,48,0.2)' : 'rgba(255,255,255,0.08)';
        e.currentTarget.style.color = amber ? '#f0c060' : '#aaa';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = amber ? 'rgba(240,160,48,0.1)' : 'rgba(255,255,255,0.04)';
        e.currentTarget.style.color = amber ? '#f0a030' : '#666';
      }}
    >
      {children}
    </button>
  );
}

// ── Edit Dialog ───────────────────────────────────────────────────────────────

function EditProviderDialog({
  provider,
  onClose,
  onSave,
}: {
  provider: Provider;
  onClose: () => void;
  onSave: (id: string, form: EditProviderForm) => Promise<void>;
}) {
  const [form, setForm] = useState<EditProviderForm>({
    name: provider.name,
    base_url: provider.base_url || '',
    enabled: !!provider.enabled,
    active: !!provider.active,
    apiKey: '',
    num_ctx: provider.num_ctx ? String(provider.num_ctx) : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (field: keyof EditProviderForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(f => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(provider.id, form);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0', height: '100%' }}>
        {/* Dialog header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e8e4dc' }}>Configurar Provider</div>
            <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace', marginTop: '2px' }}>{provider.id}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', display: 'flex', borderRadius: '6px', padding: '4px' }}
            onMouseEnter={e => e.currentTarget.style.color = '#aaa'} onMouseLeave={e => e.currentTarget.style.color = '#555'}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Field label="Nombre">
            <input type="text" value={form.name} onChange={set('name')} style={inputStyle} />
          </Field>
          <Field label="Base URL">
            <input type="text" value={form.base_url} onChange={set('base_url')} placeholder="https://api.openai.com/v1" style={inputStyle} />
          </Field>
          <Field label="API Key" hint={provider.masked_api_key ? `Actual: ${provider.masked_api_key}` : 'Sin API key'}>
            <input type="password" value={form.apiKey} onChange={set('apiKey')} placeholder="sk-… (dejar vacío para no cambiar)" style={inputStyle} />
          </Field>
          <Field label="Context window (num_ctx)" hint="Solo para modelos locales (Ollama, llama.cpp)">
            <input type="number" value={form.num_ctx} onChange={set('num_ctx')} placeholder="4096" style={inputStyle} />
          </Field>

          {/* Toggles */}
          <div style={{ display: 'flex', gap: '20px' }}>
            <Toggle label="Habilitado" checked={form.enabled} onChange={v => setForm(f => ({ ...f, enabled: v }))} />
            <Toggle label="Activo" checked={form.active} onChange={v => setForm(f => ({ ...f, active: v }))} />
          </div>

          {error && (
            <div style={{ background: 'rgba(235,87,87,0.1)', border: '1px solid rgba(235,87,87,0.3)', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#eb5757' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={onClose} style={{ ...btnStyle, background: 'rgba(255,255,255,0.04)', color: '#888', border: '1px solid rgba(255,255,255,0.08)' }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, background: 'rgba(240,160,48,0.15)', color: '#f0a030', border: '1px solid rgba(240,160,48,0.3)', opacity: saving ? 0.6 : 1 }}>
            <Save size={13} />
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Add Model Dialog ──────────────────────────────────────────────────────────

function AddModelDialog({
  provider,
  onClose,
  onSave,
}: {
  provider: Provider;
  onClose: () => void;
  onSave: (form: AddModelForm & { provider_id: string }) => Promise<void>;
}) {
  const [form, setForm] = useState<AddModelForm>({ id: '', name: '', model_type: 'llm', context_window: '20000' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (field: keyof AddModelForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm(f => ({ ...f, [field]: e.target.value }));
    if (field === 'id' && !form.name) setForm(f => ({ ...f, id: e.target.value, name: e.target.value }));
  };

  const handleSave = async () => {
    if (!form.id.trim()) { setError('El ID del modelo es obligatorio'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave({ ...form, provider_id: provider.id });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#e8e4dc' }}>Agregar Modelo</div>
            <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>Provider: <span style={{ color: '#f0a030' }}>{provider.id}</span></div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', display: 'flex', borderRadius: '6px', padding: '4px' }}
            onMouseEnter={e => e.currentTarget.style.color = '#aaa'} onMouseLeave={e => e.currentTarget.style.color = '#555'}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Field label="ID del modelo *">
            <input type="text" value={form.id} onChange={set('id')} placeholder="claude-sonnet-4-6" style={inputStyle} autoFocus />
          </Field>
          <Field label="Nombre">
            <input type="text" value={form.name} onChange={set('name')} placeholder="Claude Sonnet 4.6" style={inputStyle} />
          </Field>
          <Field label="Tipo">
            <select value={form.model_type} onChange={set('model_type')} style={{ ...inputStyle, cursor: 'pointer' }}>
              {['llm', 'stt', 'tts', 'vision', 'embedding'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Ventana de contexto (tokens)">
            <input type="number" value={form.context_window} onChange={set('context_window')} placeholder="200000" style={inputStyle} />
          </Field>

          {error && (
            <div style={{ background: 'rgba(235,87,87,0.1)', border: '1px solid rgba(235,87,87,0.3)', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#eb5757' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={onClose} style={{ ...btnStyle, background: 'rgba(255,255,255,0.04)', color: '#888', border: '1px solid rgba(255,255,255,0.08)' }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, background: 'rgba(64,208,128,0.12)', color: '#40d080', border: '1px solid rgba(64,208,128,0.25)', opacity: saving ? 0.6 : 1 }}>
            <Plus size={13} />
            {saving ? 'Agregando…' : 'Agregar modelo'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Shared dialog UI ──────────────────────────────────────────────────────────

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 440, maxHeight: '80vh',
        background: '#141210',
        border: '1px solid rgba(240,160,48,0.12)',
        borderRadius: '12px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: '11px', fontWeight: 600, color: '#888', letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: '10px', color: '#444', marginTop: '4px' }}>{hint}</div>}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 34, height: 18, borderRadius: '99px',
          background: checked ? 'rgba(64,208,128,0.3)' : 'rgba(255,255,255,0.06)',
          border: `1px solid ${checked ? 'rgba(64,208,128,0.4)' : 'rgba(255,255,255,0.1)'}`,
          position: 'relative', cursor: 'pointer', transition: 'background 0.2s',
        }}
      >
        <div style={{
          position: 'absolute', top: 2,
          left: checked ? 16 : 2,
          width: 12, height: 12, borderRadius: '50%',
          background: checked ? '#40d080' : '#555',
          transition: 'left 0.2s, background 0.2s',
        }} />
      </div>
      <span style={{ fontSize: '13px', color: '#aaa' }}>{label}</span>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '7px', padding: '8px 11px',
  fontSize: '13px', color: '#e8e4dc',
  outline: 'none', fontFamily: 'inherit',
};

const btnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '6px',
  padding: '7px 14px', borderRadius: '7px',
  fontSize: '12px', fontWeight: 600,
  cursor: 'pointer', border: 'none',
};

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [addingModelFor, setAddingModelFor] = useState<Provider | null>(null);
  const [syncMsg, setSyncMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/api/providers');
      setProviders(data.providers || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaveProvider = async (id: string, form: EditProviderForm) => {
    await apiFetch(`/api/providers/${id}`, {
      method: 'POST',
      body: JSON.stringify({
        name: form.name,
        base_url: form.base_url || null,
        enabled: form.enabled,
        active: form.active,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(form.num_ctx ? { num_ctx: Number(form.num_ctx) } : { num_ctx: null }),
      }),
    });
    await load();
  };

  const handleAddModel = async (form: AddModelForm & { provider_id: string }) => {
    await apiFetch('/api/models', {
      method: 'POST',
      body: JSON.stringify({
        id: form.id.trim(),
        provider_id: form.provider_id,
        name: form.name || form.id.trim(),
        model_type: form.model_type,
        context_window: Number(form.context_window) || 20000,
        enabled: 1,
        active: 0,
      }),
    });
    await load();
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!confirm(`¿Eliminar modelo "${modelId}"?`)) return;
    await apiFetch(`/api/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
    await load();
  };

  const handleSync = async (provider: Provider) => {
    setSyncMsg('');
    try {
      const data = await apiFetch(`/api/providers/${provider.id}/sync-models`, { method: 'POST' });
      setSyncMsg(`✓ ${provider.name}: ${data.synced ?? 0} modelos sincronizados`);
      await load();
    } catch (err) {
      setSyncMsg(`✗ ${provider.name}: ${(err as Error).message}`);
    }
    setTimeout(() => setSyncMsg(''), 4000);
  };

  return (
    <div style={{ padding: '20px 24px', height: '100%', overflowY: 'auto', color: '#e0e0e0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#f0f0f0' }}>Providers</h2>
          <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#555' }}>
            {providers.length} configurados · {providers.filter(p => p.active).length} activos
          </p>
        </div>
        <button
          onClick={load}
          title="Recargar"
          style={{ ...btnStyle, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#666' }}
        >
          <RefreshCw size={13} />
          Actualizar
        </button>
      </div>

      {/* Sync feedback */}
      {syncMsg && (
        <div style={{
          marginBottom: '14px', padding: '8px 14px', borderRadius: '7px', fontSize: '12px',
          background: syncMsg.startsWith('✓') ? 'rgba(64,208,128,0.1)' : 'rgba(235,87,87,0.1)',
          border: `1px solid ${syncMsg.startsWith('✓') ? 'rgba(64,208,128,0.25)' : 'rgba(235,87,87,0.25)'}`,
          color: syncMsg.startsWith('✓') ? '#40d080' : '#eb5757',
        }}>
          {syncMsg}
        </div>
      )}

      {/* State */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#555', fontSize: '13px' }}>Cargando providers…</div>
      ) : error ? (
        <div style={{ background: 'rgba(235,87,87,0.1)', border: '1px solid rgba(235,87,87,0.3)', borderRadius: '8px', padding: '16px', fontSize: '13px', color: '#eb5757' }}>
          {error}
        </div>
      ) : providers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#555' }}>
          <div style={{ fontSize: '32px', marginBottom: '10px' }}>🐝</div>
          <div style={{ fontSize: '13px' }}>Sin providers. Agrega uno con <code style={{ color: '#f0a030' }}>/provider add</code></div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {providers.map(p => (
            <ProviderCard
              key={p.id}
              provider={p}
              onRefresh={load}
              onEdit={setEditingProvider}
              onAddModel={setAddingModelFor}
              onDeleteModel={handleDeleteModel}
              onSync={handleSync}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {editingProvider && (
        <EditProviderDialog
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
          onSave={handleSaveProvider}
        />
      )}
      {addingModelFor && (
        <AddModelDialog
          provider={addingModelFor}
          onClose={() => setAddingModelFor(null)}
          onSave={handleAddModel}
        />
      )}

      {/* Keyframe for spinner */}
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
