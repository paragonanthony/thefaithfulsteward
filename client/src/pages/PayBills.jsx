import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, MoneyInput, Page, isBanking, useAccountOptions, useGoBack } from '../components/ui.jsx';
import { date, money, round2, toNum, today } from '../format.js';

/** Pay one or more of a vendor's bills, in full or in part, with one check or electronic payment (an expense). */
export default function PayBills() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const goBack = useGoBack('/bills');
  const { lookups } = useApp();
  const [open, setOpen] = useState(null); // every unpaid bill
  const [vendorId, setVendorId] = useState(Number(search.get('vendor')) || null);
  const [amounts, setAmounts] = useState({}); // billId -> payment amount (string)
  const [pay, setPay] = useState(() => {
    const banks = (lookups?.accounts || []).filter((a) => a.account_type === 'bank' && a.is_active && !a.is_undeposited_funds);
    return { date: today(), accountId: banks[0]?.id || null, method: 'check', checkNumber: '', refNumber: '', memo: '' };
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const payFromOptions = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds, { current: pay.accountId });
  useEffect(() => {
    if (pay.accountId || !lookups) return;
    const bank = lookups.accounts.find((a) => a.account_type === 'bank' && a.is_active && !a.is_undeposited_funds);
    if (bank) setPay((p) => ({ ...p, accountId: bank.id }));
  }, [lookups]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/bills?status=open').then((rows) => {
      setOpen(rows);
      // Opened from a bill's Pay button: that bill starts selected for its full balance.
      const billId = Number(search.get('bill'));
      const b = rows.find((x) => x.id === billId);
      if (b) { setVendorId(b.company_id); setAmounts({ [b.id]: Number(b.balance).toFixed(2) }); }
    }).catch(setError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Vendors that have unpaid bills, with how much is owed.
  const vendorOptions = useMemo(() => {
    const by = new Map();
    for (const b of open || []) {
      const v = by.get(b.company_id) || { value: b.company_id, label: b.company_name, count: 0, total: 0 };
      v.count += 1; v.total += Number(b.balance);
      by.set(b.company_id, v);
    }
    return [...by.values()].sort((a, b) => a.label.localeCompare(b.label)).map((v) => ({ ...v, hint: `${v.count} bill${v.count === 1 ? '' : 's'} · ${money(v.total)}` }));
  }, [open]);
  const bills = (open || []).filter((b) => b.company_id === vendorId);
  const chosen = bills.filter((b) => toNum(amounts[b.id]) !== 0);
  const total = round2(chosen.reduce((s, b) => s + toNum(amounts[b.id]), 0));
  const over = chosen.filter((b) => round2(toNum(amounts[b.id])) > Number(b.balance));
  const now = today();

  const chooseVendor = (v) => { setVendorId(v); setAmounts({}); setError(null); };
  const toggle = (b, on) => setAmounts((a) => { const n = { ...a }; if (on) n[b.id] = Number(b.balance).toFixed(2); else delete n[b.id]; return n; });
  const selectAll = () => setAmounts(Object.fromEntries(bills.map((b) => [b.id, Number(b.balance).toFixed(2)])));

  const submit = async (print) => {
    setError(null);
    if (!chosen.length) { setError('Choose at least one bill to pay.'); return; }
    if (over.length) { setError('A payment can’t be more than the bill’s balance.'); return; }
    if (chosen.some((b) => toNum(amounts[b.id]) < 0)) { setError('Payments must be more than zero.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/bill-payments', {
        ...pay, companyId: vendorId, checkNumber: pay.method === 'check' ? pay.checkNumber : '',
        payments: chosen.map((b) => ({ billId: b.id, amount: toNum(amounts[b.id]).toFixed(2) })),
      });
      navigate(`/expenses/${r.id}`, { replace: true });
      if (print) navigate(`/print/expense/${r.id}`);
    } catch (e) { setError(e); setBusy(false); }
  };

  return (
    <Page title="Pay Bills" wide subtitle={<Link to="/bills">Bills</Link>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="card form">
        <div className="grid g4">
          <Field label="Vendor" required className="span2">
            <Combo options={vendorOptions} value={vendorId} onChange={chooseVendor} placeholder={open && !vendorOptions.length ? 'No unpaid bills' : 'Choose a vendor with unpaid bills'} />
          </Field>
          <Field label="Payment Date" required><input type="date" className="input" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
          <Field label="Pay From" required><Combo options={payFromOptions} value={pay.accountId} onChange={(v) => setPay({ ...pay, accountId: v })} allowClear={false} /></Field>
        </div>
        <div className="grid g4">
          <Field label="Method">
            <div className="seg">
              {['check', 'electronic'].map((m) => (
                <label key={m} className={`seg-opt${pay.method === m ? ' on' : ''}`}>
                  <input type="radio" name="method" value={m} checked={pay.method === m} onChange={() => setPay({ ...pay, method: m })} />{m === 'check' ? 'Check' : 'Electronic'}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Check Number"><input className="input" value={pay.checkNumber} disabled={pay.method !== 'check'} onChange={(e) => setPay({ ...pay, checkNumber: e.target.value })} /></Field>
          <Field label="Ref. Number"><input className="input" value={pay.refNumber} onChange={(e) => setPay({ ...pay, refNumber: e.target.value })} /></Field>
          <Field label="Memo"><input className="input" value={pay.memo} onChange={(e) => setPay({ ...pay, memo: e.target.value })} placeholder="Printed on the check" /></Field>
        </div>

        {vendorId && (
          <div className="lines">
            <table className="table lines-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" aria-label="Pay all bills" checked={bills.length > 0 && chosen.length === bills.length} onChange={(e) => (e.target.checked ? selectAll() : setAmounts({}))} /></th>
                  <th>Bill Date</th><th>Due</th><th>Bill #</th><th>Memo</th>
                  <th className="num">Amount</th><th className="num">Balance</th><th className="num" style={{ width: 150 }}>Payment</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => {
                  const v = amounts[b.id] ?? '';
                  const tooMuch = round2(toNum(v)) > Number(b.balance);
                  return (
                    <tr key={b.id}>
                      <td><input type="checkbox" aria-label={`Pay bill ${b.ref_number || b.id}`} checked={toNum(v) !== 0} onChange={(e) => toggle(b, e.target.checked)} /></td>
                      <td><Link to={`/bills/${b.id}`}>{date(b.date)}</Link></td>
                      <td className={b.due_date && b.due_date < now ? 'neg' : ''}>{b.due_date ? date(b.due_date) : ''}</td>
                      <td>{b.ref_number}</td>
                      <td className="muted">{b.memo}</td>
                      <td className="num">{money(b.amount)}</td>
                      <td className="num">{money(b.balance)}</td>
                      <td>
                        <MoneyInput value={v} placeholder="0.00" aria-label={`Payment for bill ${b.ref_number || b.id}`} onChange={(x) => setAmounts((a) => ({ ...a, [b.id]: x }))} />
                        {tooMuch && <div className="warn small">More than the balance</div>}
                        {!tooMuch && toNum(v) > 0 && toNum(v) < Number(b.balance) && <div className="muted small">Partial: {money(Number(b.balance) - toNum(v))} left</div>}
                      </td>
                    </tr>
                  );
                })}
                {!bills.length && <tr><td colSpan={8} className="muted center">This vendor has no unpaid bills.</td></tr>}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={7} className="num strong">Total payment</td>
                  <td className="num strong">{money(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="muted small flush">Check the bills to pay. Each starts at its full balance; enter a smaller amount to pay part of a bill. One {pay.method === 'check' ? 'check' : 'payment'} is recorded for the total, as an expense whose lines pay down each bill.</p>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !chosen.length || total <= 0} onClick={() => submit(false)}>Pay {total > 0 ? money(total) : 'Bills'}</button>
          {pay.method === 'check' && <button type="button" className="btn" disabled={busy || !chosen.length || total <= 0} onClick={() => submit(true)}>Pay &amp; Print Check</button>}
          <button type="button" className="btn btn-ghost" onClick={goBack}>Cancel</button>
        </div>
      </div>
    </Page>
  );
}
