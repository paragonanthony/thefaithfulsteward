import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field } from './ui.jsx';
import { date } from '../format.js';

/** Organization Settings: the organization's own Claude API key (Fill from document, statements, Auto Classify). */
export default function ClaudeKeySettings({ onChange }) {
  const { isOrgAdmin } = useApp();
  const [data, setData] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api.get('/attachments/claude-key').then(setData).catch(setError);
  useEffect(() => { load(); }, []);
  if (!data) return error ? <ErrorBanner error={error} /> : null;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try { const r = await api.put('/attachments/claude-key', { apiKey: key }); setKey(''); setMsg(`Saved the key ending in ${r.hint}.`); await load(); onChange?.(); } catch (x) { setError(x); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Remove the Claude API key? Fill from document, reading statements and Auto Classify stop working until a key is added again.')) return;
    setBusy(true); setError(null); setMsg(null);
    try { await api.del('/attachments/claude-key'); setMsg('Key removed.'); await load(); onChange?.(); } catch (x) { setError(x); } finally { setBusy(false); }
  };

  return (
    <form className="card form narrow" onSubmit={save}>
      <h3 className="card-title">Claude API key</h3>
      <p className="muted small">
        Fill from document, reading PDF / photo statements and bank feed Auto Classify use Claude ({data.model}) with
        this organization’s own Anthropic API key, so its usage is billed to your Anthropic account. Create a key in the
        Anthropic Console (console.anthropic.com → API keys). The key is stored encrypted and is never shown again.
      </p>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg}</div>}
      {!data.encryptionAvailable && <div className="alert alert-warn">The server needs ENCRYPTION_KEY set before a key can be saved.</div>}
      <p className="flush">
        {data.configured
          ? <>Status: <span className="badge ok">Set</span> key ending in <strong>{data.hint}</strong>{data.updated_by ? `, saved by ${data.updated_by}` : ''}{data.updated_at ? ` on ${date(String(data.updated_at).slice(0, 10))}` : ''}.</>
          : data.saved
            ? <>Status: <span className="badge warn">Can’t be read</span> the saved key can’t be decrypted (has ENCRYPTION_KEY changed?). Save it again.</>
            : <>Status: <span className="badge warn">Not set</span> Claude features are turned off for this organization.</>}
      </p>
      {isOrgAdmin ? (
        <>
          <Field label={data.saved ? 'Replace with a new key' : 'API key'}>
            <input type="password" className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !key.trim() || !data.encryptionAvailable}>{busy ? 'Checking…' : 'Save key'}</button>
            {data.saved && <button type="button" className="btn btn-ghost" disabled={busy} onClick={remove}>Remove key</button>}
          </div>
        </>
      ) : <p className="muted small">Only organization administrators can change the key.</p>}
    </form>
  );
}
