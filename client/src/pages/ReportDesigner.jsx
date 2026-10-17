import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Modal, Page } from '../components/ui.jsx';
import ReportTable from '../components/ReportTable.jsx';
import { BudgetPick, COLUMN_MODES, MultiPick, PeriodPicker, useBudgets, usePeriods, useReportRun } from '../components/reportControls.jsx';
import { fundPickOptions } from './ReportView.jsx';
import { TuitionReportDesigner } from './TuitionReport.jsx';
import TrialBalanceDesigner from './TrialBalanceDesigner.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

const CATEGORIES = [
  { value: 'asset', label: 'Assets' }, { value: 'liability', label: 'Liabilities' }, { value: 'equity', label: 'Net Assets / Equity' },
  { value: 'income', label: 'Income' }, { value: 'expense', label: 'Expenses' },
];
const DISPLAYS = [
  { value: 'accounts', label: 'Each account' },
  { value: 'by_type', label: 'Accounts grouped by account type (with subtotals)' },
  { value: 'by_group', label: 'Accounts grouped by account group (with subtotals)' },
  { value: 'groups', label: 'One line per account group' },
  { value: 'total', label: 'A single total line' },
];
const KINDS = {
  accounts: { label: 'Accounts', desc: 'A section listing accounts that match a filter, with an optional total.' },
  formula: { label: 'Formula', desc: 'A calculated line, e.g. income - expense.' },
  net_income: { label: 'Change in net assets', desc: 'Income minus expenses for the period, current year or prior years.' },
  heading: { label: 'Heading', desc: 'A title line with no amounts.' },
  spacer: { label: 'Blank line', desc: 'Vertical space.' },
};
const SCOPES = [
  { value: 'period', label: 'Report period (or all time through the date on balance sheets)' },
  { value: 'current_year', label: 'Current fiscal year to date' },
  { value: 'prior_years', label: 'All prior fiscal years' },
];
const PERIOD_OPTIONS = [
  ['this_fiscal_year', 'This Fiscal Year'], ['fiscal_ytd', 'Fiscal Year to Date'], ['last_fiscal_year', 'Last Fiscal Year'],
  ['this_quarter', 'This Quarter'], ['last_quarter', 'Last Quarter'], ['this_month', 'This Month'], ['last_month', 'Last Month'],
  ['today', 'Today'], ['all', 'All Dates'],
];

function uniqueId(base, rows, except) {
  const slug = (String(base || 'row').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'row').replace(/^(\d)/, 'r$1').slice(0, 30);
  let id = slug;
  let n = 2;
  while (rows.some((r) => r.id === id && r !== except)) id = `${slug}_${n++}`;
  return id;
}

function newRow(kind, rows) {
  const base = {
    accounts: { kind, label: 'New Section', filter: { categories: [], types: [], groups: [], accounts: [] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: '' },
    formula: { kind, label: 'New Total', formula: '', style: 'bold', hideIfZero: false },
    net_income: { kind, label: 'Change in Net Assets', scope: 'period' },
    heading: { kind, label: 'Heading' },
    spacer: { kind, label: '' },
  }[kind];
  return { ...base, id: uniqueId(kind === 'spacer' ? 'spacer' : base.label, rows) };
}

function rowSummary(r, lookups) {
  if (r.kind === 'accounts') {
    const f = r.filter || {};
    const parts = [];
    if (f.categories?.length) parts.push(f.categories.map((c) => CATEGORIES.find((x) => x.value === c)?.label).join(', '));
    if (f.types?.length) parts.push(f.types.map((t) => lookups?.accountTypes.find((x) => x.key === t)?.label).join(', '));
    if (f.groups?.length) parts.push(`${f.groups.length} group(s)`);
    if (f.accounts?.length) parts.push(`${f.accounts.length} account(s)`);
    return parts.join(' · ') || 'All accounts';
  }
  if (r.kind === 'formula') return `= ${r.formula || '?'}`;
  if (r.kind === 'net_income') return SCOPES.find((s) => s.value === r.scope)?.label;
  return '';
}

function RowEditor({ row, rows, onChange, lookups }) {
  const set = (patch) => onChange({ ...row, ...patch });
  const setFilter = (patch) => set({ filter: { ...row.filter, ...patch } });
  const typeOptions = (lookups?.accountTypes || []).map((t) => ({ value: t.key, label: t.label }));
  const groupOptions = (lookups?.groups || []).map((g) => ({ value: g.id, label: g.name, hint: lookups.accountTypes.find((t) => t.key === g.account_type)?.label }));
  const acctOptions = (lookups?.accounts || []).map((a) => ({ value: a.id, label: a.account_number ? `${a.account_number} · ${a.name}` : a.name }));
  const matchCount = useMemo(() => {
    if (row.kind !== 'accounts' || !lookups) return 0;
    const cat = Object.fromEntries(lookups.accountTypes.map((t) => [t.key, t.category]));
    const f = row.filter;
    return lookups.accounts.filter((a) => (!f.categories.length || f.categories.includes(cat[a.account_type]))
      && (!f.types.length || f.types.includes(a.account_type)) && (!f.groups.length || f.groups.includes(a.account_group_id))
      && (!f.accounts.length || f.accounts.includes(a.id))).length;
  }, [row, lookups]);
  const others = rows.filter((r) => r !== row && ['accounts', 'formula', 'net_income'].includes(r.kind));

  return (
    <div className="row-editor">
      <div className="grid g2">
        {row.kind !== 'spacer' && <Field label={row.kind === 'heading' ? 'Heading text' : 'Label'}><input className="input" value={row.label} onChange={(e) => set({ label: e.target.value })} /></Field>}
        {row.kind !== 'spacer' && row.kind !== 'heading' && (
          <Field label="Row ID" hint="Used to refer to this row in formulas">
            <input className="input mono" value={row.id} onChange={(e) => set({ id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
          </Field>
        )}
      </div>

      {row.kind === 'accounts' && (
        <>
          <div className="subhead">Include accounts that match <span className="muted small">(every filter you set must match; leave a filter empty to ignore it)</span></div>
          <div className="check-row">
            {CATEGORIES.map((c) => (
              <label key={c.value} className="check"><input type="checkbox" checked={row.filter.categories.includes(c.value)}
                onChange={(e) => setFilter({ categories: e.target.checked ? [...row.filter.categories, c.value] : row.filter.categories.filter((x) => x !== c.value) })} /> {c.label}</label>
            ))}
          </div>
          <div className="grid g3">
            <Field label="Account types"><MultiPick label="Account types" options={typeOptions} value={row.filter.types} onChange={(v) => setFilter({ types: v })} placeholder="Any type" /></Field>
            <Field label="Account groups"><MultiPick label="Account groups" options={groupOptions} value={row.filter.groups} onChange={(v) => setFilter({ groups: v })} placeholder="Any group" /></Field>
            <Field label="Specific accounts"><MultiPick label="Specific accounts" options={acctOptions} value={row.filter.accounts} onChange={(v) => setFilter({ accounts: v })} placeholder="Any account" /></Field>
          </div>
          <div className="muted small">{matchCount} account(s) currently match.</div>
          <div className="grid g2 mt">
            <Field label="Show as">
              <select className="input" value={row.display} onChange={(e) => set({ display: e.target.value })}>
                {DISPLAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </Field>
            <Field label="Total line label"><input className="input" value={row.totalLabel || ''} placeholder={`Total ${row.label}`} onChange={(e) => set({ totalLabel: e.target.value })} disabled={!row.showTotal || row.display === 'total'} /></Field>
          </div>
          <div className="check-row">
            <label className="check"><input type="checkbox" checked={row.showHeader !== false} onChange={(e) => set({ showHeader: e.target.checked })} disabled={row.display === 'total'} /> Show section header</label>
            <label className="check"><input type="checkbox" checked={row.showTotal !== false} onChange={(e) => set({ showTotal: e.target.checked })} disabled={row.display === 'total'} /> Show total line</label>
            <label className="check"><input type="checkbox" checked={Boolean(row.negate)} onChange={(e) => set({ negate: e.target.checked })} /> Reverse sign</label>
          </div>
        </>
      )}

      {row.kind === 'formula' && (
        <>
          <Field label="Formula" hint="Use row IDs with + - * / and parentheses, e.g. income - expense">
            <input className="input mono" value={row.formula} onChange={(e) => set({ formula: e.target.value })} placeholder="income - expense" />
          </Field>
          <div className="chips">
            {others.map((r) => (
              <button key={r.id} type="button" className="chip" title={r.label} onClick={() => set({ formula: `${row.formula}${row.formula && !/[\s(+\-*/]$/.test(row.formula) ? ' + ' : ''}${r.id}` })}>{r.id}</button>
            ))}
            {['+', '-', '*', '/', '(', ')'].map((op) => <button key={op} type="button" className="chip op" onClick={() => set({ formula: `${row.formula} ${op} `.replace(/\s+/g, ' ') })}>{op}</button>)}
          </div>
          <div className="grid g2">
            <Field label="Style">
              <select className="input" value={row.style || 'bold'} onChange={(e) => set({ style: e.target.value })}>
                <option value="normal">Normal</option><option value="bold">Bold subtotal</option><option value="grand">Grand total (double underline)</option>
              </select>
            </Field>
            <label className="check mt"><input type="checkbox" checked={Boolean(row.hideIfZero)} onChange={(e) => set({ hideIfZero: e.target.checked })} /> Hide when zero</label>
          </div>
        </>
      )}

      {row.kind === 'net_income' && (
        <Field label="Calculate for">
          <select className="input" value={row.scope} onChange={(e) => set({ scope: e.target.value })}>
            {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}

export default function ReportDesigner() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { lookups } = useApp();
  const periods = usePeriods();
  const [report, setReport] = useState(null);
  const [def, setDef] = useState(null);
  const [sel, setSel] = useState(0);
  const [dates, setDates] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saveAs, setSaveAs] = useState(null);

  useEffect(() => {
    const load = isNew
      ? api.get(`/reports/blank?type=${search.get('type') || 'pnl'}`).then((d) => ({ id: null, name: '', description: '', definition: d }))
      : api.get(`/reports/${id}`);
    load.then((r) => { setReport(r); setDef(r.definition); setSel(0); }).catch(setError);
  }, [id, isNew, search]);
  useEffect(() => {
    if (!def || !periods || dates) return;
    const p = periods.find((x) => x.key === def.defaultPeriod) || periods[0];
    setDates({ period: p.key, from: p.from, to: p.to });
  }, [def, periods, dates]);

  const isTuition = def?.type === 'tuition';
  const isTB = def?.type === 'trial_balance' || def?.type === 'bill_aging'; // settings-only reports
  const { result, error: runError, running } = useReportRun(isTuition || isTB ? null : def, dates?.from, dates?.to);

  if (!def || !report) return <Page title="Report Designer"><ErrorBanner error={error} /></Page>;
  if (isTB) return <TrialBalanceDesigner key={report.id || 'new'} report={{ ...report, definition: def }} />;
  if (isTuition) return <TuitionReportDesigner key={report.id || 'new'} report={{ ...report, definition: def }} isNew={isNew} />;

  const rows = def.rows;
  const setRows = (next) => setDef({ ...def, rows: next });
  // Renaming a row ID also updates formulas and the "% of" option that refer to it.
  const updateRow = (i, r) => {
    const oldId = rows[i].id;
    const renamed = r.id !== oldId && r.id;
    const re = renamed ? new RegExp(`\\b${oldId}\\b`, 'g') : null;
    const next = rows.map((x, j) => {
      if (j === i) return r;
      return renamed && x.kind === 'formula' ? { ...x, formula: x.formula.replace(re, r.id) } : x;
    });
    setDef({ ...def, rows: next, options: renamed && def.options.percentOf === oldId ? { ...def.options, percentOf: r.id } : def.options });
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
    setSel(j);
  };
  const removeRow = (i) => { setRows(rows.filter((_, j) => j !== i)); setSel(Math.max(0, i - 1)); };
  const addRow = (kind) => {
    const r = newRow(kind, rows);
    const at = Math.min(sel + 1, rows.length);
    setRows([...rows.slice(0, at), r, ...rows.slice(at)]);
    setSel(at);
    setAdding(false);
  };
  const setCols = (patch) => setDef({ ...def, columns: { ...def.columns, ...patch } });
  const setOpt = (patch) => setDef({ ...def, options: { ...def.options, ...patch } });
  const changeType = (type) => {
    setDef({ ...def, type, defaultPeriod: type === 'balance_sheet' ? 'today' : 'this_fiscal_year' });
    const p = periods?.find((x) => x.key === (type === 'balance_sheet' ? 'today' : 'this_fiscal_year'));
    if (p) setDates({ period: p.key, from: p.from, to: p.to });
  };

  const save = async () => {
    setError(null);
    try {
      const body = { name: report.name, description: report.description, definition: def };
      if (!body.name?.trim()) throw new Error('Give the report a name before saving');
      const r = isNew ? await api.post('/reports', body) : await api.put(`/reports/${id}`, body);
      setReport(r); setDef(r.definition);
      setMsg('Saved.');
      if (isNew) navigate(`/reports/${r.id}/design`, { replace: true });
    } catch (e) { setError(e); }
  };
  const doSaveAs = async () => {
    try {
      const r = await api.post('/reports', { name: saveAs, description: report.description, definition: def });
      setSaveAs(null);
      navigate(`/reports/${r.id}/design`);
    } catch (e) { setError(e); }
  };
  const reset = async () => {
    if (!window.confirm('Restore this standard report to its original layout? Your customizations will be lost.')) return;
    try { const r = await api.post(`/reports/${id}/reset`); setReport(r); setDef(r.definition); setSel(0); setMsg('Restored the standard layout.'); } catch (e) { setError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the report "${report.name}"?`)) return;
    try { await api.del(`/reports/${id}`); navigate('/reports'); } catch (e) { setError(e); }
  };

  const selected = rows[sel];
  const fundOpts = fundPickOptions(lookups);

  return (
    <Page title="Report Designer" subtitle={report.name || 'New report'} wide
      actions={<>
        {!isNew && <Link className="btn" to={`/reports/${id}`}>Run Report</Link>}
        {!isNew && <button type="button" className="btn" onClick={() => setSaveAs(`${report.name} (Copy)`)}>Save As…</button>}
        <button type="button" className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      <div className="designer">
        <div className="designer-left">
          <section className="card form">
            <h3 className="card-title">Report</h3>
            <Field label="Name" required><input className="input" value={report.name} onChange={(e) => setReport({ ...report, name: e.target.value })} placeholder="e.g. Program Expenses by Month" /></Field>
            <Field label="Description"><input className="input" value={report.description || ''} onChange={(e) => setReport({ ...report, description: e.target.value })} /></Field>
            <div className="grid g2">
              <Field label="Figures">
                <select className="input" value={def.type} onChange={(e) => changeType(e.target.value)}>
                  <option value="pnl">Activity for a period</option>
                  <option value="balance_sheet">Balances as of a date</option>
                </select>
              </Field>
              <Field label="Default dates">
                <select className="input" value={def.defaultPeriod} onChange={(e) => setDef({ ...def, defaultPeriod: e.target.value })}>
                  {PERIOD_OPTIONS.filter(([k]) => def.type === 'pnl' || k !== 'all').map(([k, l]) => <option key={k} value={k}>{def.type === 'balance_sheet' ? (k === 'today' ? 'Today' : `End of ${l}`) : l}</option>)}
                </select>
              </Field>
            </div>
          </section>

          <section className="card form">
            <h3 className="card-title">Columns &amp; filters</h3>
            <div className="grid g2">
              <Field label="Columns">
                <select className="input" value={def.columns.mode} onChange={(e) => setCols({ mode: e.target.value })}>
                  {COLUMN_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Field>
              {def.columns.mode === 'fund' && <Field label="Fund columns"><MultiPick label="Fund columns" options={fundOpts.filter((o) => o.value !== 'none')} value={def.columns.funds} onChange={(v) => setCols({ funds: v })} placeholder="All funds with activity" /></Field>}
              {def.columns.mode === 'budget' && <BudgetColumns def={def} setCols={setCols} />}
              {def.columns.mode !== 'fund' && def.columns.mode !== 'budget' && <span />}
              <Field label="Include only these funds"><MultiPick label="Include funds" options={fundOpts} value={def.fundFilter} onChange={(v) => setDef({ ...def, fundFilter: v })} placeholder="All funds" /></Field>
              <Field label="Show % of row">
                <select className="input" value={def.options.percentOf || ''} onChange={(e) => setOpt({ percentOf: e.target.value || null })}>
                  <option value="">(none)</option>
                  {rows.filter((r) => r.kind === 'accounts' || r.kind === 'formula').map((r) => <option key={r.id} value={r.id}>{r.label || r.id}</option>)}
                </select>
              </Field>
            </div>
            <div className="check-row">
              {def.columns.mode === 'fund' && <label className="check"><input type="checkbox" checked={def.columns.includeNoFund} onChange={(e) => setCols({ includeNoFund: e.target.checked })} /> “No Fund” column</label>}
              {['fund', 'month', 'quarter', 'year'].includes(def.columns.mode) && <label className="check"><input type="checkbox" checked={def.columns.includeTotal} onChange={(e) => setCols({ includeTotal: e.target.checked })} /> Total column</label>}
              <label className="check"><input type="checkbox" checked={def.options.showZeroRows} onChange={(e) => setOpt({ showZeroRows: e.target.checked })} /> Show zero-balance accounts</label>
              <label className="check"><input type="checkbox" checked={def.options.showAccountNumbers} onChange={(e) => setOpt({ showAccountNumbers: e.target.checked })} /> Account numbers</label>
            </div>
          </section>

          <section className="card">
            <div className="row between"><h3 className="card-title">Rows</h3><button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add row</button></div>
            <ol className="row-list">
              {rows.map((r, i) => (
                <li key={`${r.id}-${i}`} className={i === sel ? 'active' : ''} onClick={() => setSel(i)}>
                  <span className={`kind kind-${r.kind}`}>{KINDS[r.kind].label}</span>
                  <span className="row-main">
                    <span className="row-label">{r.kind === 'spacer' ? <em className="muted">blank line</em> : r.label || <em className="muted">(no label)</em>}</span>
                    <span className="row-sub">{r.kind !== 'spacer' && r.kind !== 'heading' && <code>{r.id}</code>} {rowSummary(r, lookups)}</span>
                  </span>
                  <span className="row-btns">
                    <button type="button" className="icon-btn" title="Move up" onClick={(e) => { e.stopPropagation(); move(i, -1); }} disabled={i === 0}>↑</button>
                    <button type="button" className="icon-btn" title="Move down" onClick={(e) => { e.stopPropagation(); move(i, 1); }} disabled={i === rows.length - 1}>↓</button>
                    <button type="button" className="icon-btn" title="Remove" onClick={(e) => { e.stopPropagation(); removeRow(i); }}>✕</button>
                  </span>
                </li>
              ))}
              {!rows.length && <li className="muted">No rows yet. Add a row to get started.</li>}
            </ol>
            {selected && selected.kind !== 'spacer' && (
              <>
                <div className="subhead">Edit row: {KINDS[selected.kind].label}</div>
                <RowEditor row={selected} rows={rows} lookups={lookups} onChange={(r) => updateRow(sel, r)} />
              </>
            )}
          </section>

          <div className="row gap">
            {report.builtin_key && <button type="button" className="btn btn-ghost" onClick={reset}>Reset to standard layout</button>}
            {!isNew && !report.builtin_key && <button type="button" className="btn btn-danger" onClick={remove}>Delete report</button>}
          </div>
        </div>

        <div className="designer-right">
          <div className="card preview-card">
            <div className="row between wrap gap">
              <h3 className="card-title">Preview {running && <span className="muted small">updating…</span>}</h3>
              <div className="filter-bar flush">{dates && <PeriodPicker type={def.type} {...dates} onChange={setDates} />}</div>
            </div>
            {runError && <div className="alert alert-error">{runError.message}</div>}
            <ReportTable name={report.name || 'Untitled report'} result={result} fundFilter={def.fundFilter} />
          </div>
        </div>
      </div>

      {adding && (
        <Modal title="Add Row" onClose={() => setAdding(false)} width={520}>
          <div className="choice-list">
            {Object.entries(KINDS).map(([k, v]) => (
              <button key={k} type="button" className="choice" onClick={() => addRow(k)}><strong>{v.label}</strong><span className="muted">{v.desc}</span></button>
            ))}
          </div>
        </Modal>
      )}
      {!isNew && <AuditInfo table="report_definitions" id={id} refreshKey={report.updated_at} />}
      {saveAs !== null && (
        <Modal title="Save As New Report" onClose={() => setSaveAs(null)} width={460}
          footer={<><button type="button" className="btn" onClick={() => setSaveAs(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!saveAs.trim()} onClick={doSaveAs}>Save</button></>}>
          <form onSubmit={(e) => { e.preventDefault(); doSaveAs(); }}>
            <Field label="Report name"><input className="input" autoFocus value={saveAs} onChange={(e) => setSaveAs(e.target.value)} /></Field>
          </form>
        </Modal>
      )}
    </Page>
  );
}

function BudgetColumns({ def, setCols }) {
  const budgets = useBudgets(true);
  return <BudgetPick budgets={budgets} value={def.columns.budgetId} onChange={(b) => setCols({ budgetId: b?.id ?? null })} />;
}
