import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Tabs } from './ui.jsx';
import { date } from '../format.js';

/** Organization Settings: the saved prompt Claude follows for each transaction type when filling a form from a document. */
export default function ExtractionPrompts() {
  const { isOrgAdmin, me } = useApp();
  const [data, setData] = useState(null);
  const [type, setType] = useState('expense');
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api.get('/attachments/prompts').then((d) => { setData(d); setDraft(Object.fromEntries(d.prompts.map((p) => [p.type, p.prompt]))); }).catch(setError);
  useEffect(() => { load(); }, []);
  if (!data) return error ? <ErrorBanner error={error} /> : null;

  const tuitionOn = Boolean(me.currentOrganization?.tuition_enabled);
  const prompts = data.prompts.filter((p) => p.type !== 'tuition' || tuitionOn);
  const cur = prompts.find((p) => p.type === type) || prompts[0];
  const dirty = draft[cur.type] !== cur.prompt;
  const save = async () => {
    setError(null); setMsg(null);
    try { await api.put(`/attachments/prompts/${cur.type}`, { prompt: draft[cur.type] }); await load(); setMsg(`${cur.label} prompt saved.`); } catch (e) { setError(e); }
  };
  const reset = async () => {
    setError(null); setMsg(null);
    try { await api.del(`/attachments/prompts/${cur.type}`); await load(); setMsg(`${cur.label} prompt reset to the standard prompt.`); } catch (e) { setError(e); }
  };

  return (
    <div className="card form narrow">
      <h3 className="card-title">Document extraction prompts</h3>
      <p className="muted small">
        On income, expense, bank transfer, journal entry and tuition screens, <strong>Fill from document</strong> sends an attached
        PDF or image to Claude ({data.model}) with your chart of accounts, funds and names, and fills in the form for you to review.
        These instructions tell Claude how your organization records each type of transaction. <strong>Bank Feed Auto
        Classify</strong> is what Claude follows when it picks customers / vendors and accounts for bank feed lines.
      </p>
      {!data.extractionEnabled && <div className="alert alert-warn">Not set up yet: add this organization’s Claude API key above to turn on Fill from document.</div>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg}</div>}
      <Tabs tabs={prompts.map((p) => ({ value: p.type, label: p.label }))} value={cur.type} onChange={(v) => { setType(v); setMsg(null); }} />
      <textarea className="input mono-ish" rows={10} value={draft[cur.type] ?? ''} disabled={!isOrgAdmin}
        onChange={(e) => setDraft({ ...draft, [cur.type]: e.target.value })} aria-label={`${cur.label} prompt`} />
      <p className="muted small flush">
        {cur.isDefault ? 'Using the standard prompt.' : `Customized${cur.updated_by ? ` by ${cur.updated_by}` : ''}${cur.updated_at ? ` on ${date(String(cur.updated_at).slice(0, 10))}` : ''}.`}
        {' '}Example additions: “Code all Amazon purchases to Program Supplies”, “Grants from the Smith Foundation go to the Youth Program fund”.
      </p>
      {isOrgAdmin && (
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={!dirty || !String(draft[cur.type] || '').trim()} onClick={save}>Save prompt</button>
          {dirty && <button type="button" className="btn btn-ghost" onClick={() => setDraft({ ...draft, [cur.type]: cur.prompt })}>Undo changes</button>}
          {!cur.isDefault && <button type="button" className="btn" onClick={reset}>Reset to standard prompt</button>}
        </div>
      )}
    </div>
  );
}
