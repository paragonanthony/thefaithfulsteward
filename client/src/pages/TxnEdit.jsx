import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CircleCheck, Plus, Printer, Save, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { BankAccountSelect, Combo, ErrorBanner, Field, MoneyInput, Page, isBanking, useAccountOptions, useCompanyOptions, useFundOptions, useGoBack } from '../components/ui.jsx';
import { date, feedReturn, money, round2, toNum, today } from '../format.js';
import GlEntries from '../components/GlEntries.jsx';
import QuickAddCompany from '../components/QuickAddCompany.jsx';
import AuditInfo from '../components/AuditInfo.jsx';
import FeedMatchNote from '../components/FeedMatchNote.jsx';
import Attachments, { linkPendingAttachments } from '../components/Attachments.jsx';
import { ClosedPeriodNotice, closedPeriod } from '../components/ClosedPeriod.jsx';

let keySeq = 1;
const newLine = (over = {}) => ({ key: keySeq++, accountId: null, amount: '', memo: '', fundId: null, tuitionId: null, billId: null, billLabel: '', ...over });
const isPayable = (a) => a.account_type === 'accounts_payable';
const billLabel = (ref, d) => (ref ? `Bill ${ref}` : `Bill of ${date(d)}`);

function emptyTxn(type, lookups) {
  if (type === 'bill') {
    const ap = (lookups?.accounts || []).find((a) => isPayable(a) && a.is_active);
    return { date: today(), dueDate: '', companyId: null, amount: '', method: null, checkNumber: '', refNumber: '', accountId: ap?.id || null, memo: '', lines: [newLine()] };
  }
  const banking = (lookups?.accounts || []).filter((a) => isBanking(a) && a.is_active);
  const defaultAccount = type === 'income'
    ? (banking.find((a) => a.is_undeposited_funds) || banking[0])
    : (banking.find((a) => !a.is_undeposited_funds && a.account_type === 'bank') || banking[0]);
  return { date: today(), companyId: null, amount: '', method: 'electronic', checkNumber: '', refNumber: '', accountId: defaultAccount?.id || null, memo: '', lines: [newLine()] };
}

export default function TxnEdit({ type }) {
  const isIncome = type === 'income';
  const isBill = type === 'bill';
  const base = isIncome ? '/income' : isBill ? '/bills' : '/expenses';
  const { id } = useParams();
  const isNew = id === 'new';
  const [search] = useSearchParams();
  const feedId = search.get('feed');
  const navigate = useNavigate();
  const { lookups, me } = useApp();
  // Tuition: lines can be applied to the customer's tuition records; ?tuition=ID prefills a payment for one record.
  const tuitionOn = isIncome && Boolean(me.currentOrganization?.tuition_enabled);
  const tuitionParam = search.get('tuition');
  const fromTuition = tuitionOn && (Boolean(tuitionParam) || search.get('from') === 'tuition');
  const backTo = feedId ? feedReturn(search) : fromTuition ? '/tuition' : base;
  // Save & Close, Cancel and Delete go back to the screen this transaction was opened from.
  const goBack = useGoBack(backTo);
  const [tuitionRecs, setTuitionRecs] = useState([]);
  const [linkedTuition, setLinkedTuition] = useState(''); // tuition ids already on the saved income (kept in the list even if paid off)
  const [t, setT] = useState(null);
  const [meta, setMeta] = useState(null); // loaded record extras (gl, deposit, reconciled)
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef(null);
  const [quickAdd, setQuickAdd] = useState(null); // typed name when the New Customer/Vendor dialog is open
  const [notice, setNotice] = useState(null);
  const [reloadKey, setReloadKey] = useState(0); // bumped by Save to reload the saved record
  const [pendingFiles, setPendingFiles] = useState([]); // uploaded before the first save
  const [focusLine, setFocusLine] = useState(null); // key of a line just added: its account gets the cursor
  const [suggestCompany, setSuggestCompany] = useState(null); // name read from a document that isn't in the list yet

  const bankOptions = useAccountOptions(isBill ? isPayable : isBanking, { current: t?.accountId });
  // Detail lines list income accounts (income) or expense accounts (expenses and bills) unless "Show all" is ticked.
  // Accounts already on a line always stay in the list.
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const lineTypes = isIncome ? ['income', 'other_income'] : ['expense', 'other_expense'];
  const onLines = new Set((t?.lines || []).map((l) => l.accountId).filter(Boolean).map(String));
  const accountOptions = useAccountOptions(
    (a) => (!isBill || (!isBanking(a) && !isPayable(a))) && (showAllAccounts || lineTypes.includes(a.account_type) || onLines.has(String(a.id))),
    { key: `${showAllAccounts}|${[...onLines].sort().join(',')}` },
  );
  const fundOptions = useFundOptions();
  const companyOptions = useCompanyOptions(t?.companyId);
  const accountsById = useMemo(() => Object.fromEntries((lookups?.accounts || []).map((a) => [a.id, a])), [lookups]);
  const companiesById = useMemo(() => Object.fromEntries((lookups?.companies || []).map((c) => [c.id, c])), [lookups]);

  useEffect(() => {
    if (!lookups) return;
    setError(null);
    if (isNew) {
      const blank = emptyTxn(type, lookups);
      setMeta(null);
      if (feedId) {
        api.get(`/bank-feed/${feedId}`).then((f) => {
          const amt = Math.abs(Number(f.amount)).toFixed(2);
          // The line's customer / vendor and account (chosen on the Bank Feed or set by a rule) are the defaults.
          const company = lookups.companies.find((c) => c.id === f.company_id);
          const lineAcct = f.assigned_account_id || (company && (isIncome ? company.default_income_account_id : company.default_expense_account_id)) || null;
          const fundId = lookups.accounts.find((x) => x.id === lineAcct)?.default_fund_id || null;
          setT({ ...blank, date: f.date, accountId: f.account_id, companyId: f.company_id || null, amount: amt, memo: f.description || '', lines: [newLine({ amount: amt, accountId: lineAcct, fundId })] });
        }).catch(setError);
      } else if (tuitionOn && tuitionParam) {
        // Receive tuition: customer, remaining balance, account and fund come from the tuition record.
        api.get(`/tuition/${tuitionParam}`).then((r) => {
          const bal = Number(r.balance);
          const amt = bal > 0 ? bal.toFixed(2) : '';
          const company = lookups.companies.find((c) => c.id === r.company_id);
          const accountId = r.income_account_id || company?.default_income_account_id || null;
          const acctFund = lookups.accounts.find((a) => a.id === accountId)?.default_fund_id;
          const memo = r.description ? `Tuition: ${r.description}` : 'Tuition';
          setT({
            ...blank, companyId: r.company_id, amount: amt, memo,
            lines: [newLine({ accountId, amount: amt, fundId: acctFund || r.fund_id || null, tuitionId: r.id, memo })],
          });
        }).catch(setError);
      } else setT(blank);
      return;
    }
    api.get(`${base}/${id}`).then((d) => {
      setMeta(d);
      setT({
        date: d.date, dueDate: d.due_date || '', companyId: d.company_id, amount: Number(d.amount).toFixed(2), method: d.transaction_method || 'electronic',
        checkNumber: d.check_number || '', refNumber: d.ref_number || '', accountId: d.account_id, memo: d.memo || '',
        lines: d.lines.length ? d.lines.map((l) => newLine({ accountId: l.account_id, amount: Number(l.amount).toFixed(2), memo: l.memo || '', fundId: l.fund_id, tuitionId: l.tuition_id || null, billId: l.bill_id || null, billLabel: l.bill_id ? billLabel(l.bill_ref_number, l.bill_date) : '' })) : [newLine()],
      });
      setLinkedTuition(d.lines.map((l) => l.tuition_id).filter(Boolean).join(','));
    }).catch(setError);
  }, [id, isNew, type, base, feedId, tuitionParam, Boolean(lookups), reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open tuition records for the selected customer (plus any already linked on this income).
  const tuitionCompany = t?.companyId;
  useEffect(() => {
    if (!tuitionOn || !tuitionCompany) { setTuitionRecs([]); return; }
    api.get(`/tuition?companyId=${tuitionCompany}&status=open${linkedTuition ? `&include=${linkedTuition}` : ''}`).then(setTuitionRecs).catch(() => setTuitionRecs([]));
  }, [tuitionOn, tuitionCompany, linkedTuition]);
  const tuitionOptions = useMemo(() => tuitionRecs.map((r) => ({
    value: r.id, label: `${r.description || 'Tuition'} · ${date(r.date)}`, hint: `${money(r.balance)} due`,
  })), [tuitionRecs]);

  const title = isIncome ? 'Record Income' : isBill ? (isNew ? 'Enter Bill' : 'Bill') : 'Record Expense';
  if (!t) return <Page title={title}><ErrorBanner error={error} />{!error && <div className="muted">Loading…</div>}</Page>;

  const closed = closedPeriod(me.currentOrganization?.period_closing_date, meta?.date, t.date);
  const lineTotal = round2(t.lines.reduce((s, l) => s + toNum(l.amount), 0));
  const remaining = round2(toNum(t.amount) - lineTotal);

  // --- Spec behaviors ---------------------------------------------------------
  const setHeader = (k, v) => setT((prev) => ({ ...prev, [k]: v }));

  // Funds are chosen on the detail lines. The account's default fund (if any) is set on the line; otherwise the
  // line keeps its fund (or `fallback`, e.g. the tuition record's fund).
  const applyAccount = (line, accountId, fallback) => {
    const acct = accountsById[accountId];
    return { ...line, accountId, fundId: acct?.default_fund_id || line.fundId || fallback || null };
  };

  // Received From / Paid To: use the name's default income/expense account on the first line.
  const setCompany = (companyId, c = companiesById[companyId]) => setT((prev) => {
    const defAcct = c && (isIncome ? c.default_income_account_id : c.default_expense_account_id);
    // Tuition links belong to the previous customer, so a new customer clears them.
    const lines = prev.lines.map((l) => (companyId !== prev.companyId && l.tuitionId ? { ...l, tuitionId: null } : l));
    if (defAcct) lines[0] = applyAccount(lines[0], defAcct);
    return { ...prev, companyId, lines };
  });

  // Header amount: first line gets the amount (less any other lines).
  const setAmount = (amount) => setT((prev) => {
    const others = prev.lines.slice(1).reduce((s, l) => s + toNum(l.amount), 0);
    const first = round2(toNum(amount) - others);
    const lines = [...prev.lines];
    lines[0] = { ...lines[0], amount: amount === '' && prev.lines.length === 1 ? '' : first.toFixed(2) };
    return { ...prev, amount, lines };
  });

  const setLine = (i, patch) => setT((prev) => ({ ...prev, lines: prev.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const setLineAccount = (i, accountId) => setT((prev) => ({ ...prev, lines: prev.lines.map((l, j) => (j === i ? applyAccount(l, accountId) : l)) }));
  // Applying a line to tuition fills in the record's account, fund and remaining balance where the line is blank.
  const setLineTuition = (i, tuitionId) => setT((prev) => ({
    ...prev,
    lines: prev.lines.map((l, j) => {
      if (j !== i) return l;
      const r = tuitionRecs.find((x) => x.id === tuitionId);
      if (!r) return { ...l, tuitionId: null };
      let next = { ...l, tuitionId };
      const acct = r.income_account_id || companiesById[prev.companyId]?.default_income_account_id;
      if (!next.accountId && acct) next = applyAccount(next, acct, r.fund_id);
      if (!next.fundId && r.fund_id) next.fundId = r.fund_id;
      if (!toNum(next.amount) && Number(r.balance) > 0) next.amount = Number(r.balance).toFixed(2);
      if (!next.memo && r.description) next.memo = `Tuition: ${r.description}`;
      return next;
    }),
  }));

  // New line defaults to the unallocated remainder and the previous line's fund, and gets the cursor.
  const addLine = () => {
    const key = keySeq++;
    setFocusLine(key);
    setT((prev) => {
      const rem = round2(toNum(prev.amount) - prev.lines.reduce((s, l) => s + toNum(l.amount), 0));
      return { ...prev, lines: [...prev.lines, newLine({ key, amount: rem > 0 ? rem.toFixed(2) : '', fundId: prev.lines.at(-1)?.fundId ?? null })] };
    });
  };
  const removeLine = (i) => setT((prev) => ({ ...prev, lines: prev.lines.length > 1 ? prev.lines.filter((_, j) => j !== i) : [newLine({ fundId: prev.lines[0]?.fundId ?? null })] }));

  // Fill from document: only fields Claude found are changed; locked amounts and accounts are left alone.
  const applyExtracted = ({ fields: f }) => {
    const locked = Boolean(meta?.reconciled || meta?.deposit);
    setT((prev) => {
      const next = { ...prev };
      if (f.date) next.date = f.date;
      if (isBill && f.dueDate) next.dueDate = f.dueDate;
      if (f.memo) next.memo = f.memo;
      if (f.refNumber) next.refNumber = f.refNumber;
      if (f.checkNumber) { next.checkNumber = f.checkNumber; next.method = 'check'; }
      if (f.companyId) next.companyId = f.companyId;
      if (locked) return next;
      if (f.bankAccountId) next.accountId = f.bankAccountId;
      const company = companiesById[next.companyId];
      const defAcct = (company && (isIncome ? company.default_income_account_id : company.default_expense_account_id)) || null;
      const lineFor = (accountId, amount, memo, fundId) => newLine({ accountId, amount: amount || '', memo: memo || '', fundId: fundId || accountsById[accountId]?.default_fund_id || f.fundId || prev.lines[0]?.fundId || null });
      let lines = f.lines?.length ? f.lines.map((l) => lineFor(l.accountId || (f.lines.length === 1 ? defAcct : null), l.amount, l.memo, l.fundId)) : null;
      const amount = f.amount || (lines ? round2(lines.reduce((s, l) => s + toNum(l.amount), 0)).toFixed(2) : null);
      if (amount) next.amount = amount;
      if (!lines && amount) lines = [lineFor(prev.lines[0]?.accountId || defAcct, amount, prev.lines[0]?.memo, prev.lines[0]?.fundId)];
      if (lines?.length === 1 && amount) lines[0].amount = amount;
      if (lines) next.lines = lines;
      return next;
    });
    setSuggestCompany(!f.companyId && f.companyName ? f.companyName : null);
  };

  // --- Save -------------------------------------------------------------------
  const save = async (after) => {
    setError(null);
    // A closed-period transaction can still be printed, just not saved.
    if (closed.locked && after === 'print') { navigate(`/print/${type}/${id}`); return; }
    if (remaining !== 0) { setError(`The detail lines must add up to the amount. Unallocated: ${money(remaining)}`); return; }
    setBusy(true);
    try {
      const body = { ...t, lines: t.lines.map(({ key, ...l }) => l), bankFeedItemId: isNew && feedId ? Number(feedId) : undefined };
      const res = isNew ? await api.post(base, body) : await api.put(`${base}/${id}`, body);
      if (isNew) { await linkPendingAttachments(pendingFiles, { transactionId: res.id }); setPendingFiles([]); }
      if (after === 'stay') {
        // Save: stay on the form. A new record moves to its own address so later saves update it.
        setNotice('Saved.');
        if (isNew) navigate(`${base}/${res.id}`, { replace: true }); else setReloadKey((k) => k + 1);
      } else if (after === 'print') {
        // The print page's Back returns here, so a new record first moves to its own address.
        if (isNew) navigate(`${base}/${res.id}`, { replace: true });
        navigate(`/print/${type}/${res.id}`);
      } else if (feedId) navigate(feedReturn(search));
      else if (fromTuition && after !== 'new') goBack();
      else if (after === 'new') {
        if (isNew) { setT(emptyTxn(type, lookups)); firstField.current?.focus(); window.scrollTo(0, 0); } else navigate(`${base}/new`, { replace: true });
      } else goBack();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm('Delete this transaction? This cannot be undone.')) return;
    try { await api.del(`${base}/${id}`); goBack(); } catch (err) { setError(err); }
  };

  const reconciled = meta?.reconciled;
  const deposited = meta?.deposit;
  const billPaid = isBill && Number(meta?.paid) > 0; // vendor and A/P account are locked once a bill has payments
  const paysBills = t.lines.some((l) => l.billId);
  const billBalance = isBill && meta ? Number(meta.balance) : null;

  return (
    <Page panel title={title} wide subtitle={isBill ? <Link to="/bills">Bills</Link> : undefined}
      actions={isBill && !isNew && billBalance > 0 ? <Link className="btn" to={`/bills/pay?vendor=${t.companyId}&bill=${id}`}>Pay Bill</Link> : undefined}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <ClosedPeriodNotice state={closed} />
      <FeedMatchNote matches={meta?.feedMatches} />
      {notice && <div className="alert alert-info">{notice} <button type="button" className="link" onClick={() => setNotice(null)}>✕</button></div>}
      {suggestCompany && (
        <div className="alert alert-info">
          <span>“{suggestCompany}” from the document isn’t in your {isIncome ? 'customers and donors' : 'vendors'}.{' '}
            <button type="button" className="link" onClick={() => { setQuickAdd(suggestCompany); setSuggestCompany(null); }}>Add as a new {isIncome ? 'customer / donor' : 'vendor'}</button></span>
          <button type="button" className="link" onClick={() => setSuggestCompany(null)}>✕</button>
        </div>
      )}
      {fromTuition && isNew && <div className="alert alert-info">Recording a tuition payment. Use the Tuition column to choose which tuition record each line pays.</div>}
      {feedId && <div className="alert alert-info">Creating a transaction for a bank feed line. It will be matched automatically when saved.</div>}
      {isBill && meta && Number(meta.paid) > 0 && (
        <div className="alert alert-info">
          <div>
            <strong>{billBalance > 0 ? `Partly paid: ${money(meta.paid)} paid, ${money(billBalance)} still due.` : `Paid in full (${money(meta.paid)}).`}</strong>
            {' '}The vendor and Accounts Payable account can’t change, and the amount can’t be less than what’s been paid.
            <ul className="flush">
              {meta.payments.map((p) => (
                <li key={p.transaction_id}><Link to={`/expenses/${p.transaction_id}`}>{date(p.date)} · {p.transaction_method === 'check' && p.check_number ? `Check ${p.check_number}` : p.ref_number || 'Payment'}</Link> from {p.account_name}: {money(p.amount)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {paysBills && <div className="alert alert-info">This expense pays bills. Each bill line uses the bill’s Accounts Payable account; changing its amount changes how much of the bill is paid.</div>}
      {reconciled && <div className="alert alert-warn">This transaction is part of a completed reconciliation. Its amount and {isIncome ? 'Deposit To' : 'bank'} account are locked.</div>}
      {deposited && <div className="alert alert-warn">This income is included in a <Link to={`/deposits/${deposited.id}`}>deposit</Link>. Its amount and Deposit To account are locked.</div>}
      <form className="card form" onSubmit={(e) => { e.preventDefault(); save('close'); }}>
        <div className="grid g4">
          <Field label={isBill ? 'Bill Date' : 'Date'} required><input ref={firstField} type="date" className="input" value={t.date} onChange={(e) => setHeader('date', e.target.value)} /></Field>
          <Field label={isIncome ? 'Received From' : isBill ? 'Vendor' : 'Paid To'} className="span2" required={isBill}>
            <Combo options={companyOptions} value={t.companyId} onChange={setCompany} placeholder="Select" disabled={billPaid || paysBills}
              onCreate={(name) => setQuickAdd(name)} createLabel={isIncome ? 'customer / donor' : 'vendor'} />
          </Field>
          <Field label="Amount" required><MoneyInput currency value={t.amount} onChange={setAmount} placeholder="0.00" disabled={reconciled || deposited} /></Field>
        </div>
        {isBill ? (
          <div className="grid g4">
            <Field label="Due Date"><input type="date" className="input" value={t.dueDate} onChange={(e) => setHeader('dueDate', e.target.value)} /></Field>
            <Field label="Bill Number"><input className="input" value={t.refNumber} onChange={(e) => setHeader('refNumber', e.target.value)} placeholder="Vendor's invoice number" /></Field>
            <Field label="Accounts Payable" required className="span2"
              hint={bankOptions.length ? undefined : 'Create an account with the Accounts Payable type under Accounts & Funds'}>
              <Combo options={bankOptions} value={t.accountId} onChange={(v) => setHeader('accountId', v)} allowClear={false} disabled={billPaid} />
            </Field>
          </div>
        ) : (
        <div className="grid g4">
          <Field label="Method">
            <div className="seg">
              {['check', 'electronic'].map((m) => (
                <label key={m} className={`seg-opt${t.method === m ? ' on' : ''}`}>
                  <input type="radio" name="method" value={m} checked={t.method === m} onChange={() => setHeader('method', m)} />{m === 'check' ? 'Check' : 'Electronic'}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Check Number"><input className="input" value={t.checkNumber} onChange={(e) => setHeader('checkNumber', e.target.value)} disabled={t.method !== 'check'} /></Field>
          <Field label="Ref. Number"><input className="input" value={t.refNumber} onChange={(e) => setHeader('refNumber', e.target.value)} /></Field>
          <Field label={isIncome ? 'Deposit To' : 'Bank Account'} required>
            <BankAccountSelect options={bankOptions} value={t.accountId} onChange={(v) => setHeader('accountId', v)} allowClear={false} disabled={reconciled || deposited} />
          </Field>
        </div>
        )}
        <Field label="Memo"><input className="input" value={t.memo} onChange={(e) => setHeader('memo', e.target.value)} /></Field>

        <div className="lines">
          <table className="table lines-table">
            <thead><tr><th style={{ width: tuitionOn ? '26%' : '34%' }}>Account
              <label className="check th-check" title={`List every account, not just ${isIncome ? 'Income and Other Income' : 'Expense and Other Expense'} accounts`}>
                <input type="checkbox" checked={showAllAccounts} onChange={(e) => setShowAllAccounts(e.target.checked)} />Show all
              </label></th><th style={{ width: 140 }} className="num">Amount</th><th>Memo</th><th style={{ width: tuitionOn ? '17%' : '22%' }}>Fund</th>{tuitionOn && <th style={{ width: '20%' }}>Tuition</th>}{paysBills && <th style={{ width: '14%' }}>Bill</th>}<th style={{ width: 36 }} /></tr></thead>
            <tbody>
              {t.lines.map((l, i) => (
                <tr key={l.key}>
                  <td><Combo options={accountOptions} value={l.accountId} onChange={(v) => setLineAccount(i, v)} disabled={Boolean(l.billId)} autoFocus={l.key === focusLine} /></td>
                  <td><MoneyInput value={l.amount} onChange={(v) => setLine(i, { amount: v })} placeholder="0.00" /></td>
                  <td><input className="input" value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} /></td>
                  <td><Combo options={fundOptions} value={l.fundId} onChange={(v) => setLine(i, { fundId: v })} disabled={Boolean(l.billId)} /></td>
                  {tuitionOn && (
                    <td><Combo options={tuitionOptions} value={l.tuitionId} onChange={(v) => setLineTuition(i, v)} disabled={!t.companyId}
                      placeholder={!t.companyId ? 'Choose customer first' : tuitionOptions.length ? 'Apply to tuition' : 'No tuition due'} /></td>
                  )}
                  {paysBills && <td>{l.billId ? <Link to={`/bills/${l.billId}`}>{l.billLabel || 'Bill'}</Link> : null}</td>}
                  <td><button type="button" className="icon-btn" title="Remove line" onClick={() => removeLine(i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><button type="button" className="btn btn-sm" onClick={addLine}><Plus size={16} aria-hidden="true" />Add line</button></td>
                <td className="num strong">{money(lineTotal)}</td>
                <td colSpan={(tuitionOn ? 4 : 3) + (paysBills ? 1 : 0)} >{remaining === 0 ? <span className="pill ok"><CircleCheck size={15} aria-hidden="true" />Balanced</span> : <span className="pill warn">Unallocated: {money(remaining)}</span>}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || closed.blocked}><Save size={16} aria-hidden="true" />Save &amp; Close</button>
          <button type="button" className="btn" disabled={busy || closed.blocked} onClick={() => save('stay')}><Save size={16} aria-hidden="true" />Save</button>
          <button type="button" className="btn" disabled={busy || closed.blocked} onClick={() => save('new')}><Plus size={16} aria-hidden="true" />Save &amp; New</button>
          {!isBill && <button type="button" className="btn" disabled={busy || (closed.dateClosed && !closed.locked)} onClick={() => save('print')}><Printer size={16} aria-hidden="true" />{isIncome ? 'Print Receipt' : 'Print Check'}</button>}
          <button type="button" className="btn btn-link" onClick={goBack}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove} disabled={reconciled || deposited || closed.locked || billPaid} title={billPaid ? 'Delete the payments on this bill first' : undefined}><Trash2 size={16} aria-hidden="true" />Delete</button>}
        </div>
      </form>
      <Attachments owner={isNew ? null : { transactionId: Number(id) }} txnType={type} pending={pendingFiles} onPendingChange={setPendingFiles}
        onExtracted={applyExtracted} extractDisabled={closed.locked} />
      {meta?.gl && <GlEntries gl={meta.gl} />}
      {!isNew && <AuditInfo table="transactions" id={id} refreshKey={reloadKey} />}
      {quickAdd !== null && (
        <QuickAddCompany kind={isIncome ? 'income' : 'expense'} initialName={quickAdd} initialAccountId={t.lines[0]?.accountId || null}
          onClose={() => setQuickAdd(null)}
          onCreated={(c) => { setQuickAdd(null); setCompany(c.id, c); }} />
      )}
    </Page>
  );
}
