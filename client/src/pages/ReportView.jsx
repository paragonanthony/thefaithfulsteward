import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Modal, Page } from '../components/ui.jsx';
import ReportTable, { downloadCsv, reportToRows } from '../components/ReportTable.jsx';
import { BudgetPick, COLUMN_MODES, MultiPick, PeriodPicker, budgetDates, useBudgets, usePeriods, useReportRun } from '../components/reportControls.jsx';
import { TuitionReportView } from './TuitionReport.jsx';

export function fundPickOptions(lookups) {
  return [...(lookups?.funds || []).map((f) => ({ value: f.id, label: f.name, hint: f.is_active ? '' : '(inactive)' })), { value: 'none', label: 'No Fund' }];
}

export default function ReportView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { lookups } = useApp();
  const periods = usePeriods();
  const [search] = useSearchParams();
  const budgetParam = Number(search.get('budget')) || null; // opened from a budget
  const [report, setReport] = useState(null);
  const [def, setDef] = useState(null);
  const [dates, setDates] = useState(null);
  const [error, setError] = useState(null);
  const [saveAs, setSaveAs] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  useEffect(() => {
    api.get(`/reports/${id}`).then((r) => {
      setReport(r);
      const d = r.definition;
      setDef(budgetParam && (d.type === 'pnl' || d.type === 'balance_sheet') ? { ...d, columns: { ...d.columns, mode: 'budget', budgetId: budgetParam } } : d);
    }).catch(setError);
  }, [id, budgetParam]);
  const budgets = useBudgets(def?.columns?.mode === 'budget');
  useEffect(() => {
    if (!def || !periods || dates) return;
    if (budgetParam && def.columns?.mode === 'budget') {
      if (!budgets) return;
      const b = budgets.find((x) => x.id === budgetParam);
      if (b) { setDates(budgetDates(b, def.type, null)); return; }
    }
    const p = periods.find((x) => x.key === def.defaultPeriod) || periods[0];
    setDates({ period: p.key, from: p.from, to: p.to });
  }, [def, periods, dates, budgets, budgetParam]);

  const isTuition = def?.type === 'tuition';
  const { result, error: runError, running } = useReportRun(isTuition ? null : def, dates?.from, dates?.to);
  const dirty = report && def && JSON.stringify(report.definition) !== JSON.stringify(def);
  const percentRows = useMemo(() => (def?.rows || []).filter((r) => r.kind === 'accounts' || r.kind === 'formula'), [def]);

  if (isTuition && report) return <TuitionReportView key={report.id} report={report} />;
  if (!def || !dates) return <Page title="Report"><ErrorBanner error={error} />{!error && <div className="muted">Loading…</div>}</Page>;
  const isTB = def.type === 'trial_balance';
  const isAging = def.type === 'bill_aging';
  const simple = isTB || isAging; // no rows, columns or formulas
  const setCols = (patch) => setDef({ ...def, columns: { ...def.columns, ...patch } });
  const setOpt = (patch) => setDef({ ...def, options: { ...def.options, ...patch } });

  const save = async () => {
    try {
      const r = await api.put(`/reports/${id}`, { name: report.name, description: report.description, definition: def });
      setReport(r); setDef(r.definition); setSavedMsg('Report layout saved.');
    } catch (e) { setError(e); }
  };
  const doSaveAs = async () => {
    try {
      const r = await api.post('/reports', { name: saveAs, description: report.description, definition: def });
      setSaveAs(null);
      navigate(`/reports/${r.id}`);
    } catch (e) { setError(e); }
  };

  return (
    <Page title={report.name} wide
      actions={<>
        <Link className="btn" to={`/reports/${id}/design`}>{simple ? 'Settings' : 'Customize'}</Link>
        <button type="button" className="btn" disabled={!result} onClick={() => downloadCsv(`${report.name}.csv`, reportToRows(report.name, result))}>Export CSV</button>
        <button type="button" className="btn" disabled={!result} onClick={() => window.print()}>Print</button>
      </>}>
      <ErrorBanner error={error || runError} onClose={() => setError(null)} />
      {savedMsg && <div className="alert alert-info">{savedMsg} <button type="button" className="link" onClick={() => setSavedMsg(null)}>✕</button></div>}
      <div className="card report-controls no-print">
        <div className="filter-bar flush">
          <PeriodPicker type={def.type === 'pnl' ? 'pnl' : 'balance_sheet'} {...dates} onChange={setDates} />
          {isAging && <Field label="Age by">
            <select className="input" value={def.options.agingBasis} onChange={(e) => setOpt({ agingBasis: e.target.value })}>
              <option value="due_date">Days past due</option>
              <option value="bill_date">Days since bill date</option>
            </select>
          </Field>}
          {isAging && <Field label="Days per column">
            <input type="number" min={1} max={365} className="input narrow-num" value={def.options.interval} onChange={(e) => setOpt({ interval: Number(e.target.value) || 30 })} />
          </Field>}
          {!simple && <Field label="Columns">
            <select className="input" value={def.columns.mode} onChange={(e) => setCols({ mode: e.target.value })}>
              {COLUMN_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>}
          {!simple && def.columns.mode === 'budget' && (
            <BudgetPick budgets={budgets} value={def.columns.budgetId} onChange={(b) => { setCols({ budgetId: b?.id ?? null }); if (b) setDates(budgetDates(b, def.type, dates)); }} />
          )}
          {!simple && def.columns.mode === 'fund' && (
            <Field label="Fund columns"><MultiPick label="Fund columns" options={fundPickOptions(lookups).filter((o) => o.value !== 'none')} value={def.columns.funds} onChange={(v) => setCols({ funds: v })} placeholder="All funds with activity" /></Field>
          )}
          <Field label="Include funds"><MultiPick label="Include funds" options={fundPickOptions(lookups)} value={def.fundFilter} onChange={(v) => setDef({ ...def, fundFilter: v })} placeholder="All funds" /></Field>
          {!simple && <Field label="% of">
            <select className="input" value={def.options.percentOf || ''} onChange={(e) => setOpt({ percentOf: e.target.value || null })}>
              <option value="">(none)</option>
              {percentRows.map((r) => <option key={r.id} value={r.id}>{r.label || r.id}</option>)}
            </select>
          </Field>}
        </div>
        <div className="row gap wrap">
          {isAging ? <label className="check"><input type="checkbox" checked={def.options.showBills} onChange={(e) => setOpt({ showBills: e.target.checked })} /> Show each bill</label> : <>
            <label className="check"><input type="checkbox" checked={def.options.showZeroRows} onChange={(e) => setOpt({ showZeroRows: e.target.checked })} /> Show accounts with zero balances</label>
            <label className="check"><input type="checkbox" checked={def.options.showAccountNumbers} onChange={(e) => setOpt({ showAccountNumbers: e.target.checked })} /> Show account numbers</label>
          </>}
          {isTB && <label className="check"><input type="checkbox" checked={def.options.groupByType} onChange={(e) => setOpt({ groupByType: e.target.checked })} /> Group by account type</label>}
          {!simple && def.columns.mode === 'fund' && <label className="check"><input type="checkbox" checked={def.columns.includeNoFund} onChange={(e) => setCols({ includeNoFund: e.target.checked })} /> “No Fund” column</label>}
          {!simple && ['fund', 'month', 'quarter', 'year'].includes(def.columns.mode) && <label className="check"><input type="checkbox" checked={def.columns.includeTotal} onChange={(e) => setCols({ includeTotal: e.target.checked })} /> Total column</label>}
          <span className="grow" />
          {running && <span className="muted small">Updating…</span>}
          {dirty && <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDef(report.definition)}>Revert</button>
            <button type="button" className="btn btn-sm" onClick={save}>Save changes</button>
          </>}
          <button type="button" className="btn btn-sm" onClick={() => setSaveAs(`${report.name} (Custom)`)}>Save As…</button>
        </div>
      </div>
      <ReportTable name={report.name} result={result} fundFilter={def.fundFilter} />
      {result && <p className="muted small no-print">{isAging ? 'Click a bill to open it.' : 'Click any amount to see the transactions behind it.'}</p>}
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
