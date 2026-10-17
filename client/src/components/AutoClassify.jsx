import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Modal } from './ui.jsx';

/**
 * Bank Feed: Auto Classify the selected bank account's unassigned lines with Claude, and edit the organization's
 * Auto Classify prompt (org admins; it's also under Organization Settings → Document extraction prompts).
 */
export default function AutoClassifyDialog({ accountId, accountName, unassigned, onClose, onDone }) {
  const { isOrgAdmin } = useApp();
  const [prompt, setPrompt] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const load = () => api.get('/attachments/prompts').then((d) => {
    const p = d.prompts.find((x) => x.type === 'classify');
    setPrompt({ ...p, model: d.model });
    setDraft(p.prompt);
  }).catch(setErr);
  useEffect(() => { load(); }, []);
  const dirty = prompt && draft !== prompt.prompt;

  const savePrompt = async () => {
    setSaving(true); setErr(null);
    try { await api.put('/attachments/prompts/classify', { prompt: draft }); await load(); setSaved(true); } catch (e) { setErr(e); } finally { setSaving(false); }
  };
  const resetPrompt = async () => {
    setSaving(true); setErr(null);
    try { await api.del('/attachments/prompts/classify'); await load(); setSaved(true); } catch (e) { setErr(e); } finally { setSaving(false); }
  };
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      if (dirty && isOrgAdmin) await api.put('/attachments/prompts/classify', { prompt: draft });
      onDone(await api.post('/bank-feed/auto-classify', { accountId }));
    } catch (e) { setErr(e); setBusy(false); }
  };

  return (
    <Modal title="Auto Classify with Claude" onClose={busy ? () => {} : onClose} width={640}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={run} disabled={busy || !unassigned}>
          <Sparkles size={15} aria-hidden="true" />{busy ? 'Classifying…' : `Classify ${unassigned} line${unassigned === 1 ? '' : 's'}`}
        </button>
      </>}>
      <ErrorBanner error={err} onClose={() => setErr(null)} />
      <p className="flush">
        Claude reads the <strong>{unassigned}</strong> unassigned line{unassigned === 1 ? '' : 's'} on {accountName} and picks a customer / vendor
        (when the description clearly names one of yours) and an income or expense account. Lines set by hand or by a rule are left alone,
        and you can change anything it picks before creating transactions.
      </p>
      <p className="muted small">
        It sends the bank descriptions and amounts, your income and expense accounts, your customer / vendor names, and up to 120 bank lines
        you’ve already matched (as examples) to {prompt?.model || 'Claude'}. Up to 200 lines are classified per run.
      </p>
      <label className="field-label" htmlFor="classify-prompt">Your organization’s instructions for Claude</label>
      <textarea id="classify-prompt" className="input mono-ish" rows={8} value={draft} disabled={!isOrgAdmin || !prompt}
        onChange={(e) => { setDraft(e.target.value); setSaved(false); }} />
      <p className="muted small flush">
        {isOrgAdmin ? 'Add anything that helps, such as how you code particular vendors or deposits. Changes are saved when you classify.' : 'Only organization administrators can change these instructions.'}
        {prompt && !prompt.isDefault && ' (Customized.)'}{saved && ' Saved.'}
      </p>
      {isOrgAdmin && prompt && (
        <div className="row gap mt">
          {dirty && <button type="button" className="btn btn-sm" disabled={saving || !draft.trim()} onClick={savePrompt}>Save instructions</button>}
          {dirty && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(prompt.prompt)}>Undo changes</button>}
          {!prompt.isDefault && !dirty && <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={resetPrompt}>Reset to standard instructions</button>}
        </div>
      )}
    </Modal>
  );
}
