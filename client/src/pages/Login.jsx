import React, { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { username, password });
      await onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand"><img className="login-logo" src="/logo.png" alt="The Faithful Steward" /></div>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field"><span className="field-label">User Name</span>
          <input className="input" autoFocus autoComplete="username" placeholder="enter username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field"><span className="field-label">Password</span>
          <input className="input" type="password" autoComplete="current-password" placeholder="enter password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Login'}</button>
      </form>
    </div>
  );
}
