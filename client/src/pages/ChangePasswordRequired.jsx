import React, { useState } from 'react';
import { api } from '../api.js';

/** Shown instead of the app when an administrator requires the user to choose a new password. */
export default function ChangePasswordRequired({ me, onDone }) {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (f.newPassword !== f.confirm) { setError('The new passwords do not match'); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      await onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const signOut = async () => { try { await api.post('/auth/logout'); } finally { window.location.assign('/'); } };
  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand"><span className="brand-mark lg"><img src="/logo-mark.png" alt="" /></span><h1>Choose a new password</h1></div>
        <p className="muted">Hi {me.user.display_name}. Your administrator asks you to choose a new password before you continue.</p>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field"><span className="field-label">Current password</span>
          <input className="input" type="password" autoFocus autoComplete="current-password" value={f.currentPassword} onChange={set('currentPassword')} />
        </label>
        <label className="field"><span className="field-label">New password</span>
          <input className="input" type="password" autoComplete="new-password" value={f.newPassword} onChange={set('newPassword')} />
          <span className="field-hint">At least 8 characters, different from your current password</span>
        </label>
        <label className="field"><span className="field-label">Confirm new password</span>
          <input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy || !f.currentPassword || !f.newPassword || !f.confirm}>{busy ? 'Saving…' : 'Change password and continue'}</button>
        <button type="button" className="btn btn-ghost btn-block" onClick={signOut}>Sign out</button>
      </form>
    </div>
  );
}
