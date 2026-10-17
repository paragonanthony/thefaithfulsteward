import React, { useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, Field, Page } from '../components/ui.jsx';
import ConnectedApps from '../components/ConnectedApps.jsx';

export default function Account() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (f.newPassword !== f.confirm) { setError('The new passwords do not match'); return; }
    try {
      await api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      setDone(true);
      setF({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err) { setError(err); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Page title="My Account">
      <ErrorBanner error={error} />
      {done && <div className="alert alert-info">Your password has been changed.</div>}
      <form className="card form narrow" onSubmit={save}>
        <h3 className="card-title">Change password</h3>
        <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={f.currentPassword} onChange={set('currentPassword')} /></Field>
        <Field label="New password" hint="At least 8 characters"><input className="input" type="password" autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} /></Field>
        <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></Field>
        <div className="form-actions"><button className="btn btn-primary">Change password</button></div>
      </form>
      <ConnectedApps />
    </Page>
  );
}
