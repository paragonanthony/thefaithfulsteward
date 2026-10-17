import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';

export default function SelectOrg({ embedded }) {
  const { me, refresh } = useApp();
  const navigate = useNavigate();
  const choose = async (id) => {
    await api.post('/auth/select-org', { organizationId: id });
    await refresh();
    navigate('/');
  };
  const logout = async () => { await api.post('/auth/logout'); window.location.href = '/'; };
  const content = (
    <div className="card org-card">
      <h1>Welcome {me.user.display_name}</h1>
      {me.organizations.length ? (
        <>
          <p className="muted">Please select your organization</p>
          <div className="org-list">
            {me.organizations.map((o) => (
              <button key={o.id} type="button" className={`org-choice${me.currentOrganization?.id === o.id ? ' current' : ''}`} onClick={() => choose(o.id)}>
                <span>{o.name}</span><span className="muted small">{o.role === 'admin' ? 'Administrator' : 'User'}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">You are not assigned to any organizations yet. Ask an administrator to add you.</p>
      )}
      <div className="row gap mt">
        {me.user.is_system_admin && <Link className="btn" to="/admin/organizations">Manage organizations</Link>}
        {!embedded && <button type="button" className="btn btn-ghost" onClick={logout}>Sign out</button>}
      </div>
    </div>
  );
  return embedded ? <div className="page">{content}</div> : <div className="center-screen">{content}</div>;
}
