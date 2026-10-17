import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBanner, Field, Page, Tabs, useLoad } from '../components/ui.jsx';
import { downloadCsv } from '../components/ReportTable.jsx';
import { date, money } from '../format.js';
import { autoMap as autoMapFields, readTableFile } from '../components/importFile.js';

// Import fields, with the column headings recognised for each (compared ignoring case, spaces and punctuation).
const FIELDS = [
  { key: 'date', label: 'Date', required: true, aliases: ['date', 'transaction date'] },
  { key: 'headerAccount', label: 'Header Account', required: true, aliases: ['header account', 'bank account', 'header', 'bank'] },
  { key: 'detailAccount', label: 'Detail Account', required: true, aliases: ['detail account', 'account', 'category', 'detail'] },
  { key: 'amount', label: 'Amount', required: true, aliases: ['amount', 'total'] },
  { key: 'fund', label: 'Fund', aliases: ['fund'] },
  { key: 'description', label: 'Description', aliases: ['description', 'memo', 'notes'] },
  { key: 'type', label: 'Transaction Type', required: true, aliases: ['transaction type', 'type'] },
  { key: 'customer', label: 'Customer/Vendor', aliases: ['customer/vendor', 'customer vendor', 'customer', 'vendor', 'donor', 'payee', 'name'] },
];
const autoMap = (header) => autoMapFields(FIELDS, header);

const TEMPLATE = [
  FIELDS.map((f) => f.label),
  ['2026-05-01', 'Undeposited Funds', 'Individual Contributions', '250.00', 'General Fund', 'Spring appeal gift', 'Income', 'Jane Smith'],
  ['2026-05-03', 'Operating Checking', 'Office Supplies', '84.17', 'General Fund', 'Printer paper', 'Expense', 'Office Depot'],
];

const STATUS = { ok: { label: 'Ready', cls: 'ok' }, duplicate: { label: 'Possible duplicate', cls: 'warn' }, error: { label: 'Error', cls: 'neg' } };

/** Recent imports (transaction files and QuickBooks exports), each with Undo. */
export function RecentImports({ refreshKey, onUndone }) {
  const { data, reload } = useLoad(() => api.get('/import/batches'), [refreshKey]);
  const [err, setErr] = useState(null);
  const undo = async (b) => {
    const also = [b.created_companies ? 'customers/vendors' : null, b.created_accounts ? 'accounts' : null].filter(Boolean).join(' and ');
    if (!window.confirm(`Undo the import of ${b.file_name || 'this file'}? Its ${b.remaining} transaction(s) will be deleted${also ? `, along with ${also} it created that aren’t used elsewhere` : ''}.`)) return;
    setErr(null);
    try { const r = await api.post(`/import/batches/${b.id}/undo`); onUndone(r); reload(); } catch (e) { setErr(e); }
  };
  if (!data?.length) return null;
  return (
    <>
      <h2 className="section-title">Recent imports</h2>
      <ErrorBanner error={err} onClose={() => setErr(null)} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Imported</th><th>File</th><th>By</th><th className="num">Transactions</th><th>Status</th><th /></tr></thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id} className={b.undone_at ? 'inactive' : ''}>
                <td>{new Date(b.created_at).toLocaleString()}</td>
                <td>{b.file_name}</td>
                <td>{b.created_by}</td>
                <td className="num">{b.row_count}</td>
                <td>{b.undone_at ? `Undone ${new Date(b.undone_at).toLocaleDateString()}${b.undone_by ? ` by ${b.undone_by}` : ''}` : 'Imported'}</td>
                <td className="actions">{!b.undone_at && <button type="button" className="btn btn-sm btn-ghost" onClick={() => undo(b)}>Undo</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function ImportTransactions() {
  const [file, setFile] = useState(null); // { name, rows: [[...]] }
  const [hasHeader, setHasHeader] = useState(true);
  const [map, setMap] = useState({});
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('all');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [undoMsg, setUndoMsg] = useState(null);

  const onFile = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setError(null); setPreview(null); setDone(null);
    try {
      const rows = await readTableFile(f);
      setFile({ name: f.name, rows });
      setHasHeader(true);
      setMap(autoMap(rows[0]));
    } catch (err) { setError(err); setFile(null); }
  };

  const header = file ? (hasHeader ? file.rows[0] : file.rows[0].map((_, i) => `Column ${i + 1}`)) : [];
  const dataRows = file ? file.rows.slice(hasHeader ? 1 : 0) : [];
  const missing = FIELDS.filter((f) => f.required && !(map[f.key] >= 0));
  const records = useMemo(() => dataRows.map((r) => Object.fromEntries(FIELDS.map((f) => [f.key, map[f.key] >= 0 ? r[map[f.key]] ?? '' : '']))), [dataRows, map]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    setBusy('check'); setError(null); setDone(null);
    try { setPreview(await api.post('/import/transactions/preview', { rows: records })); setFilter('all'); } catch (err) { setError(err); } finally { setBusy(null); }
  };
  const runImport = async () => {
    setBusy('import'); setError(null);
    try {
      const r = await api.post('/import/transactions', { rows: records, fileName: file.name, skipDuplicates });
      setDone(r); setFile(null); setPreview(null); setRefreshKey((k) => k + 1);
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const shown = (preview?.results || []).filter((r) => filter === 'all' || r.status === filter);
  const willImport = preview ? preview.summary.ok + (skipDuplicates ? 0 : preview.summary.duplicates) : 0;

  return (
    <Page title="Import Transactions" subtitle={<Link to="/advanced">Advanced</Link>} wide
      actions={<button type="button" className="btn" onClick={() => downloadCsv('transaction-import-template.csv', TEMPLATE)}>Download template</button>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {undoMsg && <div className="alert alert-info">{undoMsg} <button type="button" className="link" onClick={() => setUndoMsg(null)}>✕</button></div>}
      {done && (
        <div className="alert alert-info">
          Imported {done.imported} transaction{done.imported === 1 ? '' : 's'}
          {done.createdCompanies ? `, created ${done.createdCompanies} customer/vendor record${done.createdCompanies === 1 ? '' : 's'}` : ''}
          {done.skippedErrors ? `; skipped ${done.skippedErrors} row(s) with errors` : ''}{done.skippedDuplicates ? `; skipped ${done.skippedDuplicates} possible duplicate(s)` : ''}.
          {' '}<Link to="/income">View income</Link> · <Link to="/expenses">View expenses</Link>
          <button type="button" className="link" onClick={() => setDone(null)}>✕</button>
        </div>
      )}

      <section className="card form">
        <p className="flush">
          Import income and expense transactions from a <strong>CSV</strong> or <strong>Excel (.xlsx)</strong> file, one transaction per row.
          Columns: {FIELDS.map((f) => f.label).join(', ')}. <span className="muted">Transaction Type is Income or Expense.</span>
        </p>
        <ul className="muted small flush import-notes">
          <li>Header Account is the bank or credit card account; Detail Account is the income or expense account. Accounts are matched by name (an account number also works) and funds by fund name, ignoring capitals.</li>
          <li>Customers and vendors are matched by name. Names that don't exist yet are created.</li>
          <li>Nothing is saved until you review the check and click Import. An import can be undone afterwards.</li>
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
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} required={f.required}>
                <select className={`input${f.required && !(map[f.key] >= 0) ? ' input-missing' : ''}`} value={map[f.key] ?? -1}
                  onChange={(e) => { setMap({ ...map, [f.key]: Number(e.target.value) }); setPreview(null); }}>
                  <option value={-1}>{f.required ? '— choose a column —' : '(not in file)'}</option>
                  {header.map((h, i) => <option key={i} value={i}>{String(h || `Column ${i + 1}`)}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={missing.length > 0 || busy} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check file'}</button>
            {missing.length > 0 && <span className="warn small">Choose a column for {missing.map((f) => f.label).join(', ')}.</span>}
          </div>
        </section>
      )}

      {preview && (
        <section className="card">
          <div className="stat-row">
            <div className="stat"><span>Ready</span><strong className="ok">{preview.summary.ok}</strong></div>
            <div className="stat"><span>Possible duplicates</span><strong className={preview.summary.duplicates ? 'warn' : ''}>{preview.summary.duplicates}</strong></div>
            <div className="stat"><span>Errors</span><strong className={preview.summary.errors ? 'neg' : ''}>{preview.summary.errors}</strong></div>
            <div className="stat"><span>Income</span><strong>{money(preview.summary.income)}</strong></div>
            <div className="stat"><span>Expenses</span><strong>{money(preview.summary.expense)}</strong></div>
          </div>
          {preview.newCompanies.length > 0 && (
            <p className="small">New customers/vendors to create ({preview.newCompanies.length}): {preview.newCompanies.slice(0, 30).join(', ')}{preview.newCompanies.length > 30 ? ', …' : ''}</p>
          )}
          <Tabs value={filter} onChange={setFilter} tabs={[
            { value: 'all', label: 'All rows', count: preview.summary.total },
            { value: 'error', label: 'Errors', count: preview.summary.errors },
            { value: 'duplicate', label: 'Possible duplicates', count: preview.summary.duplicates },
          ]} />
          <div className="table-wrap preview-table">
            <table className="table compact">
              <thead><tr><th className="num">Row</th><th>Status</th><th>Date</th><th>Type</th><th>Header Account</th><th>Detail Account</th><th className="num">Amount</th><th>Fund</th><th>Customer/Vendor</th><th>Description</th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const p = r.parsed;
                  const src = records[r.row - 1];
                  return (
                    <React.Fragment key={r.row}>
                      <tr className={r.status === 'error' ? 'bad' : ''}>
                        <td className="num">{r.row + (hasHeader ? 1 : 0)}</td>
                        <td><span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                        <td>{p ? date(p.date) : String(src.date)}</td>
                        <td>{p ? (p.type === 'income' ? 'Income' : 'Expense') : String(src.type)}</td>
                        <td>{p ? p.headerAccount : String(src.headerAccount)}</td>
                        <td>{p ? p.detailAccount : String(src.detailAccount)}</td>
                        <td className="num">{p ? money(p.amount / 100) : String(src.amount)}</td>
                        <td>{p ? p.fund : String(src.fund)}</td>
                        <td>{p ? <>{p.customer}{p.createCompany && <span className="badge">new</span>}</> : String(src.customer)}</td>
                        <td className="truncate">{p ? p.description : String(src.description)}</td>
                      </tr>
                      {(r.errors.length > 0 || r.warnings.length > 0) && (
                        <tr className="row-messages"><td /><td colSpan={9}>
                          {r.errors.map((m, i) => <div key={`e${i}`} className="neg small">{m}</div>)}
                          {r.warnings.map((m, i) => <div key={`w${i}`} className="warn small">{m}</div>)}
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            {!shown.length && <Empty>No rows in this view.</Empty>}
          </div>
          <div className="form-actions">
            {preview.summary.duplicates > 0 && <label className="check"><input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} /> Skip possible duplicates</label>}
            <button type="button" className="btn btn-primary" disabled={!willImport || busy} onClick={runImport}>
              {busy === 'import' ? 'Importing…' : `Import ${willImport} transaction${willImport === 1 ? '' : 's'}`}
            </button>
            {preview.summary.errors > 0 && <span className="muted small">Rows with errors are skipped. Fix them in the file and import them again later.</span>}
          </div>
        </section>
      )}

      <RecentImports refreshKey={refreshKey}
        onUndone={(r) => { setDone(null); setUndoMsg(`Import undone: deleted ${r.deleted} transaction(s)${r.removedCompanies ? ` and ${r.removedCompanies} customer/vendor record(s) it created` : ''}.`); window.scrollTo(0, 0); }} />
    </Page>
  );
}
