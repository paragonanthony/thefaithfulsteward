import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import { api, qs } from '../api.js';
import { useApp } from '../App.jsx';
import { Empty, ErrorBanner, Field, Modal, Page, Tabs, useLoad } from '../components/ui.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

export default function AccountSetup() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'accounts';
  return (
    <Page title="Account & Fund Setup" actions={tab === 'accounts' && <><Link className="btn" to="/advanced/import/accounts"><Upload size={16} aria-hidden="true" />Import</Link><Link className="btn btn-primary" to="/setup/accounts/new"><Plus size={16} aria-hidden="true" />New Account</Link></>}>
      <Tabs tabs={[{ value: 'accounts', label: 'Accounts' }, { value: 'funds', label: 'Funds' }, { value: 'groups', label: 'Account Groups' }, { value: 'checks', label: 'Check Formats' }, { value: 'receipts', label: 'Receipts' }]}
        value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'accounts' && <AccountList />}
      {tab === 'funds' && <FundList />}
      {tab === 'groups' && <GroupList />}
      {tab === 'checks' && <CheckFormatList />}
      {tab === 'receipts' && <ReceiptTemplateList />}
    </Page>
  );
}

function AccountList() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const navigate = useNavigate();
  const { data, error, loading } = useLoad(() => api.get(`/accounts${qs({ search: query })}`), [query]);
  const rows = (data || []).filter((a) => showInactive || a.is_active);
  return (
    <>
      <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
        <input className="input grow" placeholder="Search account number or name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn">Search</button>
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
      </form>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Account Number</th><th>Account Name</th><th>Account Type</th><th>Group</th><th>Default Fund</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} onClick={() => navigate(`/setup/accounts/${a.id}`)} className={a.is_active ? '' : 'inactive'}>
                <td>{a.account_number}</td>
                <td>{a.name}{a.is_undeposited_funds && <span className="badge">Undeposited Funds</span>}{!a.is_active && <span className="badge">Inactive</span>}</td>
                <td>{a.account_type_label}</td><td>{a.group_name}</td><td>{a.default_fund_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length && <Empty>No accounts found.</Empty>}
      </div>
    </>
  );
}

/** Generic list + modal editor used for funds and account groups. */
function SimpleList({ endpoint, columns, blank, renderForm, title, auditTable }) {
  const { reloadLookups } = useApp();
  const { data, error, reload } = useLoad(() => api.get(endpoint), [endpoint]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null);
    try {
      if (edit.id) await api.put(`${endpoint}/${edit.id}`, edit); else await api.post(endpoint, edit);
      setEdit(null); reload(); reloadLookups();
    } catch (e) { setErr(e); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this item?')) return;
    try { await api.del(`${endpoint}/${edit.id}`); setEdit(null); reload(); reloadLookups(); } catch (e) { setErr(e); }
  };
  return (
    <>
      <div className="row end mb"><button type="button" className="btn btn-primary" onClick={() => { setErr(null); setEdit({ ...blank }); }}><Plus size={16} aria-hidden="true" />New {title}</button></div>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}</tr></thead>
          <tbody>
            {data?.map((row) => (
              <tr key={row.id} onClick={() => { setErr(null); setEdit({ ...row }); }}>
                {columns.map((c) => <td key={c.label}>{c.render(row)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Nothing here yet.</Empty>}
      </div>
      {edit && (
        <Modal title={`${edit.id ? 'Edit' : 'New'} ${title}`} onClose={() => setEdit(null)} width={480}
          footer={<>
            {edit.id && <button type="button" className="btn btn-danger" onClick={remove}>Delete</button>}
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <ErrorBanner error={err} />
          <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>{renderForm(edit, setEdit)}<button hidden /></form>
          {edit.id && <AuditInfo table={auditTable} id={edit.id} />}
        </Modal>
      )}
    </>
  );
}

function FundList() {
  return (
    <SimpleList endpoint="/funds" auditTable="funds" title="Fund" blank={{ name: '', description: '', is_restricted: false, is_active: true }}
      columns={[
        { label: 'Fund Name', render: (f) => <>{f.name}{!f.is_active && <span className="badge">Inactive</span>}</> },
        { label: 'Restriction', render: (f) => (f.is_restricted ? 'With donor restrictions' : 'Without donor restrictions') },
        { label: 'Description', render: (f) => f.description },
      ]}
      renderForm={(f, set) => (
        <>
          <Field label="Fund Name" required><input className="input" autoFocus value={f.name} onChange={(e) => set({ ...f, name: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={f.description || ''} onChange={(e) => set({ ...f, description: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={f.is_restricted} onChange={(e) => set({ ...f, is_restricted: e.target.checked })} /> Donor restricted</label>
          <label className="check"><input type="checkbox" checked={f.is_active} onChange={(e) => set({ ...f, is_active: e.target.checked })} /> Active</label>
        </>
      )} />
  );
}

function GroupList() {
  const { lookups } = useApp();
  const types = lookups?.accountTypes || [];
  const label = (k) => types.find((t) => t.key === k)?.label || k;
  return (
    <SimpleList endpoint="/account-groups" auditTable="account_groups" title="Account Group" blank={{ name: '', account_type: 'expense', sort_order: 0 }}
      columns={[
        { label: 'Group Name', render: (g) => g.name },
        { label: 'Account Type', render: (g) => label(g.account_type) },
        { label: 'Sort Order', render: (g) => g.sort_order },
      ]}
      renderForm={(g, set) => (
        <>
          <Field label="Group Name" required><input className="input" autoFocus value={g.name} onChange={(e) => set({ ...g, name: e.target.value })} /></Field>
          <Field label="Account Type" required>
            <select className="input" value={g.account_type} onChange={(e) => set({ ...g, account_type: e.target.value })}>
              {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Sort Order" hint="Controls the order groups appear in reports"><input className="input" type="number" value={g.sort_order} onChange={(e) => set({ ...g, sort_order: e.target.value })} /></Field>
        </>
      )} />
  );
}

function CheckFormatList() {
  const { isOrgAdmin } = useApp();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => api.get('/check-formats'), []);
  return (
    <>
      <div className="row between mb">
        <p className="muted flush">Layouts used when printing checks from the Expense screen. Assign a format to a bank account (on the account) when it uses different check stock.</p>
        {isOrgAdmin && <Link className="btn btn-primary" to="/setup/check-formats/new"><Plus size={16} aria-hidden="true" />New Check Format</Link>}
      </div>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Format</th><th>Check position</th><th>Stubs</th><th>Used by bank accounts</th></tr></thead>
          <tbody>
            {data?.map((f) => (
              <tr key={f.id} onClick={() => navigate(`/setup/check-formats/${f.id}`)}>
                <td>{f.name}{f.is_default && <span className="badge ok">Default</span>}</td>
                <td>{{ top: 'Top', middle: 'Middle', bottom: 'Bottom' }[f.layout.checkPosition]}</td>
                <td>{f.layout.stubs}</td>
                <td>{f.accounts.length ? f.accounts.join(', ') : <span className="muted">{f.is_default ? 'All others' : '—'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ReceiptTemplateList() {
  const { isOrgAdmin } = useApp();
  const navigate = useNavigate();
  const { data, error } = useLoad(() => api.get('/receipt-templates'), []);
  return (
    <>
      <div className="row between mb">
        <p className="muted flush">Templates used for <strong>Print Receipt</strong> on the Record Income screen. The default is used unless another is chosen when printing.</p>
        {isOrgAdmin && <Link className="btn btn-primary" to="/setup/receipts/new"><Plus size={16} aria-hidden="true" />New Receipt Template</Link>}
      </div>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Template</th><th>Title</th><th>Logo</th><th>Itemized</th></tr></thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.id} onClick={() => navigate(`/setup/receipts/${t.id}`)}>
                <td>{t.name}{t.is_default && <span className="badge ok">Default</span>}</td>
                <td>{t.template.title}</td>
                <td>{t.template.logo ? 'Yes' : <span className="muted">—</span>}</td>
                <td>{t.template.showLines ? 'Yes' : 'Total only'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
