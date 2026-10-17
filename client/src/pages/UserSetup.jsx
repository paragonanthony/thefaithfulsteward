import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Modal, Page, useLoad } from '../components/ui.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

export default function UserSetup() {
  const { me, isOrgAdmin } = useApp();
  const { data, error, reload } = useLoad(() => api.get('/admin/users'), []);
  const [edit, setEdit] = useState(null);
  const [pw, setPw] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  if (!isOrgAdmin) return <Page title="User Setup"><div className="alert alert-warn">Only organization administrators can manage users.</div></Page>;

  const save = async () => {
    setErr(null);
    try {
      if (edit.id) await api.put(`/admin/users/${edit.id}`, { displayName: edit.display_name, email: edit.email, role: edit.role, isActive: edit.is_active, isSystemAdmin: edit.is_system_admin, mustChangePassword: edit.must_change_password, apiAccess: Boolean(edit.api_access) });
      else {
        const r = await api.post('/admin/users', { username: edit.username, displayName: edit.display_name, email: edit.email, password: edit.password, role: edit.role, isSystemAdmin: edit.is_system_admin, mustChangePassword: edit.must_change_password, apiAccess: Boolean(edit.api_access) });
        if (r.existing) setMsg(`"${edit.username}" already had an account and has been added to this organization.`);
      }
      setEdit(null); reload();
    } catch (e) { setErr(e); }
  };
  const resetPw = async () => {
    setErr(null);
    try {
      await api.post(`/admin/users/${pw.id}/reset-password`, { password: pw.password, mustChangePassword: pw.mustChange });
      setPw(null); setMsg(pw.mustChange ? `Password updated. ${pw.name} will be asked to choose a new one at the next sign-in.` : 'Password updated.'); reload();
    } catch (e) { setErr(e); }
  };
  const removeUser = async () => {
    if (!window.confirm(`Remove ${edit.display_name} from ${me.currentOrganization.name}? Their account is kept, but they will no longer have access to this organization.`)) return;
    try { await api.del(`/admin/users/${edit.id}`); setEdit(null); reload(); } catch (e) { setErr(e); }
  };

  return (
    <Page title="User Setup" subtitle={`Users with access to ${me.currentOrganization.name}`}
      actions={<button type="button" className="btn btn-primary" onClick={() => { setErr(null); setEdit({ username: '', display_name: '', email: '', password: '', role: 'user', is_active: true, is_system_admin: false, must_change_password: true, api_access: false }); }}><Plus size={16} aria-hidden="true" />Add User</button>}>
      <ErrorBanner error={error} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Name</th><th>User Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id} onClick={() => { setErr(null); setEdit({ ...u }); }} className={u.is_active ? '' : 'inactive'}>
                <td>{u.display_name}{u.id === me.user.id && <span className="badge">You</span>}</td>
                <td>{u.username}</td>
                <td>{u.email}</td>
                <td>{u.role === 'admin' ? 'Administrator' : 'User'}{u.is_system_admin && <span className="badge">System admin</span>}</td>
                <td>{u.is_active ? 'Active' : 'Inactive'}{u.must_change_password && <span className="badge warn" title="Will be asked to choose a new password at the next sign-in">Must change password</span>}{u.api_access && <span className="badge ok" title="Can use the API and MCP server">API / MCP</span>}</td>
                <td className="actions"><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setErr(null); setPw({ id: u.id, name: u.display_name, password: '', mustChange: true }); }}>Reset password</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <Modal title={edit.id ? `Edit ${edit.display_name}` : 'Add User'} onClose={() => setEdit(null)} width={520}
          footer={<>
            {edit.id && edit.id !== me.user.id && <button type="button" className="btn btn-danger" onClick={removeUser}>Remove from organization</button>}
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <ErrorBanner error={err} />
          <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
            {!edit.id && <Field label="User Name" required hint="If this user name already exists, that person is added to this organization."><input className="input" autoFocus value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} autoComplete="off" /></Field>}
            <Field label="Display Name"><input className="input" value={edit.display_name} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" type="email" value={edit.email || ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            {!edit.id && <Field label="Password" hint="At least 8 characters (new users only)"><input className="input" type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} autoComplete="new-password" /></Field>}
            <Field label="Role">
              <select className="input" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                <option value="user">User — record transactions and run reports</option>
                <option value="admin">Administrator — also manage users and settings</option>
              </select>
            </Field>
            {edit.id && <label className="check"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active (can sign in)</label>}
            <label className="check"><input type="checkbox" checked={Boolean(edit.must_change_password)} onChange={(e) => setEdit({ ...edit, must_change_password: e.target.checked })} />
              {' '}{edit.id ? 'Require a password change at the next sign-in' : 'Require a password change at first sign-in'}</label>
            <label className="check"><input type="checkbox" checked={Boolean(edit.api_access)} onChange={(e) => setEdit({ ...edit, api_access: e.target.checked })} />
              {' '}API and MCP access <span className="muted small">— can connect apps and AI assistants with their sign-in (turning it off disconnects them)</span></label>
            {me.user.is_system_admin && <label className="check"><input type="checkbox" checked={edit.is_system_admin} onChange={(e) => setEdit({ ...edit, is_system_admin: e.target.checked })} /> System administrator (can create organizations)</label>}
            <button hidden />
          </form>
          {edit.id && <AuditInfo table="users" id={edit.id} />}
        </Modal>
      )}
      {pw && (
        <Modal title={`Reset password for ${pw.name}`} onClose={() => setPw(null)} width={440}
          footer={<><button type="button" className="btn" onClick={() => setPw(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={resetPw}>Set password</button></>}>
          <ErrorBanner error={err} />
          <form onSubmit={(e) => { e.preventDefault(); resetPw(); }}>
            <Field label="New password" hint="At least 8 characters"><input className="input" type="password" autoFocus value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" /></Field>
            <label className="check"><input type="checkbox" checked={pw.mustChange} onChange={(e) => setPw({ ...pw, mustChange: e.target.checked })} /> Require a password change at the next sign-in</label>
          </form>
        </Modal>
      )}
    </Page>
  );
}
