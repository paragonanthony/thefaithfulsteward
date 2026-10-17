import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export const COLUMN_MODES = [
  { value: 'total', label: 'Total only' },
  { value: 'fund', label: 'By fund' },
  { value: 'month', label: 'By month' },
  { value: 'quarter', label: 'By quarter' },
  { value: 'year', label: 'By fiscal year' },
  { value: 'prior_year', label: 'Compare to prior year' },
  { value: 'budget', label: 'Compare to budget' },
];

/** Budgets for the "Compare to budget" column mode (loaded once the mode is chosen). */
export function useBudgets(enabled) {
  const [budgets, setBudgets] = useState(null);
  useEffect(() => {
    if (enabled && !budgets) api.get('/budgets').then(setBudgets).catch(() => setBudgets([]));
  }, [enabled, budgets]);
  return budgets;
}

/** Report dates that fit a budget: its whole range for a P&L, its end (or the current date if inside it) for a balance sheet. */
export function budgetDates(budget, type, current) {
  if (type !== 'balance_sheet') return { period: 'custom', from: budget.start_date, to: budget.end_date };
  const inside = current?.to && current.to >= budget.start_date && current.to <= budget.end_date;
  return { period: 'custom', from: current?.from ?? null, to: inside ? current.to : budget.end_date };
}

export function BudgetPick({ budgets, value, onChange }) {
  return (
    <label className="field"><span className="field-label">Budget</span>
      <select className="input" value={value || ''} onChange={(e) => onChange(budgets?.find((b) => String(b.id) === e.target.value) || null)}>
        <option value="">Automatic (covers the report date)</option>
        {(budgets || []).map((b) => <option key={b.id} value={b.id}>{b.name}{b.fund_name ? ` (${b.fund_name})` : ''}</option>)}
      </select>
    </label>
  );
}

/** Dropdown with a searchable checkbox list. value: array of ids. */
export function MultiPick({ options, value, onChange, placeholder = 'All', label }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const set = new Set((value || []).map(String));
  const toggle = (v) => { const s = new Set(set); if (s.has(String(v))) s.delete(String(v)); else s.add(String(v)); onChange(options.filter((o) => s.has(String(o.value))).map((o) => o.value)); };
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const summary = !set.size ? placeholder : set.size <= 2 ? options.filter((o) => set.has(String(o.value))).map((o) => o.label).join(', ') : `${set.size} selected`;
  return (
    <div className="multipick" ref={ref}>
      <button type="button" className="input multipick-btn" onClick={() => setOpen(!open)} aria-label={label}>{summary}<span className="caret">▾</span></button>
      {open && (
        <div className="multipick-pop">
          {options.length > 8 && <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
          <div className="multipick-list">
            {shown.map((o) => (
              <label key={o.value} className="check"><input type="checkbox" checked={set.has(String(o.value))} onChange={() => toggle(o.value)} /> {o.label}{o.hint && <span className="muted small"> {o.hint}</span>}</label>
            ))}
            {!shown.length && <div className="muted small">No matches</div>}
          </div>
          <div className="row between">
            <button type="button" className="link small" onClick={() => onChange([])}>Clear</button>
            <button type="button" className="link small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

let periodsCache = null;
export function usePeriods() {
  const [periods, setPeriods] = useState(periodsCache);
  useEffect(() => {
    if (periodsCache) return;
    api.get('/reports/periods').then((p) => { periodsCache = p; setPeriods(p); }).catch(() => setPeriods([]));
  }, []);
  return periods;
}
export const clearPeriodsCache = () => { periodsCache = null; };

/** Period + date inputs. For balance-sheet style reports only the "as of" date is shown. */
export function PeriodPicker({ type, period, from, to, onChange }) {
  const periods = usePeriods() || [];
  const bs = type === 'balance_sheet';
  const pick = (key) => {
    const p = periods.find((x) => x.key === key);
    if (p) onChange({ period: key, from: p.from, to: p.to });
    else onChange({ period: 'custom', from, to });
  };
  return (
    <>
      <label className="field"><span className="field-label">{bs ? 'As of' : 'Report period'}</span>
        <select className="input" value={period} onChange={(e) => pick(e.target.value)}>
          {periods.filter((p) => !bs || p.key !== 'all').map((p) => (
            <option key={p.key} value={p.key}>{bs ? (p.key === 'today' ? 'Today' : `End of ${p.label.replace(/^This /, 'this ').replace(/^Last /, 'last ')}`) : p.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {!bs && <label className="field"><span className="field-label">From</span><input type="date" className="input" value={from || ''} onChange={(e) => onChange({ period: 'custom', from: e.target.value, to })} /></label>}
      <label className="field"><span className="field-label">{bs ? 'Date' : 'To'}</span><input type="date" className="input" value={to || ''} onChange={(e) => onChange({ period: 'custom', from, to: e.target.value })} /></label>
    </>
  );
}

/** Debounced report runner. */
export function useReportRun(def, from, to) {
  const [state, setState] = useState({ result: null, error: null, running: false });
  const seq = useRef(0);
  const key = JSON.stringify([def, from, to]);
  useEffect(() => {
    if (!def || !to || (def.type !== 'balance_sheet' && !from)) return undefined;
    const my = ++seq.current;
    setState((s) => ({ ...s, running: true }));
    const timer = setTimeout(() => {
      api.post('/reports/run', { definition: def, from: def.type === 'balance_sheet' ? null : from, to })
        .then((result) => { if (my === seq.current) setState({ result, error: null, running: false }); })
        .catch((error) => { if (my === seq.current) setState((s) => ({ ...s, error, running: false })); });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
