import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Modal, Page, useLoad } from '../components/ui.jsx';
import DeleteOrganization from '../components/DeleteOrganization.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function Organizations() {
  const { me, refresh } = useApp();
  const { data, error, reload } = useLoad(() => api.get('/admin/organizations'), []);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const [deleting, setDeleting] = useState(null); // organization id
  const [msg, setMsg] = useState(null);
  if (!me.user.is_system_admin) return <Page title="Organizations"><div className="alert alert-warn">System administrator access is required.</div></Page>;

  const save = async () => {
    setErr(null);
    try {
      if (edit.id) await api.put(`/admin/organizations/${edit.id}`, { name: edit.name });
      else {
        const org = await api.post('/admin/organizations', { name: edit.name, fiscalYearStartMonth: edit.fy, defaultChart: edit.defaultChart });
        await api.post('/auth/select-org', { organizationId: org.id });
      }
      setEdit(null);
      reload();
      await refresh();
    } catch (e) { setErr(e); }
  };

  return (
    <Page title="Organizations" subtitle="Each organization keeps its own accounts, funds, names, transactions and reports."
      actions={<button type="button" className="btn btn-primary" onClick={() => { setErr(null); setEdit({ name: '', fy: 1, defaultChart: true }); }}><Plus size={16} aria-hidden="true" />New Organization</button>}>
      <ErrorBanner error={error} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Name</th><th>Fiscal year starts</th><th>Users</th><th>Created</th></tr></thead>
          <tbody>
            {data?.map((o) => (
              <tr key={o.id} onClick={() => { setErr(null); setEdit({ id: o.id, name: o.name }); }}>
                <td>{o.name}{!me.organizations.some((m) => m.id === o.id) && <span className="badge">Not a member</span>}</td>
                <td>{MONTHS[o.fiscal_year_start_month - 1]}</td><td>{o.user_count}</td><td>{String(o.created_at).slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">You become an administrator of organizations you create. To work in an existing organization you are not a member of, ask one of its administrators to add you under User Setup.</p>
      {edit && (
        <Modal title={edit.id ? 'Rename Organization' : 'New Organization'} onClose={() => setEdit(null)} width={500}
          footer={<>
            {edit.id && <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => { setDeleting(edit.id); setEdit(null); }}>Delete organization…</button>}
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={!edit.name.trim()}>Save</button>
          </>}>
          <ErrorBanner error={err} />
          <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Field label="Organization name" required><input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            {!edit.id && (
              <>
                <Field label="Fiscal year starts in">
                  <select className="input" value={edit.fy} onChange={(e) => setEdit({ ...edit, fy: Number(e.target.value) })}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </Field>
                <label className="check"><input type="checkbox" checked={edit.defaultChart} onChange={(e) => setEdit({ ...edit, defaultChart: e.target.checked })} /> Start with a standard non-profit chart of accounts</label>
              </>
            )}
            <button hidden />
          </form>
        </Modal>
      )}
      {deleting && (
        <DeleteOrganization orgId={deleting} onClose={() => setDeleting(null)}
          onDeleted={async (r) => {
            setDeleting(null);
            setMsg(`Deleted ${r.deleted} and all of its data${r.deletedUsers ? `, and ${r.deletedUsers} user account${r.deletedUsers === 1 ? '' : 's'} that only belonged to it` : ''}${r.deactivatedUsers ? ` (${r.deactivatedUsers} account${r.deactivatedUsers === 1 ? ' was' : 's were'} deactivated instead because ${r.deactivatedUsers === 1 ? 'it is' : 'they are'} still referenced elsewhere)` : ''}.`);
            reload();
            await refresh();
          }} />
      )}
    </Page>
  );
}
