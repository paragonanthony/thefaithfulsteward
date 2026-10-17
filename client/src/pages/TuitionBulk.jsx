import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, MoneyInput, Page, useAccountOptions, useFundOptions } from '../components/ui.jsx';
import { money, toNum, today } from '../format.js';
import { isIncomeAccount } from './TuitionEdit.jsx';

/** Create the same tuition record (date, amount, description) for many customers at once. */
export default function TuitionBulk() {
  const navigate = useNavigate();
  const { lookups } = useApp();
  const [f, setF] = useState({ date: today(), amount: '', description: '', incomeAccountId: null, fundId: null, memo: '' });
  const [picked, setPicked] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const accountOptions = useAccountOptions(isIncomeAccount, { current: f.incomeAccountId });
  const fundOptions = useFundOptions(f.fundId);
  const customers = useMemo(() => (lookups?.companies || []).filter((c) => c.is_active), [lookups]);
  const shown = customers.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.has(c.id));
  const set = (k) => (v) => setF({ ...f, [k]: v?.target ? v.target.value : v });
  const toggle = (id) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); setPicked(s); };
  const toggleShown = () => {
    const s = new Set(picked);
    for (const c of shown) { if (allShownPicked) s.delete(c.id); else s.add(c.id); }
    setPicked(s);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/tuition/bulk', { ...f, companyIds: [...picked], skipDuplicates });
      const note = r.skipped.length ? ` ${r.skipped.length} skipped because they already had this tuition.` : '';
      navigate('/tuition', { state: { notice: `Created ${r.created} tuition record${r.created === 1 ? '' : 's'}.${note}` } });
    } catch (err) { setError(err); setBusy(false); }
  };

  const ready = picked.size > 0 && toNum(f.amount) > 0 && f.date;
  return (
    <Page title="Create Multiple Tuition Records" wide>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="bulk-layout">
        <section className="card form">
          <div className="grid g2">
            <Field label="Date" required><input type="date" className="input" value={f.date} onChange={set('date')} /></Field>
            <Field label="Tuition amount (each)" required><MoneyInput value={f.amount} onChange={set('amount')} placeholder="0.00" /></Field>
          </div>
          <Field label="Description"><input className="input" value={f.description} onChange={set('description')} placeholder="e.g. 2026–27 Tuition" /></Field>
          <div className="grid g2">
            <Field label="Income account" hint="Used when receiving payment"><Combo options={accountOptions} value={f.incomeAccountId} onChange={set('incomeAccountId')} /></Field>
            <Field label="Fund"><Combo options={fundOptions} value={f.fundId} onChange={set('fundId')} /></Field>
          </div>
          <Field label="Memo"><input className="input" value={f.memo} onChange={set('memo')} /></Field>
          <label className="check"><input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} /> Skip customers who already have tuition with this date and description</label>
          <div className="bulk-summary">
            {picked.size} customer{picked.size === 1 ? '' : 's'} selected
            {toNum(f.amount) > 0 && picked.size > 0 && <> · {money(toNum(f.amount) * picked.size)} total</>}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={create}>
              {busy ? 'Creating…' : `Create ${picked.size || ''} Tuition Record${picked.size === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/tuition')}>Cancel</button>
          </div>
        </section>

        <section className="card">
          <div className="row between gap">
            <h3 className="card-title flush">Customers</h3>
            <span className="muted small">{picked.size} of {customers.length} selected</span>
          </div>
          <div className="row gap mt">
            <input className="input grow" placeholder="Filter customers" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {picked.size > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>Clear</button>}
          </div>
          <div className="pick-list">
            <label className="check pick-all"><input type="checkbox" checked={allShownPicked} onChange={toggleShown} disabled={!shown.length} /> Select all{filter ? ' shown' : ''} ({shown.length})</label>
            {shown.map((c) => (
              <label key={c.id} className={`check pick-item${picked.has(c.id) ? ' on' : ''}`}><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /> {c.name}</label>
            ))}
            {!shown.length && <div className="muted small">No customers match.</div>}
          </div>
        </section>
      </div>
    </Page>
  );
}
