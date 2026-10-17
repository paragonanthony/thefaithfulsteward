import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Empty, ErrorBanner, Field, Page, Tabs } from '../components/ui.jsx';
import { downloadCsv } from '../components/ReportTable.jsx';
import { autoMap, readTableFile } from '../components/importFile.js';

// Import customers / vendors or the chart of accounts from a CSV or Excel file: map the columns, check, then import.
const KINDS = {
  companies: {
    title: 'Import Customers & Vendors',
    noun: ['name', 'names'],
    back: { to: '/companies', label: 'Customers, Donors & Vendors' },
    fields: [
      { key: 'name', label: 'Name', required: true, aliases: ['name', 'customer', 'vendor', 'customer/vendor', 'company', 'display name', 'donor', 'payee'] },
      { key: 'address1', label: 'Address 1', aliases: ['address 1', 'address', 'address line 1', 'street', 'billing address'] },
      { key: 'address2', label: 'Address 2', aliases: ['address 2', 'address line 2'] },
      { key: 'city', label: 'City', aliases: ['city', 'town'] },
      { key: 'state', label: 'State', aliases: ['state', 'province', 'region'] },
      { key: 'postal', label: 'Postal', aliases: ['postal', 'zip', 'zip code', 'postal code'] },
      { key: 'phone', label: 'Phone', aliases: ['phone', 'phone 1', 'phone number', 'telephone'] },
      { key: 'phone2', label: 'Phone 2', aliases: ['phone 2', 'mobile', 'cell', 'alt phone'] },
      { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address'] },
      { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments'] },
      { key: 'defaultIncomeAccount', label: 'Default Income Account', aliases: ['default income account', 'income account'] },
      { key: 'defaultExpenseAccount', label: 'Default Expense Account', aliases: ['default expense account', 'expense account'] },
      { key: 'active', label: 'Active', aliases: ['active', 'status'] },
    ],
    notes: [
      'Default Income / Expense Account are matched to your chart of accounts by name or number, and must be income / expense accounts.',
      'Active is Yes or No (blank means Yes for new names).',
    ],
    template: [
      ['Jane Smith', '12 Elm St', '', 'Springfield', 'IL', '62701', '217-555-0101', '', 'jane@example.org', 'Monthly donor', 'Individual Contributions', '', 'Yes'],
      ['Office Depot', '', '', '', '', '', '', '', '', '', '', 'Office Supplies', 'Yes'],
    ],
    columns: (p) => [p.name, [p.address1, p.city, p.state, p.postal].filter(Boolean).join(', '), p.phone1, p.email, p.defaultIncomeAccount, p.defaultExpenseAccount, p.is_active === false ? 'No' : p.is_active ? 'Yes' : ''],
    headings: ['Name', 'Address', 'Phone', 'Email', 'Default Income', 'Default Expense', 'Active'],
  },
  accounts: {
    title: 'Import Chart of Accounts',
    noun: ['account', 'accounts'],
    back: { to: '/setup', label: 'Accounts & Funds' },
    fields: [
      { key: 'number', label: 'Account Number', aliases: ['account number', 'number', 'acct no', 'account no', 'account #', 'acct #', 'code'] },
      { key: 'name', label: 'Account Name', required: true, aliases: ['account name', 'name', 'account', 'full name'] },
      { key: 'type', label: 'Account Type', required: true, aliases: ['account type', 'type', 'category'] },
      { key: 'description', label: 'Description', aliases: ['description', 'detail type', 'notes'] },
      { key: 'group', label: 'Account Group', aliases: ['account group', 'group', 'subtype'] },
      { key: 'fund', label: 'Default Fund', aliases: ['default fund', 'fund'] },
      { key: 'active', label: 'Active', aliases: ['active', 'status'] },
      { key: 'undeposited', label: 'Undeposited Funds', aliases: ['undeposited funds', 'undeposited'] },
    ],
    notes: [
      'Account Type can be any of the app’s types (Bank, Current Asset, Fixed Asset, Accounts Payable, Credit Card, Line of Credit, Current Liability, Loan, Long Term Liability, Equity, Income, Other Income, Expense, Other Expense) or common names from other systems such as Other Current Asset, Accounts Receivable, Revenue or Cost of Goods Sold.',
      'An existing account is matched by account number, or by name when there’s no number. Its type can’t be changed.',
      'Account Groups that don’t exist yet are created. Default Fund must be an existing fund. Active and Undeposited Funds are Yes or No.',
    ],
    template: [
      ['1020', 'Payroll Checking', 'Bank', 'Payroll account', '', '', 'Yes', 'No'],
      ['4150', 'Foundation Grants', 'Income', '', 'Grants', 'General Fund', 'Yes', ''],
      ['6100', 'Fuel', 'Expense', 'Vehicle fuel', 'Vehicle', '', 'Yes', ''],
    ],
    columns: (p) => [p.number, p.name, p.typeLabel, p.group, p.fund, p.isActive === false ? 'No' : p.isActive ? 'Yes' : '', p.description],
    headings: ['Number', 'Name', 'Type', 'Group', 'Default Fund', 'Active', 'Description'],
  },
};

const STATUS = {
  create: { label: 'New', cls: 'ok' }, update: { label: 'Update', cls: 'ok' }, skip: { label: 'Already exists', cls: '' }, error: { label: 'Error', cls: 'neg' },
};

export default function ImportList({ kind }) {
  const k = KINDS[kind];
  const { reloadLookups } = useApp();
  const [file, setFile] = useState(null); // { name, rows }
  const [hasHeader, setHasHeader] = useState(true);
  const [map, setMap] = useState({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const onFile = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setError(null); setPreview(null); setDone(null);
    try {
      const rows = await readTableFile(f);
      setFile({ name: f.name, rows });
      setHasHeader(true);
      setMap(autoMap(k.fields, rows[0]));
    } catch (err) { setError(err); setFile(null); }
  };

  const header = file ? (hasHeader ? file.rows[0] : file.rows[0].map((_, i) => `Column ${i + 1}`)) : [];
  const dataRows = file ? file.rows.slice(hasHeader ? 1 : 0) : [];
  const missing = k.fields.filter((f) => f.required && !(map[f.key] >= 0));
  const records = useMemo(() => dataRows.map((r) => Object.fromEntries(k.fields.map((f) => [f.key, map[f.key] >= 0 ? r[map[f.key]] ?? '' : '']))), [dataRows, map, k]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async (upd = updateExisting) => {
    setBusy('check'); setError(null); setDone(null);
    try { setPreview(await api.post(`/import/lists/${kind}/preview`, { rows: records, updateExisting: upd })); setFilter('all'); } catch (err) { setError(err); } finally { setBusy(null); }
  };
  const runImport = async () => {
    setBusy('import'); setError(null);
    try {
      const r = await api.post(`/import/lists/${kind}`, { rows: records, updateExisting });
      setDone(r); setFile(null); setPreview(null);
      await reloadLookups?.(); // the new names / accounts appear in the pickers
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const shown = (preview?.results || []).filter((r) => filter === 'all' || r.status === filter);
  const willSave = preview ? preview.summary.create + preview.summary.update : 0;
  const [one, many] = k.noun;

  return (
    <Page title={k.title} subtitle={<Link to={k.back.to}>{k.back.label}</Link>} wide
      actions={<button type="button" className="btn" onClick={() => downloadCsv(`${kind === 'companies' ? 'customers-vendors' : 'chart-of-accounts'}-import-template.csv`, [k.fields.map((f) => f.label), ...k.template])}>Download template</button>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {done && (
        <div className="alert alert-info">
          Created {done.created} {done.created === 1 ? one : many}{done.updated ? `, updated ${done.updated}` : ''}{done.skipped ? `, left ${done.skipped} existing ${done.skipped === 1 ? one : many} as they were` : ''}{done.errors ? `; skipped ${done.errors} row(s) with errors` : ''}.
          {' '}<Link to={k.back.to}>View {k.back.label}</Link>
          <button type="button" className="link" onClick={() => setDone(null)}>✕</button>
        </div>
      )}

      <section className="card form">
        <p className="flush">
          Import {many} from a <strong>CSV</strong> or <strong>Excel (.xlsx)</strong> file, one per row. Columns: {k.fields.map((f) => f.label).join(', ')}.
          {' '}Only {k.fields.filter((f) => f.required).map((f) => f.label).join(' and ')} {k.fields.filter((f) => f.required).length > 1 ? 'are' : 'is'} required.
        </p>
        <ul className="muted small flush import-notes">
          {k.notes.map((n) => <li key={n}>{n}</li>)}
          <li>Matching ignores capitals and extra spaces. Rows for {many} that already exist are left alone unless you tick <strong>Update existing records</strong>; then the cells that have a value replace what’s there.</li>
          <li>Nothing is saved until you review the check and click Import.</li>
        </ul>
        <div className="row gap wrap">
          <label className="btn btn-primary">Choose file…<input type="file" accept=".csv,.xlsx,text/csv" hidden onChange={onFile} /></label>
          {file && <span><strong>{file.name}</strong> · {dataRows.length} row{dataRows.length === 1 ? '' : 's'}</span>}
        </div>
      </section>

      {file && (
        <section className="card form">
          <div className="row between wrap gap">
            <h3 className="card-title flush">Columns</h3>
            <label className="check"><input type="checkbox" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); setPreview(null); }} /> First row is a header</label>
          </div>
          <div className="grid g4">
            {k.fields.map((f) => (
              <Field key={f.key} label={f.label} required={f.required}>
                <select className={`input${f.required && !(map[f.key] >= 0) ? ' input-missing' : ''}`} value={map[f.key] ?? -1}
                  onChange={(e) => { setMap({ ...map, [f.key]: Number(e.target.value) }); setPreview(null); }}>
                  <option value={-1}>{f.required ? '— choose a column —' : '(not in file)'}</option>
                  {header.map((h, i) => <option key={i} value={i}>{String(h || `Column ${i + 1}`)}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <label className="check mt">
            <input type="checkbox" checked={updateExisting} onChange={(e) => { setUpdateExisting(e.target.checked); if (preview) check(e.target.checked); }} />
            Update existing records <span className="muted small">— otherwise {many} that already exist are left as they are</span>
          </label>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={missing.length > 0 || busy} onClick={() => check()}>{busy === 'check' ? 'Checking…' : 'Check file'}</button>
            {missing.length > 0 && <span className="warn small">Choose a column for {missing.map((f) => f.label).join(', ')}.</span>}
          </div>
        </section>
      )}

      {preview && (
        <section className="card">
          <div className="stat-row">
            <div className="stat"><span>New</span><strong className="ok">{preview.summary.create}</strong></div>
            <div className="stat"><span>Updates</span><strong>{preview.summary.update}</strong></div>
            <div className="stat"><span>Already exist</span><strong>{preview.summary.skip}</strong></div>
            <div className="stat"><span>Errors</span><strong className={preview.summary.errors ? 'neg' : ''}>{preview.summary.errors}</strong></div>
          </div>
          <Tabs value={filter} onChange={setFilter} tabs={[
            { value: 'all', label: 'All rows', count: preview.summary.total },
            { value: 'create', label: 'New', count: preview.summary.create },
            ...(preview.summary.update ? [{ value: 'update', label: 'Updates', count: preview.summary.update }] : []),
            ...(preview.summary.skip ? [{ value: 'skip', label: 'Already exist', count: preview.summary.skip }] : []),
            { value: 'error', label: 'Errors', count: preview.summary.errors },
          ]} />
          <div className="table-wrap preview-table">
            <table className="table compact">
              <thead><tr><th className="num">Row</th><th>Status</th>{k.headings.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {shown.map((r) => (
                  <React.Fragment key={r.row}>
                    <tr className={r.status === 'error' ? 'bad' : ''}>
                      <td className="num">{r.row + (hasHeader ? 1 : 0)}</td>
                      <td><span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                      {k.columns(r.parsed).map((v, i) => <td key={i} className={i === k.headings.length - 1 ? 'truncate' : ''}>{v ?? ''}</td>)}
                    </tr>
                    {(r.errors.length > 0 || (r.warnings.length > 0 && r.status !== 'skip')) && (
                      <tr className="row-messages"><td /><td colSpan={k.headings.length + 1}>
                        {r.errors.map((m, i) => <div key={`e${i}`} className="neg small">{m}</div>)}
                        {r.status !== 'skip' && r.warnings.map((m, i) => <div key={`w${i}`} className="warn small">{m}</div>)}
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {!shown.length && <Empty>No rows in this view.</Empty>}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={!willSave || busy} onClick={runImport}>
              {busy === 'import' ? 'Importing…' : `Import ${willSave} ${willSave === 1 ? one : many}`}
            </button>
            {preview.summary.errors > 0 && <span className="muted small">Rows with errors are skipped. Fix them in the file and import them again later.</span>}
          </div>
        </section>
      )}
    </Page>
  );
}
