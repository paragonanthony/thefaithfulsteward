import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, Modal } from './ui.jsx';

/** System administrators: permanently delete an organization and all of its data, after typing its name. */
export default function DeleteOrganization({ orgId, onClose, onDeleted }) {
  const [info, setInfo] = useState(null);
  const [typed, setTyped] = useState('');
  const [deleteUsers, setDeleteUsers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/admin/organizations/${orgId}/delete-preview`).then(setInfo).catch(setError); }, [orgId]);
  const matches = info && typed.trim().toLowerCase() === info.name.trim().toLowerCase();
  const run = async () => {
    setBusy(true); setError(null);
    try { onDeleted(await api.del(`/admin/organizations/${orgId}`, { confirmName: typed, keepUsers: !deleteUsers })); } catch (e) { setError(e); setBusy(false); }
  };
  const n = (v) => Number(v || 0).toLocaleString();
  return (
    <Modal title="Delete Organization" onClose={busy ? () => {} : onClose} width={540}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={!matches || busy} onClick={run}>{busy ? 'Deleting…' : 'Delete everything'}</button></>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {!info ? (!error && <p className="muted">Loading…</p>) : (
        <>
          <div className="alert alert-error">
            <div>
              <strong>This permanently deletes {info.name} and all of its data.</strong> It can’t be undone. Consider exporting reports first.
            </div>
          </div>
          <ul className="flush">
            <li>{n(info.counts.transactions)} transactions and their general ledger entries</li>
            <li>{n(info.counts.accounts)} accounts, its funds, budgets and reports</li>
            <li>{n(info.counts.companies)} customers, donors and vendors</li>
            <li>{n(info.counts.attachments)} attachments and {n(info.counts.bankFeedLines)} bank feed lines, plus bank connections, rules and settings</li>
            <li>{n(info.counts.users)} user{info.counts.users === 1 ? ' loses' : 's lose'} access to it</li>
          </ul>
          {info.usersOnlyHere.length > 0 && (
            <label className="check mt">
              <input type="checkbox" checked={deleteUsers} onChange={(e) => setDeleteUsers(e.target.checked)} />
              Also delete the {info.usersOnlyHere.length} user account{info.usersOnlyHere.length === 1 ? '' : 's'} that only belong{info.usersOnlyHere.length === 1 ? 's' : ''} to this organization
              <span className="muted small"> ({info.usersOnlyHere.map((u) => u.display_name || u.username).join(', ')})</span>
            </label>
          )}
          <label className="field mt">
            <span className="field-label">Type <strong>{info.name}</strong> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
          </label>
        </>
      )}
    </Modal>
  );
}
