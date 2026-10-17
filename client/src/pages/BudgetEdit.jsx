import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Save } from 'lucide-react';
import { api, qs } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, Modal, Page, useFundOptions } from '../components/ui.jsx';
import AuditInfo from '../components/AuditInfo.jsx';
import { money, today } from '../format.js';
import { useBudgetReports } from './Budgets.jsx';

const MAX_MONTHS = 60;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addMonth = (s, n) => {
  const [y, m] = s.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
};
const monthLabel = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
const lastDay = (s) => { const [y, m] = s.split('-').map(Number); return `${s.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

/** First day of each month from start through end (null when the range is too long). */
function budgetMonths(start, end) {
  if (!start || !end || end < start) return [];
  const out = [];
  for (let m = `${start.slice(0, 7)}-01`; m <= end; m = addMonth(m, 1)) {
    out.push(m);
    if (out.length > MAX_MONTHS) return null;
  }
  return out;
}

// Grid sections, in report order. Balance sheet sections are shown only when asked for.
const SECTIONS = [
  { key: 'income', label: 'Income', types: ['income', 'other_income'], pnl: true },
  { key: 'expense', label: 'Expenses', types: ['expense', 'other_expense'], pnl: true },
  { key: 'asset', label: 'Assets (change in balance)', types: ['bank', 'current_asset', 'fixed_asset'] },
  { key: 'liability', label: 'Liabilities (change in balance)', types: ['accounts_payable', 'credit_card', 'line_of_credit', 'current_liability', 'loan', 'long_term_liability'] },
  { key: 'equity', label: 'Net Assets (change in balance)', types: ['equity'] },
];
const PNL_TYPES = new Set(SECTIONS.filter((s) => s.pnl).flatMap((s) => s.types));

const toCents = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fmt = (c) => (c ? (c / 100).toFixed(2) : '');
const key = (accountId, month) => `${accountId}|${month}`;

function thisFiscalYear(fyStartMonth = 1) {
  const t = today();
  const [y, m] = t.split('-').map(Number);
  const startYear = m >= fyStartMonth ? y : y - 1;
  const start = `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`;
  const end = addMonth(start, 12);
  const [ey, em] = end.split('-').map(Number);
  const prev = em === 1 ? `${ey - 1}-12` : `${ey}-${String(em - 1).padStart(2, '0')}`;
  return { start, end: lastDay(`${prev}-01`) };
}

/** Total cell: shows the row total; typing a new total spreads it evenly across the months. */
function TotalCell({ cents, onSpread, disabled }) {
  const [draft, setDraft] = useState(null);
  return (
    <input className="input num budget-cell budget-total" title="Type a total to spread it evenly across the months" disabled={disabled}
      value={draft ?? (cents ? (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '')}
      onFocus={() => setDraft(cents ? (cents / 100).toFixed(2) : '')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null && toCents(draft) !== cents) onSpread(toCents(draft)); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

export default function BudgetEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { lookups, me } = useApp();
  const reports = useBudgetReports();
  const [head, setHead] = useState(null);
  const [amounts, setAmounts] = useState({});
  const [showBs, setShowBs] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fill, setFill] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const fundOptions = useFundOptions(head?.fundId);

  useEffect(() => {
    setError(null);
    if (isNew) {
      const fy = thisFiscalYear(me.currentOrganization?.fiscal_year_start_month || 1);
      setHead({ name: '', description: '', startDate: fy.start, endDate: fy.end, scope: 'overall', fundId: null });
      setAmounts({});
      return;
    }
    api.get(`/budgets/${id}`).then((b) => {
      setHead({ name: b.name, description: b.description || '', startDate: b.start_date, endDate: b.end_date, scope: b.fund_id ? 'fund' : 'overall', fundId: b.fund_id });
      setAmounts(Object.fromEntries(b.lines.map((l) => [key(l.account_id, l.month), Number(l.amount).toFixed(2)])));
      const types = Object.fromEntries((lookups?.accounts || []).map((a) => [a.id, a.account_type]));
      setShowBs(b.lines.some((l) => types[l.account_id] && !PNL_TYPES.has(types[l.account_id])));
    }).catch(setError);
  }, [id, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const months = useMemo(() => (head ? budgetMonths(head.startDate, head.endDate) : []), [head]);
  const monthList = months || [];
  const inRange = useMemo(() => new Set(monthList), [monthList]);

  const sections = useMemo(() => {
    const accounts = (lookups?.accounts || []).slice().sort((a, b) => (a.account_number || '').localeCompare(b.account_number || '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
    const hasAmount = (a) => monthList.some((m) => toCents(amounts[key(a.id, m)]));
    return SECTIONS.filter((s) => s.pnl || showBs).map((s) => ({
      ...s,
      accounts: accounts.filter((a) => s.types.includes(a.account_type)
        && (a.is_active || hasAmount(a)) && (!hideEmpty || hasAmount(a))),
    }));
  }, [lookups, showBs, hideEmpty, amounts, monthList]);

  if (!head) return <Page title="Budget"><ErrorBanner error={error} /></Page>;

  const setH = (k) => (v) => setHead({ ...head, [k]: v?.target ? v.target.value : v });
  const cell = (accountId, m) => amounts[key(accountId, m)] ?? '';
  const setCell = (accountId, m, v) => setAmounts((a) => ({ ...a, [key(accountId, m)]: v }));
  const rowCents = (accountId) => monthList.reduce((s, m) => s + toCents(cell(accountId, m)), 0);
  const colCents = (accts, m) => accts.reduce((s, a) => s + toCents(cell(a.id, m)), 0);
  const spread = (accountId, total) => {
    const n = monthList.length;
    const each = Math.trunc(total / n);
    const next = { ...amounts };
    monthList.forEach((m, i) => { next[key(accountId, m)] = fmt(i === n - 1 ? total - each * (n - 1) : each); });
    setAmounts(next);
  };
  const copyAcross = (accountId) => {
    const first = cell(accountId, monthList[0]);
    const next = { ...amounts };
    monthList.forEach((m) => { next[key(accountId, m)] = first; });
    setAmounts(next);
  };
  const clearRow = (accountId) => {
    const next = { ...amounts };
    monthList.forEach((m) => { delete next[key(accountId, m)]; });
    setAmounts(next);
  };
  const outside = Object.entries(amounts).filter(([k, v]) => toCents(v) && !inRange.has(k.split('|')[1])).length;

  const income = sections.find((s) => s.key === 'income')?.accounts || [];
  const expense = sections.find((s) => s.key === 'expense')?.accounts || [];
  const netCents = (m) => colCents(income, m) - colCents(expense, m);
  const netTotal = monthList.reduce((s, m) => s + netCents(m), 0);
  const partialStart = head.startDate && head.startDate.slice(8) !== '01';
  const partialEnd = head.endDate && head.endDate !== lastDay(head.endDate);

  const save = async (close) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const lines = Object.entries(amounts)
        .filter(([k, v]) => toCents(v) && inRange.has(k.split('|')[1]))
        .map(([k, v]) => { const [accountId, month] = k.split('|'); return { accountId: Number(accountId), month, amount: (toCents(v) / 100).toFixed(2) }; });
      const body = { name: head.name, description: head.description, startDate: head.startDate, endDate: head.endDate, fundId: head.scope === 'fund' ? head.fundId : null, lines };
      const r = isNew ? await api.post('/budgets', body) : await api.put(`/budgets/${id}`, body);
      if (close) navigate('/budgets', { state: { notice: `Budget “${head.name.trim()}” saved.` } });
      else {
        setNotice('Budget saved.');
        setSavedKey((k) => k + 1);
        if (isNew) navigate(`/budgets/${r.id}`, { replace: true });
      }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { await api.del(`/budgets/${id}`); navigate('/budgets', { state: { notice: `Budget “${head.name}” deleted.` } }); } catch (e) { setError(e); setConfirmDelete(false); }
  };
  const doFill = async () => {
    try {
      const rows = await api.get(`/budgets/actuals${qs({ startDate: head.startDate, endDate: head.endDate, fundId: head.scope === 'fund' ? head.fundId : undefined, yearsBack: fill.yearsBack })}`);
      const visible = new Set(sections.flatMap((s) => s.types));
      const types = Object.fromEntries((lookups?.accounts || []).map((a) => [a.id, a.account_type]));
      const next = fill.replace ? Object.fromEntries(Object.entries(amounts).filter(([k]) => !visible.has(types[Number(k.split('|')[0])]))) : { ...amounts };
      let count = 0;
      for (const r of rows) {
        if (!visible.has(types[r.accountId])) continue;
        const k = key(r.accountId, r.month);
        if (!fill.replace && toCents(next[k])) continue;
        next[k] = Number(r.amount).toFixed(2);
        count += 1;
      }
      setAmounts(next);
      setFill(null);
      setNotice(count ? `Filled ${count} amount${count === 1 ? '' : 's'} from actuals. Review them, then save.` : 'No actual activity was found for those months.');
    } catch (e) { setError(e); setFill(null); }
  };

  return (
    <Page title={isNew ? 'New Budget' : head.name || 'Budget'} wide subtitle={<Link to="/budgets">Budgets</Link>}
      actions={!isNew && reports.pnl && <>
        <Link className="btn" to={`/reports/${reports.pnl}?budget=${id}`}>Budget to Actual P&amp;L</Link>
        {reports.bs && <Link className="btn" to={`/reports/${reports.bs}?budget=${id}`}>Budget to Actual Balance Sheet</Link>}
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <div className="alert alert-info">{notice} <button type="button" className="link" onClick={() => setNotice(null)}>✕</button></div>}
      <form className="card form" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        <div className="grid g3">
          <Field label="Budget name" required><input className="input" value={head.name} onChange={setH('name')} placeholder="e.g. FY 2026 Operating Budget" autoFocus={isNew} /></Field>
          <Field label="Start date" required><input type="date" className="input" value={head.startDate} onChange={setH('startDate')} /></Field>
          <Field label="End date" required><input type="date" className="input" value={head.endDate} onChange={setH('endDate')} /></Field>
        </div>
        <div className="grid g3">
          <Field label="Budget for">
            <div className="row gap wrap budget-scope">
              <label className="check"><input type="radio" name="scope" checked={head.scope === 'overall'} onChange={() => setHead({ ...head, scope: 'overall' })} /> Overall (all funds)</label>
              <label className="check"><input type="radio" name="scope" checked={head.scope === 'fund'} onChange={() => setHead({ ...head, scope: 'fund' })} /> One fund</label>
            </div>
          </Field>
          {head.scope === 'fund'
            ? <Field label="Fund" required><Combo options={fundOptions} value={head.fundId} onChange={setH('fundId')} placeholder="Select fund" /></Field>
            : <div />}
          <Field label="Description"><input className="input" value={head.description} onChange={setH('description')} /></Field>
        </div>
        {months === null && <p className="warn small flush">A budget can cover at most {MAX_MONTHS} months. Choose a shorter date range.</p>}
        {(partialStart || partialEnd) && months?.length > 0 && <p className="muted small flush">The {[partialStart && 'first', partialEnd && 'last'].filter(Boolean).join(' and ')} month{partialStart && partialEnd ? 's are' : ' is'} partial: enter the amount for just the days the budget covers.</p>}
        {outside > 0 && <p className="warn small flush">{outside} amount{outside === 1 ? ' is' : 's are'} outside the new dates and will be removed when you save.</p>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !months?.length}><Save size={16} aria-hidden="true" />Save &amp; Close</button>
          <button type="button" className="btn" disabled={busy || !months?.length} onClick={() => save(false)}><Save size={16} aria-hidden="true" />Save</button>
          <button type="button" className="btn btn-link" onClick={() => navigate('/budgets')}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>
      </form>

      {months?.length > 0 && (
        <div className="card">
          <div className="row gap wrap budget-toolbar">
            <label className="check"><input type="checkbox" checked={showBs} onChange={(e) => setShowBs(e.target.checked)} /> Include balance sheet accounts</label>
            <label className="check"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Only accounts with amounts</label>
            <span className="grow" />
            <button type="button" className="btn btn-sm" disabled={head.scope === 'fund' && !head.fundId} onClick={() => setFill({ yearsBack: 1, replace: false })}>Fill from last year’s actuals…</button>
          </div>
          <p className="muted small">
            Enter each month’s amount, or type a yearly figure in <strong>Total</strong> to spread it evenly. Income and expenses are the
            activity for the month{showBs && <>; balance sheet amounts are the planned <strong>change</strong> in the balance (the Budget to Actual
            Balance Sheet starts from the actual balances on the budget’s start date)</>}.
          </p>
          <div className="table-wrap budget-wrap">
            <table className="table budget-grid">
              <thead>
                <tr>
                  <th className="budget-acct">Account</th>
                  {monthList.map((m) => <th key={m} className="num">{monthLabel(m)}</th>)}
                  <th className="num total-col">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sections.map((s) => (
                  <React.Fragment key={s.key}>
                    <tr className="budget-section"><td className="budget-acct" colSpan={1}>{s.label}</td><td colSpan={monthList.length + 2} /></tr>
                    {s.accounts.map((a) => (
                      <tr key={a.id}>
                        <td className="budget-acct" title={a.name}>{a.account_number ? `${a.account_number} · ` : ''}{a.name}{!a.is_active && <span className="muted"> (inactive)</span>}</td>
                        {monthList.map((m) => (
                          <td key={m}>
                            <input className="input num budget-cell" inputMode="decimal" aria-label={`${a.name} ${monthLabel(m)}`}
                              value={cell(a.id, m)} onChange={(e) => setCell(a.id, m, e.target.value)}
                              onBlur={(e) => { const c = toCents(e.target.value); setCell(a.id, m, fmt(c)); }} />
                          </td>
                        ))}
                        <td className="total-col"><TotalCell cents={rowCents(a.id)} onSpread={(c) => spread(a.id, c)} /></td>
                        <td className="actions nowrap">
                          <button type="button" className="icon-btn" title="Copy the first month to every month" onClick={() => copyAcross(a.id)}>⇥</button>
                          <button type="button" className="icon-btn" title="Clear this row" onClick={() => clearRow(a.id)}>✕</button>
                        </td>
                      </tr>
                    ))}
                    {!s.accounts.length && <tr><td className="budget-acct muted" colSpan={1}>{hideEmpty ? 'No amounts' : 'No accounts'}</td><td colSpan={monthList.length + 2} /></tr>}
                    <tr className="budget-subtotal">
                      <td className="budget-acct">Total {s.label.replace(/ \(change in balance\)$/, '')}</td>
                      {monthList.map((m) => <td key={m} className="num">{money(colCents(s.accounts, m) / 100)}</td>)}
                      <td className="num total-col">{money(s.accounts.reduce((t, a) => t + rowCents(a.id), 0) / 100)}</td>
                      <td />
                    </tr>
                    {s.key === 'expense' && (
                      <tr className="budget-net">
                        <td className="budget-acct">Budgeted Change in Net Assets</td>
                        {monthList.map((m) => <td key={m} className={`num${netCents(m) < 0 ? ' neg' : ''}`}>{money(netCents(m) / 100)}</td>)}
                        <td className={`num total-col${netTotal < 0 ? ' neg' : ''}`}>{money(netTotal / 100)}</td>
                        <td />
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!isNew && <AuditInfo table="budgets" id={id} refreshKey={savedKey} />}

      {fill && (
        <Modal title="Fill From Last Year’s Actuals" onClose={() => setFill(null)} width={480}
          footer={<><button type="button" className="btn" onClick={() => setFill(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={doFill}>Fill</button></>}>
          <p>Each budget month is filled with the actual activity from the same month{' '}
            <select className="input inline" value={fill.yearsBack} onChange={(e) => setFill({ ...fill, yearsBack: Number(e.target.value) })}>
              <option value={1}>one year</option><option value={2}>two years</option><option value={3}>three years</option>
            </select>{' '}earlier{head.scope === 'fund' ? ' in this fund' : ' (all funds)'}, for the accounts shown in the grid.</p>
          <label className="check"><input type="radio" name="fillmode" checked={!fill.replace} onChange={() => setFill({ ...fill, replace: false })} /> Fill empty amounts only</label>
          <label className="check"><input type="radio" name="fillmode" checked={fill.replace} onChange={() => setFill({ ...fill, replace: true })} /> Replace all amounts</label>
          <p className="muted small">Nothing is saved until you click Save.</p>
        </Modal>
      )}
      {confirmDelete && (
        <Modal title="Delete Budget" onClose={() => setConfirmDelete(false)} width={440}
          footer={<><button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button><button type="button" className="btn btn-danger" onClick={remove}>Delete</button></>}>
          <p>Delete the budget “{head.name}” and all of its amounts? Your transactions aren’t affected.</p>
        </Modal>
      )}
    </Page>
  );
}
