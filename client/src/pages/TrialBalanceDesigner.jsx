import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Modal, Page } from '../components/ui.jsx';
import ReportTable from '../components/ReportTable.jsx';
import AuditInfo from '../components/AuditInfo.jsx';
import { MultiPick, PeriodPicker, usePeriods, useReportRun } from '../components/reportControls.jsx';
import { fundPickOptions } from './ReportView.jsx';

const PERIOD_OPTIONS = [['today', 'Today'], ['this_month', 'End of This Month'], ['last_month', 'End of Last Month'], ['this_quarter', 'End of This Quarter'],
  ['last_quarter', 'End of Last Quarter'], ['this_fiscal_year', 'End of This Fiscal Year'], ['last_fiscal_year', 'End of Last Fiscal Year']];

/** Settings for a trial balance or the unpaid bills aging (they have no rows or formulas to design). */
export default function TrialBalanceDesigner({ report: initialReport }) {
  const navigate = useNavigate();
  const { lookups } = useApp();
  const periods = usePeriods();
  const [report, setReport] = useState(initialReport);
  const [def, setDef] = useState(initialReport.definition);
  const [dates, setDates] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saveAs, setSaveAs] = useState(null);
  useEffect(() => {
    if (!periods || dates) return;
    const p = periods.find((x) => x.key === def.defaultPeriod) || periods[0];
    setDates({ period: p.key, from: p.from, to: p.to });
  }, [periods, dates, def.defaultPeriod]);
  const { result, error: runError, running } = useReportRun(def, dates?.from, dates?.to);
  const setOpt = (patch) => setDef({ ...def, options: { ...def.options, ...patch } });
  const isAging = def.type === 'bill_aging';
  const kind = isAging ? 'Unpaid Bills Aging' : 'Trial Balance';

  const save = async () => {
    setError(null);
    try {
      if (!report.name?.trim()) throw new Error('Give the report a name before saving');
      const r = await api.put(`/reports/${report.id}`, { name: report.name, description: report.description, definition: def });
      setReport(r); setDef(r.definition); setMsg('Saved.');
    } catch (e) { setError(e); }
  };
  const doSaveAs = async () => {
    try { const r = await api.post('/reports', { name: saveAs, description: report.description, definition: def }); setSaveAs(null); navigate(`/reports/${r.id}/design`); } catch (e) { setError(e); }
  };
  const reset = async () => {
    if (!window.confirm(`Restore the standard ${kind} settings?`)) return;
    try { const r = await api.post(`/reports/${report.id}/reset`); setReport(r); setDef(r.definition); setMsg('Restored the standard settings.'); } catch (e) { setError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the report "${report.name}"?`)) return;
    try { await api.del(`/reports/${report.id}`); navigate('/reports'); } catch (e) { setError(e); }
  };

  return (
    <Page title={`${kind} Settings`} subtitle={report.name} wide
      actions={<>
        <Link className="btn" to={`/reports/${report.id}`}>Run Report</Link>
        <button type="button" className="btn" onClick={() => setSaveAs(`${report.name} (Copy)`)}>Save As…</button>
        <button type="button" className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      <div className="designer">
        <div className="designer-left">
          <section className="card form">
            <Field label="Name" required><input className="input" value={report.name} onChange={(e) => setReport({ ...report, name: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={report.description || ''} onChange={(e) => setReport({ ...report, description: e.target.value })} /></Field>
            <Field label="Default date">
              <select className="input" value={def.defaultPeriod} onChange={(e) => setDef({ ...def, defaultPeriod: e.target.value })}>
                {PERIOD_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Include only these funds"><MultiPick label="Include funds" options={fundPickOptions(lookups)} value={def.fundFilter} onChange={(v) => setDef({ ...def, fundFilter: v })} placeholder="All funds" /></Field>
            {isAging ? (
              <>
                <div className="grid g3">
                  <Field label="Age by">
                    <select className="input" value={def.options.agingBasis} onChange={(e) => setOpt({ agingBasis: e.target.value })}>
                      <option value="due_date">Days past due</option>
                      <option value="bill_date">Days since bill date</option>
                    </select>
                  </Field>
                  <Field label="Days per column"><input type="number" min={1} max={365} className="input" value={def.options.interval} onChange={(e) => setOpt({ interval: Number(e.target.value) || 30 })} /></Field>
                  <Field label="Number of columns" hint="Plus Current and Over">
                    <select className="input" value={def.options.periods} onChange={(e) => setOpt({ periods: Number(e.target.value) })}>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="check-row">
                  <label className="check"><input type="checkbox" checked={def.options.showBills} onChange={(e) => setOpt({ showBills: e.target.checked })} /> Show each bill under its vendor (otherwise one line per vendor)</label>
                </div>
                <p className="muted small flush">A bill’s balance is its amount less payments dated on or before the report date. Bills without a due date are due on their bill date. The fund filter uses each bill’s fund.</p>
              </>
            ) : (<>
            <div className="check-row">
              <label className="check"><input type="checkbox" checked={def.options.groupByType} onChange={(e) => setOpt({ groupByType: e.target.checked })} /> Group by account type with subtotals</label>
              <label className="check"><input type="checkbox" checked={def.options.showZeroRows} onChange={(e) => setOpt({ showZeroRows: e.target.checked })} /> Show zero-balance accounts</label>
              <label className="check"><input type="checkbox" checked={def.options.showAccountNumbers} onChange={(e) => setOpt({ showAccountNumbers: e.target.checked })} /> Account numbers</label>
            </div>
            <p className="muted small flush">Income and expense accounts show the current fiscal year to the report date. Earlier years’ net activity appears on one Net Assets line, so total debits equal total credits.</p>
            </>)}
          </section>
          <div className="row gap">
            {report.builtin_key && <button type="button" className="btn btn-ghost" onClick={reset}>Reset to standard settings</button>}
            {!report.builtin_key && <button type="button" className="btn btn-danger" onClick={remove}>Delete report</button>}
          </div>
          <AuditInfo table="report_definitions" id={report.id} refreshKey={report.updated_at} />
        </div>
        <div className="designer-right">
          <div className="card preview-card">
            <div className="row between wrap gap">
              <h3 className="card-title">Preview {running && <span className="muted small">updating…</span>}</h3>
              <div className="filter-bar flush">{dates && <PeriodPicker type="balance_sheet" {...dates} onChange={setDates} />}</div>
            </div>
            {runError && <div className="alert alert-error">{runError.message}</div>}
            <ReportTable name={report.name} result={result} fundFilter={def.fundFilter} />
          </div>
        </div>
      </div>
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
