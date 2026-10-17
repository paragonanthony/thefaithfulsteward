import React, { useEffect, useState } from 'react';
import { api, qs } from '../api.js';

/**
 * OAuth approval: an app (e.g. an AI assistant using the MCP server) asks to use The Faithful Steward as the signed-in
 * user. Shown after the normal sign-in; approving sends the user back to the app with a one-time code.
 */
export default function ConnectApp() {
  const params = Object.fromEntries(new URLSearchParams(window.location.search));
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/oauth/authorize-info${qs({ client_id: params.client_id, redirect_uri: params.redirect_uri })}`).then(setInfo).catch(setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve) => {
    setBusy(true); setError(null);
    try {
      const r = await api.post(approve ? '/oauth/approve' : '/oauth/deny', params);
      window.location.assign(r.redirect);
    } catch (e) { setError(e); setBusy(false); }
  };

  return (
    <div className="center-screen">
      <div className="card login-card connect-card">
        <div className="login-brand"><img className="login-logo" src="/logo.png" alt="The Faithful Steward" /></div>
        {error && <div className="alert alert-error">{error.message || String(error)}</div>}
        {!info && !error && <p className="muted">Loading…</p>}
        {info && (
          <>
            <h2 className="flush">Allow {info.clientName} to use your account?</h2>
            <p className="flush">
              <strong>{info.clientName}</strong> will be able to see and change the same information you can as <strong>{info.user}</strong>, in
              {info.organizations.length === 1 ? ' your organization:' : ' all of your organizations:'}
            </p>
            <ul className="flush">{info.organizations.map((o) => <li key={o.name}>{o.name}{o.role === 'admin' ? ' (administrator)' : ''}</li>)}</ul>
            <p className="muted small flush">
              It returns to <strong>{info.returnsTo}</strong>. Only allow apps you trust. You can disconnect it at any time under your account’s Connected apps.
            </p>
            <div className="row gap">
              <button type="button" className="btn btn-primary grow" disabled={busy} onClick={() => decide(true)}>Allow</button>
              <button type="button" className="btn grow" disabled={busy} onClick={() => decide(false)}>Deny</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
