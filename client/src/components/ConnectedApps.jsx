import React, { useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, useLoad } from './ui.jsx';
import { useApp } from '../App.jsx';

/** Account: how to connect apps (MCP server and REST API), and the apps connected with this user's sign-in. */
export default function ConnectedApps() {
  const { data, error, reload } = useLoad(() => api.get('/oauth/connections'), []);
  const [err, setErr] = useState(null);
  const origin = window.location.origin;
  const { me } = useApp();
  if (me?.user && !me.user.api_access) {
    return (
      <section className="card form narrow">
        <h3 className="card-title">Connected apps</h3>
        <p className="muted small flush">API and MCP access is turned off for your account, so apps and AI assistants can’t connect with your sign-in. An organization administrator can turn it on under User Setup.</p>
      </section>
    );
  }
  const disconnect = async (c) => {
    if (!window.confirm(`Disconnect ${c.client_name}? It will need you to sign in again to use your account.`)) return;
    try { await api.del(`/oauth/connections/${encodeURIComponent(c.client_id)}`); reload(); } catch (e) { setErr(e); }
  };
  return (
    <section className="card form narrow">
      <h3 className="card-title">Connected apps</h3>
      <p className="muted small flush">
        AI assistants and other programs can use The Faithful Steward with your sign-in. They see and change exactly what you can here,
        in the same organizations and with the same permissions.
      </p>
      <ul className="small flush import-notes">
        <li><strong>MCP server</strong> (Claude and other AI assistants): add <code>{origin}/mcp</code> as a custom connector or remote MCP server. You’ll be asked to sign in and approve it.</li>
        <li><strong>REST API</strong>: get a token from <code>{origin}/oauth/token</code> (sign in with <code>grant_type=password</code>, or the OAuth flow), then call <code>{origin}/api/…</code> with <code>Authorization: Bearer &lt;token&gt;</code> and, if you belong to more than one organization, <code>X-Organization-Id</code>.</li>
      </ul>
      <ErrorBanner error={error || err} onClose={() => setErr(null)} />
      {data && (data.length ? (
        <table className="table compact mt">
          <thead><tr><th>App</th><th>Connected</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.client_id}>
                <td>{c.client_name}</td>
                <td>{new Date(c.connected_at).toLocaleDateString()}</td>
                <td>{c.last_used_at ? new Date(c.last_used_at).toLocaleString() : '—'}</td>
                <td className="actions"><button type="button" className="btn btn-sm btn-ghost" onClick={() => disconnect(c)}>Disconnect</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted small">No apps are connected.</p>)}
    </section>
  );
}
