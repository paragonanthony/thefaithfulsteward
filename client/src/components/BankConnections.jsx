import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { BankAccountSelect, ErrorBanner, Field, Modal, isBanking, useAccountOptions, useLoad } from './ui.jsx';
import { date, money } from '../format.js';

const BRIDGE_URL = 'https://bridge.simplefin.org/';

function AccountRow({ acct, options, canEdit, onSaved, onError }) {
  const [form, setForm] = useState({ accountId: acct.account_id, isEnabled: acct.is_enabled, syncStartDate: acct.sync_start_date || '' });
  const [saving, setSaving] = useState(false);
  const dirty = form.accountId !== acct.account_id || form.isEnabled !== acct.is_enabled || (form.syncStartDate || null) !== (acct.sync_start_date || null);
  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/bank-connections/accounts/${acct.id}`, { ...form, isEnabled: form.isEnabled && Boolean(form.accountId) });
      onSaved(res.sync);
    } catch (err) { onError(err); } finally { setSaving(false); }
  };
  return (
    <tr>
      <td>
        {acct.name || 'Account'}<span className="muted"> · {acct.institution_name}</span>
        <div className="muted small">
          {acct.balance !== null && `Balance ${money(acct.balance)}${acct.balance_date ? ` as of ${new Date(acct.balance_date).toLocaleDateString()}` : ''}`}
          {acct.last_synced_at ? ` · synced ${new Date(acct.last_synced_at).toLocaleString()}` : ''}
        </div>
        {acct.error_message && <div className="warn small">{acct.error_message}</div>}
      </td>
      <td style={{ minWidth: 240 }}>
        {canEdit ? <BankAccountSelect options={options} value={form.accountId} onChange={(v) => setForm({ ...form, accountId: v, isEnabled: v ? form.isEnabled || !acct.account_id : false })} placeholder="Not imported" />
          : acct.ledger_account_name || <span className="muted">Not imported</span>}
      </td>
      <td>{canEdit ? <input type="date" className="input" value={form.syncStartDate || ''} onChange={(e) => setForm({ ...form, syncStartDate: e.target.value })} /> : date(acct.sync_start_date)}</td>
      <td className="center"><input type="checkbox" aria-label="Import transactions" checked={form.isEnabled} disabled={!canEdit || !form.accountId} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /></td>
      <td className="actions nowrap">
        {canEdit && dirty && <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}
      </td>
    </tr>
  );
}

function ConnectDialog({ onClose, onConnected }) {
  const [form, setForm] = useState({ label: '', setupToken: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { onConnected(await api.post('/bank-connections/connections', form)); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Modal title="Connect Banks with SimpleFIN" onClose={onClose} width={560}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="sfin-connect" className="btn btn-primary" disabled={busy || !form.setupToken.trim()}>{busy ? 'Connecting…' : 'Connect'}</button></>}>
      <form id="sfin-connect" onSubmit={submit}>
        <ErrorBanner error={err} onClose={() => setErr(null)} />
        <ol className="small">
          <li>Sign in at the <a href={BRIDGE_URL} target="_blank" rel="noreferrer">SimpleFIN Bridge</a> and connect your banks there.</li>
          <li>Under <strong>Apps</strong>, create a <strong>new connection</strong> and copy the setup token.</li>
          <li>Paste it below. A setup token works only once; it’s exchanged for a private access link that is stored encrypted for this organization.</li>
        </ol>
        <Field label="Name" hint="Optional, e.g. whose SimpleFIN account this is"><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
        <Field label="Setup token" required>
          <textarea className="input" rows={4} value={form.setupToken} onChange={(e) => setForm({ ...form, setupToken: e.target.value })} spellCheck={false} autoComplete="off" />
        </Field>
      </form>
    </Modal>
  );
}

// Shown on the Bank Feed Setup screen.
export default function BankConnections({ onSynced }) {
  const { isOrgAdmin } = useApp();
  const { data, error, reload } = useLoad(() => api.get('/bank-connections/status'), []);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const options = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds);

  if (!data) return error ? <ErrorBanner error={error} /> : null;
  if (!data.configured) {
    return isOrgAdmin ? (
      <div className="alert alert-info">Live bank connections are not set up on this server. Ask your administrator to set ENCRYPTION_KEY (see the README), or import statement files below.</div>
    ) : null;
  }
  const conns = data.connections;
  const accounts = conns.flatMap((c) => c.accounts);
  const attention = conns.some((c) => c.error_message) || accounts.some((a) => a.error_message);

  // Re-read the connection: lists accounts added at SimpleFIN since the last sync, and imports new activity.
  const refresh = async (c) => {
    setRefreshing(c.id); setErr(null);
    try {
      const before = c.accounts.length;
      const r = await api.post(`/bank-connections/connections/${c.id}/sync`);
      const st = await api.get('/bank-connections/status');
      const now = st.connections?.find((x) => x.id === c.id)?.accounts.length ?? before;
      setMsg(r.skipped ? 'A sync is already running.' : `${now > before ? `Found ${now - before} new account${now - before === 1 ? '' : 's'}; choose which ledger account each one feeds. ` : 'No new accounts. '}${r.added ? `Imported ${r.added} new line(s). ` : ''}${r.errors?.length ? `SimpleFIN reported: ${r.errors.join(' · ')}` : ''}`);
      reload(); onSynced?.();
    } catch (e) { setErr(e); reload(); } finally { setRefreshing(null); }
  };
  const remove = async (c) => {
    setConfirm(null);
    try { await api.del(`/bank-connections/connections/${c.id}`); setMsg('Connection removed.'); reload(); } catch (e) { setErr(e); }
  };

  return (
    <section className="card connections">
      <div className="row between wrap gap">
        <div>
          <h3 className="card-title flush">Bank connections</h3>
          <span className="muted small">
            {accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} through SimpleFIN${attention ? ' · needs attention' : ''}` : 'Connect banks through SimpleFIN to import activity automatically'}
          </span>
        </div>
        {isOrgAdmin && <button type="button" className="btn btn-primary btn-sm" onClick={() => setConnecting(true)}><Plus size={15} aria-hidden="true" />Connect bank</button>}
      </div>
      <ErrorBanner error={err} onClose={() => setErr(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      {conns.map((c) => (
        <div key={c.id} className="connection">
          <div className="row between wrap gap">
            <div>
              <strong>{c.label || 'SimpleFIN'}</strong> <span className="muted small">{c.server_host}{c.last_synced_at ? ` · synced ${new Date(c.last_synced_at).toLocaleString()}` : ''}</span>
              {c.error_message && <div className="warn small">{c.error_message}</div>}
            </div>
            <div className="actions nowrap">
              <button type="button" className="btn btn-sm" disabled={refreshing === c.id} title="Look for accounts added at SimpleFIN" onClick={() => refresh(c)}>{refreshing === c.id ? 'Refreshing…' : 'Refresh accounts'}</button>
              {isOrgAdmin && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(c)}>Remove</button>}
            </div>
          </div>
          {c.accounts.length ? (
            <table className="table compact mt">
              <thead><tr><th>Bank account</th><th>Feeds into</th><th>Import from</th><th className="center">Import</th><th /></tr></thead>
              <tbody>
                {c.accounts.map((a) => (
                  <AccountRow key={`${a.id}-${a.account_id}-${a.is_enabled}-${a.sync_start_date}`} acct={a} options={options} canEdit={isOrgAdmin} onError={setErr}
                    onSaved={(s) => { setMsg(s?.error ? `Saved, but the sync failed: ${s.error.message}` : s && !s.skipped ? `Saved. Imported ${s.added} new line(s).` : 'Saved.'); reload(); onSynced?.(); }} />
                ))}
              </tbody>
            </table>
          ) : <p className="muted small">No accounts yet. Connect banks at the SimpleFIN Bridge, then click Refresh accounts.</p>}
        </div>
      ))}
      {!conns.length && <p className="muted small">Bank activity will appear on the Bank Feed under Not Matched. Only posted transactions are imported; pending ones appear once they clear.</p>}
      {accounts.length > 0 && <p className="muted small">SimpleFIN updates bank data about once a day. New activity is checked every few hours; use Sync Now on the Bank Feed to check sooner.</p>}
      {connecting && (
        <ConnectDialog onClose={() => setConnecting(false)}
          onConnected={(r) => {
            setConnecting(false);
            setMsg(`Connected ${r.accounts} account${r.accounts === 1 ? '' : 's'}. Choose which ledger account each one feeds, then Save.${r.errors?.length ? ` SimpleFIN reported: ${r.errors.join(' · ')}` : ''}`);
            reload(); onSynced?.();
          }} />
      )}
      {confirm && (
        <Modal title="Remove Bank Connection" onClose={() => setConfirm(null)} width={460}
          footer={<><button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="btn btn-danger" onClick={() => remove(confirm)}>Remove</button></>}>
          <p>Stop importing from {confirm.label || 'this SimpleFIN connection'} and delete its stored access link? Lines already imported stay in the bank feed.</p>
          <p className="muted small">To fully revoke access, also delete the app connection at the SimpleFIN Bridge.</p>
        </Modal>
      )}
    </section>
  );
}
