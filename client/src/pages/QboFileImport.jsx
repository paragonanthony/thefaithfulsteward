import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Empty, ErrorBanner, Field, Page } from '../components/ui.jsx';
import { date } from '../format.js';
import { RecentImports } from './ImportTransactions.jsx';

// Import a QuickBooks Online company from its report exports (Excel or CSV): Journal, contact lists, statements.
const TYPE_LABEL = { income: 'Income', expense: 'Expense', transfer: 'Transfer', journal: 'Journal Entry' };
const TYPE_COUNT = { income: ['income', 'income'], expense: ['expense', 'expenses'], transfer: ['transfer', 'transfers'], journal: ['journal entry', 'journal entries'] };

const readBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error(`Couldn’t read ${f.name}`));
  r.readAsDataURL(f);
});

export default function QboFileImport() {
  const { reloadLookups } = useApp();
  const [files, setFiles] = useState([]); // [{ fileName, data, size }]
  const [plan, setPlan] = useState(null);
  const [choices, setChoices] = useState({}); // QuickBooks account name -> { accountId } | { type }
  const [range, setRange] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [showNames, setShowNames] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [undoMsg, setUndoMsg] = useState(null);

  const onFiles = async (e) => {
    const list = [...e.target.files];
    e.target.value = '';
    if (!list.length) return;
    setError(null); setDone(null); setPlan(null); setChoices({});
    try {
      const read = await Promise.all(list.map(async (f) => ({ fileName: f.name, size: f.size, data: await readBase64(f) })));
      // Adding files keeps the ones already chosen (a file with the same name is replaced).
      setFiles((prev) => [...prev.filter((p) => !read.some((r) => r.fileName === p.fileName)), ...read]);
    } catch (err) { setError(err); }
  };
  const body = (c = choices, r = range) => ({ files: files.map(({ fileName, data }) => ({ fileName, data })), accounts: c, from: r.from || null, to: r.to || null });
  const analyze = async (c = choices, r = range) => {
    setBusy('analyze'); setError(null); setDone(null);
    try { setPlan(await api.post('/import/qbo-files/analyze', body(c, r))); } catch (err) { setError(err); } finally { setBusy(null); }
  };
  const choose = (name, value) => {
    const next = { ...choices, [name]: value };
    setChoices(next);
    analyze(next);
  };
  const runImport = async () => {
    setBusy('import'); setError(null);
    try {
      const r = await api.post('/import/qbo-files', body());
      setDone(r); setPlan(null); setFiles([]); setChoices({}); setRefreshKey((k) => k + 1);
      await reloadLookups?.();
      window.scrollTo(0, 0);
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const existingByType = useMemo(() => {
    const groups = {};
    for (const a of plan?.existingAccounts || []) (groups[a.type] ||= []).push(a);
    return groups;
  }, [plan]);
  const s = plan?.summary;
  const newAccounts = plan ? plan.accounts.filter((a) => a.action === 'create').length : 0;

  return (
    <Page title="QuickBooks Export Import" subtitle={<Link to="/advanced">Advanced</Link>} wide>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {undoMsg && <div className="alert alert-info">{undoMsg} <button type="button" className="link" onClick={() => setUndoMsg(null)}>✕</button></div>}
      {done && (
        <div className="alert alert-info">
          Imported {done.imported} transaction{done.imported === 1 ? '' : 's'} ({Object.entries(done.byType).filter(([, n]) => n).map(([k, n]) => `${n} ${TYPE_COUNT[k][n === 1 ? 0 : 1]}`).join(', ')}),
          created {done.createdAccounts} account{done.createdAccounts === 1 ? '' : 's'} and {done.createdCompanies} customer/vendor record{done.createdCompanies === 1 ? '' : 's'}.
          {done.skippedAlready ? ` ${done.skippedAlready} already imported were skipped.` : ''}{done.skippedProblems ? ` ${done.skippedProblems} with problems were skipped.` : ''}
          {' '}It can be undone under Recent imports below.
          <button type="button" className="link" onClick={() => setDone(null)}>✕</button>
        </div>
      )}

      <section className="card form">
        <p className="flush">
          Bring a QuickBooks Online company into this organization from QuickBooks’ <strong>report exports</strong> (Excel or CSV). Choose all the files at once:
        </p>
        <ul className="small flush import-notes">
          <li><strong>Journal</strong> (Reports → Journal, dates: All Dates) — every transaction with all its lines. Required for transactions.</li>
          <li><strong>Balance Sheet</strong> and <strong>Profit and Loss</strong> (All Dates), or the <strong>Account List</strong> — give each account its type. <strong>Trial Balance</strong> adds any accounts without activity.</li>
          <li><strong>Customer</strong>, <strong>Vendor</strong> and <strong>Employee</strong> contact lists — names (with phone, email and address when included). Names used on transactions are added too.</li>
          <li><strong>General Ledger</strong> (All Dates), optional — used to check that the Journal has every transaction.</li>
        </ul>
        <p className="muted small">
          Transactions come in as Income or Expense (one bank or card account plus income / expense lines), Transfers (between two bank or card accounts)
          or Journal Entries (everything else, and QuickBooks journal entries). Nothing is saved until you click Import, importing the same export again skips
          what’s already been imported, and the whole import can be undone.
        </p>
        <div className="row gap wrap">
          <label className="btn btn-primary">Choose files…<input type="file" multiple accept=".xlsx,.csv,text/csv" hidden onChange={onFiles} /></label>
          {files.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => analyze()}>{busy === 'analyze' ? 'Reading…' : plan ? 'Read again' : 'Read files'}</button>}
          {files.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => { setFiles([]); setPlan(null); setChoices({}); }}>Clear</button>}
        </div>
        {files.length > 0 && (
          <ul className="small mt flush">
            {files.map((f) => {
              const p = plan?.files.find((x) => x.fileName === f.fileName);
              return <li key={f.fileName}>{f.fileName} <span className="muted">· {(f.size / 1024).toFixed(0)} KB{p ? ` · ${p.label}` : ''}</span>{p && !p.kind && <span className="badge warn">Not used</span>}</li>;
            })}
          </ul>
        )}
      </section>

      {plan && (
        <>
          {plan.warnings.map((w) => <div key={w} className="alert alert-warn">{w}</div>)}
          <section className="card">
            <h3 className="card-title">Transactions</h3>
            <div className="stat-row">
              <div className="stat"><span>To import</span><strong className="ok">{s.import}</strong></div>
              {Object.entries(s.byType).map(([k, n]) => <div key={k} className="stat"><span>{TYPE_LABEL[k]}</span><strong>{n}</strong></div>)}
              {s.already > 0 && <div className="stat"><span>Already imported</span><strong>{s.already}</strong></div>}
              {s.closed > 0 && <div className="stat"><span>In closed period</span><strong className="warn">{s.closed}</strong></div>}
              {s.outside > 0 && <div className="stat"><span>Outside dates</span><strong>{s.outside}</strong></div>}
              {s.problems > 0 && <div className="stat"><span>Problems</span><strong className="neg">{s.problems}</strong></div>}
            </div>
            <p className="small flush">
              {s.total} transaction{s.total === 1 ? '' : 's'} in the Journal{s.firstDate ? `, ${date(s.firstDate)} to ${date(s.lastDate)}` : ''}.
              {' '}QuickBooks types: {Object.entries(s.byQboType).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}.
              {s.closed > 0 && ` Transactions on or before ${date(s.closedThrough)} are in a closed period and are skipped.`}
            </p>
            <div className="grid g4 mt">
              <Field label="Only from" hint="Optional"><input type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
              <Field label="Through" hint="Optional"><input type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
              <div className="field"><span className="field-label">&nbsp;</span><button type="button" className="btn" disabled={busy} onClick={() => analyze(choices, range)}>Apply dates</button></div>
            </div>
            {plan.check && (plan.check.mismatches.length
              ? (
                <div className="alert alert-warn">
                  <div>
                    <strong>The Journal doesn’t match the General Ledger for {plan.check.mismatches.length} account{plan.check.mismatches.length === 1 ? '' : 's'}.</strong> Check that both were exported for All Dates.
                    <ul className="flush">{plan.check.mismatches.slice(0, 15).map((m) => <li key={m.account}>{m.account}: General Ledger {m.generalLedger}, Journal {m.journal} (net debits)</li>)}</ul>
                  </div>
                </div>
              )
              : <div className="alert alert-info">The Journal matches the General Ledger for all {plan.check.accounts} accounts.</div>)}
            {plan.problems.length > 0 && (
              <details className="mt"><summary className="small">Transactions with problems ({s.problems})</summary>
                <ul className="small">{plan.problems.map((p, i) => <li key={i}>{date(p.date)} {p.type}{p.num ? ` #${p.num}` : ''}{p.name ? ` · ${p.name}` : ''}: {p.message}</li>)}</ul>
              </details>
            )}
          </section>

          <section className="card">
            <h3 className="card-title">Accounts</h3>
            <p className="muted small flush">
              Each QuickBooks account is matched to an account here with the same name, or created with the type from QuickBooks’ reports. Change any of them;
              accounts without a type need one before importing. Sub-accounts keep QuickBooks’ full name (for example “Auto Expenses:Gas”).
            </p>
            <div className="table-wrap mt">
              <table className="table compact">
                <thead><tr><th>QuickBooks account</th><th className="num">Lines</th><th style={{ minWidth: 260 }}>Import as</th><th style={{ minWidth: 190 }}>Type</th></tr></thead>
                <tbody>
                  {plan.accounts.map((a) => (
                    <tr key={a.name} className={a.action === 'create' && !a.type ? 'bad' : ''}>
                      <td>{a.name}{a.typeSource && <div className="muted small">From {a.typeSource}</div>}{a.warning && <div className="warn small">{a.warning}</div>}</td>
                      <td className="num">{a.lines}</td>
                      <td>
                        <select className="input" value={a.action === 'existing' ? String(a.accountId) : 'new'}
                          onChange={(e) => choose(a.name, e.target.value === 'new' ? { type: a.type || a.qboType || '' } : { accountId: Number(e.target.value) })}>
                          <option value="new">New account</option>
                          {plan.accountTypes.filter((t) => existingByType[t.key]).map((t) => (
                            <optgroup key={t.key} label={t.label}>{existingByType[t.key].map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>
                          ))}
                        </select>
                      </td>
                      <td>
                        {a.action === 'existing' ? <span className="muted">{a.typeLabel}</span> : (
                          <select className={`input${!a.type ? ' input-missing' : ''}`} value={a.type || ''} onChange={(e) => choose(a.name, { type: e.target.value })}>
                            <option value="">— choose a type —</option>
                            {plan.accountTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!plan.accounts.length && <Empty>No accounts found. Include the Journal and the Balance Sheet / Profit and Loss.</Empty>}
            </div>
          </section>

          <section className="card">
            <h3 className="card-title">Customers, donors &amp; vendors</h3>
            <p className="small flush">
              {plan.names.total} name{plan.names.total === 1 ? '' : 's'}: {plan.names.create} new, {plan.names.total - plan.names.create} already here.
              {' '}<button type="button" className="link" onClick={() => setShowNames(!showNames)}>{showNames ? 'Hide' : 'Show'} names</button>
            </p>
            {showNames && (
              <p className="small">{plan.names.list.map((n) => `${n.name}${n.exists ? ' (exists)' : ''}`).join(' · ')}</p>
            )}
          </section>

          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={!plan.ready || busy} onClick={runImport}>
              {busy === 'import' ? 'Importing…' : `Import ${s.import} transaction${s.import === 1 ? '' : 's'}, ${newAccounts} new account${newAccounts === 1 ? '' : 's'} and ${plan.names.create} new name${plan.names.create === 1 ? '' : 's'}`}
            </button>
            {!plan.ready && plan.accounts.some((a) => a.action === 'create' && !a.type) && <span className="warn small">Choose a type for every new account first.</span>}
            {!plan.ready && !s.import && <span className="muted small">There are no new transactions to import.</span>}
          </div>
        </>
      )}

      <RecentImports refreshKey={refreshKey}
        onUndone={(r) => { setDone(null); setUndoMsg(`Import undone: deleted ${r.deleted} transaction(s)${r.removedCompanies ? `, ${r.removedCompanies} customer/vendor record(s)` : ''}${r.removedAccounts ? ` and ${r.removedAccounts} account(s)` : ''} it created.`); window.scrollTo(0, 0); }} />
    </Page>
  );
}
