import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Empty, ErrorBanner, Field, Modal, Page, useLoad } from '../components/ui.jsx';
import { date, money } from '../format.js';

/** Ids of the standard Budget to Actual reports, for quick links. */
export function useBudgetReports() {
  const { data } = useLoad(() => api.get('/reports'), []);
  const find = (key) => data?.find((r) => r.builtin_key === key)?.id;
  return { pnl: find('pnl_budget'), bs: find('balance_sheet_budget') };
}

export default function Budgets() {
  const navigate = useNavigate();
  const location = useLocation();
  const [notice, setNotice] = useState(location.state?.notice || null);
  const { data, error, loading } = useLoad(() => api.get('/budgets'), []);
  const reports = useBudgetReports();
  const [copy, setCopy] = useState(null);
  const [copyError, setCopyError] = useState(null);

  const startCopy = (b) => {
    // Default: the same budget moved to the following year.
    const [y, rest] = [Number(b.start_date.slice(0, 4)), b.start_date.slice(4)];
    setCopyError(null);
    setCopy({ id: b.id, name: `${b.name} (Copy)`, startDate: `${y + 1}${rest}` });
  };
  const doCopy = async () => {
    try {
      const r = await api.post(`/budgets/${copy.id}/copy`, { name: copy.name, startDate: copy.startDate });
      navigate(`/budgets/${r.id}`);
    } catch (e) { setCopyError(e); }
  };

  return (
    <Page title="Budgets" actions={<Link className="btn btn-primary" to="/budgets/new"><Plus size={16} aria-hidden="true" />New Budget</Link>}>
      <ErrorBanner error={error} />
      {notice && <div className="alert alert-info">{notice} <button type="button" className="link" onClick={() => setNotice(null)}>✕</button></div>}
      <p className="muted">
        Plan income and expenses (and optionally balance sheet changes) month by month. An <strong>overall</strong> budget covers
        all funds; a <strong>fund</strong> budget covers one fund and is compared to that fund’s actuals.
        {reports.pnl && <> Compare to actuals with <Link to={`/reports/${reports.pnl}`}>Budget to Actual Profit and Loss</Link></>}
        {reports.bs && <> or <Link to={`/reports/${reports.bs}`}>Budget to Actual Balance Sheet</Link></>}.
      </p>
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Name</th><th>Budget for</th><th>Start</th><th>End</th><th className="num">Income</th><th className="num">Expenses</th><th className="num">Net</th><th /></tr></thead>
          <tbody>
            {data?.map((b) => (
              <tr key={b.id} onClick={() => navigate(`/budgets/${b.id}`)}>
                <td><strong>{b.name}</strong>{b.description && <div className="muted small">{b.description}</div>}</td>
                <td>{b.fund_id ? <span className="badge">Fund: {b.fund_name}</span> : 'All funds'}</td>
                <td>{date(b.start_date)}</td>
                <td>{date(b.end_date)}</td>
                <td className="num">{money(b.income)}</td>
                <td className="num">{money(b.expense)}</td>
                <td className={`num${Number(b.net) < 0 ? ' neg' : ''}`}>{money(b.net)}</td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  {reports.pnl && <Link className="btn btn-sm" to={`/reports/${reports.pnl}?budget=${b.id}`}>Budget to Actual</Link>}
                  <button type="button" className="btn btn-sm" onClick={() => startCopy(b)}>Copy</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !data?.length && <Empty>No budgets yet. Use “New Budget” to create one.</Empty>}
      </div>
      {copy && (
        <Modal title="Copy Budget" onClose={() => setCopy(null)} width={460}
          footer={<><button type="button" className="btn" onClick={() => setCopy(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!copy.name.trim() || !copy.startDate} onClick={doCopy}>Copy</button></>}>
          <ErrorBanner error={copyError} />
          <form className="form" onSubmit={(e) => { e.preventDefault(); doCopy(); }}>
            <Field label="New budget name" required><input className="input" autoFocus value={copy.name} onChange={(e) => setCopy({ ...copy, name: e.target.value })} /></Field>
            <Field label="Start date" required hint="Every month’s amounts move with the start date, and the copy keeps the same length.">
              <input type="date" className="input" value={copy.startDate} onChange={(e) => setCopy({ ...copy, startDate: e.target.value })} />
            </Field>
          </form>
        </Modal>
      )}
    </Page>
  );
}
