import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Modal, Page } from '../components/ui.jsx';
import { MultiPick, PeriodPicker, usePeriods, useReportRun } from '../components/reportControls.jsx';
import { downloadCsv } from '../components/ReportTable.jsx';
import TuitionReportTable, { tuitionReportToRows } from '../components/TuitionReportTable.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

export const TUITION_COLUMNS = [
  ['date', 'Date'], ['customer', 'Customer'], ['description', 'Description'], ['amount', 'Tuition'], ['paid', 'Paid'], ['balance', 'Balance'],
  ['percent_paid', '% Paid'], ['last_payment', 'Last Payment'], ['payments', 'Number of Payments'], ['days_outstanding', 'Days Outstanding'],
  ['age_current', '0–30 Days'], ['age_31_60', '31–60 Days'], ['age_61_90', '61–90 Days'], ['age_over_90', 'Over 90 Days'],
  ['fund', 'Fund'], ['income_account', 'Income Account'], ['memo', 'Memo'], ['email', 'Email'], ['phone', 'Phone'],
];
const COLUMN_LABEL = Object.fromEntries(TUITION_COLUMNS);
const AGING = ['age_current', 'age_31_60', 'age_61_90', 'age_over_90'];
const GROUP_OPTIONS = [['none', 'No grouping'], ['customer', 'Customer'], ['fund', 'Fund'], ['description', 'Description'], ['month', 'Month of tuition date']];
const STATUS_OPTIONS = [['unpaid', 'With a balance due'], ['paid', 'Paid in full'], ['all', 'All tuition records']];
const PERIOD_OPTIONS = [['today', 'Today'], ['this_month', 'This Month'], ['last_month', 'Last Month'], ['this_quarter', 'This Quarter'],
  ['this_fiscal_year', 'This Fiscal Year'], ['fiscal_ytd', 'Fiscal Year to Date'], ['last_fiscal_year', 'Last Fiscal Year'], ['all', 'All Dates']];

const pickerType = (def) => (def.dateMode === 'as_of' ? 'balance_sheet' : 'pnl');

/** Initial dates for a report from its default period. */
function useInitialDates(def) {
  const periods = usePeriods();
  const [dates, setDates] = useState(null);
  useEffect(() => {
    if (!def || !periods || dates) return;
    const p = periods.find((x) => x.key === def.defaultPeriod) || periods[0];
    setDates({ period: p.key, from: p.from, to: p.to });
  }, [def, periods, dates]);
  return [dates, setDates, periods];
}

function useOptions() {
  const { lookups } = useApp();
  return {
    customers: (lookups?.companies || []).map((c) => ({ value: c.id, label: c.name })),
    funds: [...(lookups?.funds || []).map((f) => ({ value: f.id, label: f.name })), { value: 'none', label: 'No Fund' }],
  };
}

function SaveAsModal({ initial, onSave, onClose }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title="Save As New Report" onClose={onClose} width={460}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={() => onSave(name)}>Save</button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(name); }}>
        <Field label="Report name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
export function TuitionReportView({ report: initialReport }) {
  const navigate = useNavigate();
  const [report, setReport] = useState(initialReport);
  const [def, setDef] = useState(initialReport.definition);
  const [dates, setDates] = useInitialDates(def);
  const [saveAs, setSaveAs] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const { result, error: runError, running } = useReportRun(def, dates?.from, dates?.to);
  const dirty = JSON.stringify(report.definition) !== JSON.stringify(def);

  const save = async () => {
    try { const r = await api.put(`/reports/${report.id}`, { name: report.name, description: report.description, definition: def }); setReport(r); setDef(r.definition); setMsg('Report layout saved.'); } catch (e) { setError(e); }
  };
  const doSaveAs = async (name) => {
    try { const r = await api.post('/reports', { name, description: report.description, definition: def }); setSaveAs(null); navigate(`/reports/${r.id}`); } catch (e) { setError(e); }
  };

  return (
    <Page title={report.name} wide
      actions={<>
        <Link className="btn" to={`/reports/${report.id}/design`}>Customize</Link>
        <button type="button" className="btn" disabled={!result} onClick={() => downloadCsv(`${report.name}.csv`, tuitionReportToRows(report.name, result))}>Export CSV</button>
        <button type="button" className="btn" disabled={!result} onClick={() => window.print()}>Print</button>
      </>}>
      <ErrorBanner error={error || runError} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      <div className="card report-controls no-print">
        <div className="filter-bar flush">
          {dates && <PeriodPicker type={pickerType(def)} {...dates} onChange={setDates} />}
          <Field label="Show">
            <select className="input" value={def.status} onChange={(e) => setDef({ ...def, status: e.target.value })}>
              {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Group by">
            <select className="input" value={def.groupBy} onChange={(e) => setDef({ ...def, groupBy: e.target.value })}>
              {GROUP_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <div className="row gap wrap">
          {def.groupBy !== 'none' && <label className="check"><input type="checkbox" checked={!def.showDetail} onChange={(e) => setDef({ ...def, showDetail: !e.target.checked })} /> Summary only (one line per group)</label>}
          <span className="grow" />
          {running && <span className="muted small">Updating…</span>}
          {dirty && <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDef(report.definition)}>Revert</button>
            <button type="button" className="btn btn-sm" onClick={save}>Save changes</button>
          </>}
          <button type="button" className="btn btn-sm" onClick={() => setSaveAs(`${report.name} (Custom)`)}>Save As…</button>
        </div>
      </div>
      <TuitionReportTable name={report.name} result={result} />
      {result?.count > 0 && <p className="muted small no-print">Click a row to open the tuition record.</p>}
      {saveAs !== null && <SaveAsModal initial={saveAs} onClose={() => setSaveAs(null)} onSave={doSaveAs} />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------
export function TuitionReportDesigner({ report: initialReport, isNew }) {
  const navigate = useNavigate();
  const opts = useOptions();
  const [report, setReport] = useState(initialReport);
  const [def, setDef] = useState(initialReport.definition);
  const [dates, setDates, periods] = useInitialDates(def);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saveAs, setSaveAs] = useState(null);
  const { result, error: runError, running } = useReportRun(def, dates?.from, dates?.to);
  const set = (patch) => setDef({ ...def, ...patch });

  const setDateMode = (mode) => {
    const defaultPeriod = mode === 'as_of' ? 'today' : 'this_fiscal_year';
    set({ dateMode: mode, defaultPeriod });
    const p = periods?.find((x) => x.key === defaultPeriod);
    if (p) setDates({ period: p.key, from: p.from, to: p.to });
  };
  const toggleColumn = (key) => {
    const cols = def.columns.includes(key) ? def.columns.filter((c) => c !== key) : [...def.columns, key];
    if (cols.length) set({ columns: cols, sortBy: cols.includes(def.sortBy) || def.sortBy === 'date' ? def.sortBy : cols[0] });
  };
  const moveColumn = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= def.columns.length) return;
    const cols = [...def.columns];
    [cols[i], cols[j]] = [cols[j], cols[i]];
    set({ columns: cols });
  };

  const save = async () => {
    setError(null);
    try {
      if (!report.name?.trim()) throw new Error('Give the report a name before saving');
      const body = { name: report.name, description: report.description, definition: def };
      const r = isNew ? await api.post('/reports', body) : await api.put(`/reports/${report.id}`, body);
      if (isNew) { navigate(`/reports/${r.id}/design`, { replace: true }); return; }
      setReport(r); setDef(r.definition); setMsg('Saved.');
    } catch (e) { setError(e); }
  };
  const doSaveAs = async (name) => {
    try { const r = await api.post('/reports', { name, description: report.description, definition: def }); setSaveAs(null); navigate(`/reports/${r.id}/design`); } catch (e) { setError(e); }
  };
  const reset = async () => {
    if (!window.confirm('Restore the standard Tuition Balances layout? Your customizations will be lost.')) return;
    try { const r = await api.post(`/reports/${report.id}/reset`); setReport(r); setDef(r.definition); setMsg('Restored the standard layout.'); } catch (e) { setError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the report "${report.name}"?`)) return;
    try { await api.del(`/reports/${report.id}`); navigate('/reports'); } catch (e) { setError(e); }
  };

  return (
    <Page title="Tuition Report Designer" subtitle={report.name || 'New tuition report'} wide
      actions={<>
        {!isNew && <Link className="btn" to={`/reports/${report.id}`}>Run Report</Link>}
        {!isNew && <button type="button" className="btn" onClick={() => setSaveAs(`${report.name} (Copy)`)}>Save As…</button>}
        <button type="button" className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      <div className="designer">
        <div className="designer-left">
          <section className="card form">
            <h3 className="card-title">Report</h3>
            <Field label="Name" required><input className="input" value={report.name} onChange={(e) => setReport({ ...report, name: e.target.value })} placeholder="e.g. Overdue Tuition by Fund" /></Field>
            <Field label="Description"><input className="input" value={report.description || ''} onChange={(e) => setReport({ ...report, description: e.target.value })} /></Field>
            <div className="grid g2">
              <Field label="Dates">
                <select className="input" value={def.dateMode} onChange={(e) => setDateMode(e.target.value)}>
                  <option value="as_of">Balances as of a date</option>
                  <option value="period">Tuition dated within a period</option>
                </select>
              </Field>
              <Field label="Default dates">
                <select className="input" value={def.defaultPeriod} onChange={(e) => set({ defaultPeriod: e.target.value })}>
                  {PERIOD_OPTIONS.filter(([k]) => def.dateMode === 'period' || k !== 'all').map(([k, l]) => <option key={k} value={k}>{def.dateMode === 'as_of' && k !== 'today' ? `End of ${l}` : l}</option>)}
                </select>
              </Field>
            </div>
            <p className="muted small flush">Only payments dated on or before the report date count toward Paid.</p>
          </section>

          <section className="card form">
            <h3 className="card-title">Include</h3>
            <div className="grid g2">
              <Field label="Tuition records">
                <select className="input" value={def.status} onChange={(e) => set({ status: e.target.value })}>
                  {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Minimum balance"><input type="number" className="input num" step="0.01" value={def.minBalance ?? ''} onChange={(e) => set({ minBalance: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Any" /></Field>
              <Field label="Customers"><MultiPick label="Customers" options={opts.customers} value={def.customers} onChange={(v) => set({ customers: v })} placeholder="All customers" /></Field>
              <Field label="Funds"><MultiPick label="Funds" options={opts.funds} value={def.funds} onChange={(v) => set({ funds: v })} placeholder="All funds" /></Field>
            </div>
            <Field label="Description contains"><input className="input" value={def.descriptionContains} onChange={(e) => set({ descriptionContains: e.target.value })} placeholder="e.g. 2026–27" /></Field>
          </section>

          <section className="card">
            <h3 className="card-title">Columns</h3>
            <div className="grid g2 col-picker">
              <div>
                <div className="subhead flush">Available</div>
                <div className="check-col">
                  {TUITION_COLUMNS.map(([k, l]) => (
                    <label key={k} className="check"><input type="checkbox" checked={def.columns.includes(k)} onChange={() => toggleColumn(k)} /> {l}</label>
                  ))}
                </div>
                <button type="button" className="link small mt" onClick={() => set({ columns: [...new Set([...def.columns.filter((c) => !AGING.includes(c)), ...AGING])] })}>Add aging columns</button>
              </div>
              <div>
                <div className="subhead flush">Order</div>
                <ol className="row-list">
                  {def.columns.map((k, i) => (
                    <li key={k}>
                      <span className="row-main"><span className="row-label">{COLUMN_LABEL[k]}</span></span>
                      <span className="row-btns">
                        <button type="button" className="icon-btn" title="Move up" onClick={() => moveColumn(i, -1)} disabled={i === 0}>↑</button>
                        <button type="button" className="icon-btn" title="Move down" onClick={() => moveColumn(i, 1)} disabled={i === def.columns.length - 1}>↓</button>
                        <button type="button" className="icon-btn" title="Remove" onClick={() => toggleColumn(k)} disabled={def.columns.length === 1}>✕</button>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          <section className="card form">
            <h3 className="card-title">Grouping &amp; sorting</h3>
            <div className="grid g2">
              <Field label="Group by">
                <select className="input" value={def.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
                  {GROUP_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Sort by">
                <div className="row gap">
                  <select className="input" value={def.sortBy} onChange={(e) => set({ sortBy: e.target.value })}>
                    {TUITION_COLUMNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <select className="input" style={{ width: 'auto' }} value={def.sortDir} onChange={(e) => set({ sortDir: e.target.value })}>
                    <option value="asc">Ascending</option><option value="desc">Descending</option>
                  </select>
                </div>
              </Field>
            </div>
            <div className="check-row">
              {def.groupBy !== 'none' && <label className="check"><input type="checkbox" checked={def.showDetail} onChange={(e) => set({ showDetail: e.target.checked })} /> Show each record</label>}
              {def.groupBy !== 'none' && def.showDetail && <label className="check"><input type="checkbox" checked={def.showSubtotals} onChange={(e) => set({ showSubtotals: e.target.checked })} /> Group subtotals</label>}
              <label className="check"><input type="checkbox" checked={def.showTotals} onChange={(e) => set({ showTotals: e.target.checked })} /> Grand total</label>
            </div>
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
              <div className="filter-bar flush">{dates && <PeriodPicker type={pickerType(def)} {...dates} onChange={setDates} />}</div>
            </div>
            {runError && <div className="alert alert-error">{runError.message}</div>}
            <TuitionReportTable name={report.name || 'Untitled tuition report'} result={result} />
          </div>
        </div>
      </div>
      {!isNew && <AuditInfo table="report_definitions" id={report.id} refreshKey={report.updated_at} />}
      {saveAs !== null && <SaveAsModal initial={saveAs} onClose={() => setSaveAs(null)} onSave={doSaveAs} />}
    </Page>
  );
}
