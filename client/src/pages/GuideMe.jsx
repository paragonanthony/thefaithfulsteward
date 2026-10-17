import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, FileText, Landmark, Receipt, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, MoneyInput, Page, isBanking, useAccountOptions, useCompanyOptions, useFundOptions } from '../components/ui.jsx';
import QuickAddCompany from '../components/QuickAddCompany.jsx';
import { date, money, round2, toNum, today } from '../format.js';

// Guide Me: step-by-step wizards for the everyday entries (income, expenses, bills and deposits), in plain language.
// Each one asks one thing at a time, shows a plain-English summary, and saves through the same API as the full forms.

const KINDS = [
  { key: 'income', icon: Wallet, title: 'I received money', desc: 'A donation, grant, payment or other money that came in.' },
  { key: 'expense', icon: Receipt, title: 'I paid for something', desc: 'A purchase or payment made by check, card, cash or transfer.' },
  { key: 'bill', icon: FileText, title: 'I got a bill to pay later', desc: 'An invoice from a vendor that you haven’t paid yet.' },
  { key: 'deposit', icon: Landmark, title: 'I took money to the bank', desc: 'Checks and cash you recorded earlier, now deposited together.' },
];
const TITLES = { income: 'Record money you received', expense: 'Record a payment', bill: 'Enter a bill', deposit: 'Record a bank deposit' };
const isIncomeType = (a) => a.account_type === 'income' || a.account_type === 'other_income';
const isExpenseType = (a) => a.account_type === 'expense' || a.account_type === 'other_expense';
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

/** The step frame: progress, one question, Back / Next. */
function Wizard({ steps, step, setStep, onFinish, busy, finishLabel }) {
  const s = steps[step];
  const [err, setErr] = useState(null);
  useEffect(() => setErr(null), [step]);
  const next = () => {
    const problem = s.check?.();
    if (problem) { setErr(problem); return; }
    if (step === steps.length - 1) onFinish(); else setStep(step + 1);
  };
  return (
    <form className="card guide-card" onSubmit={(e) => { e.preventDefault(); next(); }}>
      <ol className="guide-steps" aria-label="Steps">
        {steps.map((x, i) => (
          <li key={x.key} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <button type="button" disabled={i > step} onClick={() => i < step && setStep(i)}>
              <span className="guide-dot">{i < step ? <Check size={13} aria-hidden="true" /> : i + 1}</span><span className="guide-step-name">{x.label}</span>
            </button>
          </li>
        ))}
      </ol>
      <h2 className="guide-q">{s.title}</h2>
      {s.help && <p className="muted guide-help">{s.help}</p>}
      <div className="guide-body">{s.render()}</div>
      {err && <div className="alert alert-error mt">{err}</div>}
      <div className="guide-nav">
        <button type="button" className="btn" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}><ArrowLeft size={16} aria-hidden="true" />Back</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {step === steps.length - 1 ? <><Check size={16} aria-hidden="true" />{busy ? 'Saving…' : finishLabel}</> : <>Next<ArrowRight size={16} aria-hidden="true" /></>}
        </button>
      </div>
    </form>
  );
}

/** Plain-English review lines. */
const Review = ({ rows, sentence }) => (
  <>
    <p className="guide-sentence">{sentence}</p>
    <dl className="guide-review">{rows.filter(([, v]) => v).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
    <p className="muted small">Something not right? Use Back to change it. You can also edit it later like any other transaction.</p>
  </>
);

/** Income, expenses and bills. */
function MoneyFlow({ kind, onSaved }) {
  const { lookups } = useApp();
  const isIncome = kind === 'income';
  const isBill = kind === 'bill';
  const accounts = lookups?.accounts || [];
  const byId = useMemo(() => Object.fromEntries(accounts.map((a) => [a.id, a])), [accounts]);
  const companies = useMemo(() => Object.fromEntries((lookups?.companies || []).map((c) => [c.id, c])), [lookups]);
  const undeposited = accounts.find((a) => a.is_undeposited_funds && a.is_active);
  const payables = accounts.filter((a) => a.account_type === 'accounts_payable' && a.is_active);
  const [f, setF] = useState(() => ({
    companyId: null, amount: '', date: today(), dueDate: '', terms: 30, refNumber: '', method: null, checkNumber: '',
    accountId: isBill ? payables[0]?.id || null : null, lineAccountId: null, fundId: null, memo: '',
  }));
  const set = (patch) => setF((p) => ({ ...p, ...patch }));
  const [step, setStep] = useState(0);
  const [quickAdd, setQuickAdd] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const companyOptions = useCompanyOptions(f.companyId);
  const lineOptions = useAccountOptions(isIncome ? isIncomeType : isExpenseType, { current: f.lineAccountId });
  const bankOptions = useAccountOptions((a) => isBanking(a) && (isIncome || !a.is_undeposited_funds), { current: f.accountId });
  const cardOptions = useAccountOptions((a) => a.account_type === 'credit_card', { current: f.accountId });
  const plainBankOptions = useAccountOptions((a) => a.account_type === 'bank' && !a.is_undeposited_funds, { current: f.accountId });
  const fundOptions = useFundOptions(f.fundId);
  const company = companies[f.companyId];

  // A name's default account fills in "what was it for", and the account's default fund fills in the fund.
  const chooseCompany = (id, c = companies[id]) => {
    const def = c && (isIncome ? c.default_income_account_id : c.default_expense_account_id);
    set({ companyId: id, ...(def && !f.lineAccountId ? { lineAccountId: def, fundId: byId[def]?.default_fund_id || f.fundId } : {}) });
  };
  const chooseLine = (id) => set({ lineAccountId: id, fundId: byId[id]?.default_fund_id || f.fundId });
  const chooseMethod = (method) => {
    // Checks and cash usually wait in Undeposited Funds until they're taken to the bank.
    let accountId = f.accountId;
    if (isIncome) accountId = method === 'electronic' ? (accounts.find((a) => a.account_type === 'bank' && !a.is_undeposited_funds && a.is_active)?.id || null) : (undeposited?.id || accountId);
    else if (method === 'card') accountId = accounts.find((a) => a.account_type === 'credit_card' && a.is_active)?.id || null;
    else if (!accountId || byId[accountId]?.account_type === 'credit_card') accountId = accounts.find((a) => a.account_type === 'bank' && !a.is_undeposited_funds && a.is_active)?.id || null;
    set({ method, accountId });
  };

  const who = isIncome ? 'Who did the money come from?' : isBill ? 'Who is the bill from?' : 'Who did you pay?';
  const steps = [
    {
      key: 'who', label: isIncome ? 'From' : 'Vendor', title: who,
      help: isIncome ? 'Pick the donor, customer or other source. If it was anonymous or doesn’t matter, leave it blank.' : isBill ? 'Pick the vendor who sent the bill, or add a new one.' : 'Pick the store, vendor or person you paid, or add a new one. It can be left blank.',
      check: () => (isBill && !f.companyId ? 'Choose the vendor (type a new name to add it).' : null),
      render: () => (
        <Field label={isIncome ? 'Customer / donor' : 'Vendor'}>
          <Combo options={companyOptions} value={f.companyId} onChange={(v) => chooseCompany(v)} placeholder="Start typing a name"
            onCreate={(name) => setQuickAdd(name)} createLabel={isIncome ? 'customer / donor' : 'vendor'} />
        </Field>
      ),
    },
    {
      key: 'amount', label: 'Amount', title: isBill ? 'How much is the bill, and when is it due?' : 'How much, and on what date?',
      help: isBill ? 'Use the bill’s total and the date on the bill.' : isIncome ? 'Use the date you received it.' : 'Use the date you paid.',
      check: () => {
        if (!(toNum(f.amount) > 0)) return 'Enter an amount greater than zero.';
        if (!f.date) return 'Enter the date.';
        if (isBill && !f.dueDate) return 'Choose when the bill is due.';
        return null;
      },
      render: () => (
        <div className="grid g2">
          <Field label="Amount" required><MoneyInput currency value={f.amount} onChange={(v) => set({ amount: v })} placeholder="0.00" autoFocus /></Field>
          <Field label={isBill ? 'Bill date' : 'Date'} required>
            <input type="date" className="input" value={f.date} onChange={(e) => set({ date: e.target.value, ...(isBill && f.terms !== null ? { dueDate: addDays(e.target.value, f.terms) } : {}) })} />
          </Field>
          {isBill && (
            <>
              <Field label="When is it due?">
                <div className="seg">
                  {[[0, 'On receipt'], [15, 'In 15 days'], [30, 'In 30 days'], [null, 'Other date']].map(([d, l]) => (
                    <label key={l} className={`seg-opt${f.terms === d ? ' on' : ''}`}>
                      <input type="radio" name="terms" checked={f.terms === d} onChange={() => set({ terms: d, ...(d !== null ? { dueDate: addDays(f.date, d) } : {}) })} />{l}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Due date" required><input type="date" className="input" value={f.dueDate || addDays(f.date, f.terms ?? 0)} onChange={(e) => set({ dueDate: e.target.value, terms: null })} /></Field>
              <Field label="Bill / invoice number" hint="Optional"><input className="input" value={f.refNumber} onChange={(e) => set({ refNumber: e.target.value })} /></Field>
            </>
          )}
        </div>
      ),
    },
  ];
  if (!isBill) {
    steps.push({
      key: 'how', label: isIncome ? 'Received' : 'Paid with', title: isIncome ? 'How did you receive it, and where is it now?' : 'How did you pay?',
      help: isIncome
        ? 'If you’re holding checks or cash to take to the bank later, keep it in Undeposited Funds. Then use “I took money to the bank” when you deposit it.'
        : 'Choose the account the money came out of.',
      check: () => {
        if (!f.method) return 'Choose how it was paid.';
        if (!f.accountId) return isIncome ? 'Choose where the money is.' : 'Choose the account it was paid from.';
        return null;
      },
      render: () => {
        const methods = isIncome ? [['check', 'A check'], ['cash', 'Cash'], ['electronic', 'Electronic / online']] : [['check', 'A check'], ['card', 'Credit card'], ['electronic', 'Debit, transfer or online'], ['cash', 'Cash']];
        const opts = isIncome ? bankOptions : f.method === 'card' ? cardOptions : plainBankOptions;
        return (
          <>
            <div className="guide-choices">
              {methods.map(([m, l]) => <button key={m} type="button" className={`guide-choice${f.method === m ? ' on' : ''}`} onClick={() => chooseMethod(m)}>{l}</button>)}
            </div>
            {f.method && (
              <div className="grid g2 mt">
                <Field label={isIncome ? 'Where is the money now?' : f.method === 'card' ? 'Which card?' : 'Paid from'} required>
                  <Combo options={opts} value={f.accountId} onChange={(v) => set({ accountId: v })} placeholder="Choose an account" />
                </Field>
                {f.method === 'check' && <Field label="Check number" hint="Optional"><input className="input" value={f.checkNumber} onChange={(e) => set({ checkNumber: e.target.value })} /></Field>}
              </div>
            )}
          </>
        );
      },
    });
  } else if (payables.length > 1) {
    steps.push({
      key: 'ap', label: 'Payable', title: 'Which Accounts Payable account?', help: 'Your chart of accounts has more than one Accounts Payable account.',
      check: () => (!f.accountId ? 'Choose the Accounts Payable account.' : null),
      render: () => <Field label="Accounts Payable"><Combo options={payables.map((a) => ({ value: a.id, label: a.account_number ? `${a.account_number} · ${a.name}` : a.name }))} value={f.accountId} onChange={(v) => set({ accountId: v })} allowClear={false} /></Field>,
    });
  }
  steps.push({
    key: 'what', label: 'For', title: isIncome ? 'What was the money for?' : 'What was it for?',
    help: isIncome ? 'Pick the kind of income (for example donations, grants or program fees). If the money must be used for a particular purpose, choose that fund.' : 'Pick the kind of expense. If it was paid for a particular program or restricted purpose, choose that fund.',
    check: () => (!f.lineAccountId ? `Choose the ${isIncome ? 'income' : 'expense'} account.` : null),
    render: () => (
      <div className="grid g2">
        <Field label={isIncome ? 'Income account' : 'Expense account'} required className="span2"><Combo options={lineOptions} value={f.lineAccountId} onChange={chooseLine} placeholder="Choose an account" /></Field>
        <Field label="Fund" hint="Optional"><Combo options={fundOptions} value={f.fundId} onChange={(v) => set({ fundId: v })} placeholder="No fund" /></Field>
        <Field label="Note" hint="Optional, e.g. what it was"><input className="input" value={f.memo} onChange={(e) => set({ memo: e.target.value })} /></Field>
      </div>
    ),
  });
  const acctName = (id) => { const a = byId[id]; return a ? (a.account_number ? `${a.account_number} · ${a.name}` : a.name) : ''; };
  const fundName = (lookups?.funds || []).find((x) => x.id === f.fundId)?.name;
  const methodText = { check: `check${f.checkNumber ? ` #${f.checkNumber}` : ''}`, cash: 'cash', card: 'credit card', electronic: isIncome ? 'electronic payment' : 'debit, transfer or online payment' }[f.method];
  const amt = money(round2(toNum(f.amount)));
  const sentence = isIncome
    ? `You received ${amt}${company ? ` from ${company.name}` : ''} on ${date(f.date)} by ${methodText}, now in ${acctName(f.accountId)}, recorded as ${acctName(f.lineAccountId)}${fundName ? ` (${fundName})` : ''}.`
    : isBill
      ? `${company?.name || 'The vendor'} billed you ${amt} on ${date(f.date)}, due ${date(f.dueDate || addDays(f.date, f.terms ?? 0))}, for ${acctName(f.lineAccountId)}${fundName ? ` (${fundName})` : ''}.`
      : `You paid ${amt}${company ? ` to ${company.name}` : ''} on ${date(f.date)} by ${methodText} from ${acctName(f.accountId)}, recorded as ${acctName(f.lineAccountId)}${fundName ? ` (${fundName})` : ''}.`;
  steps.push({
    key: 'review', label: 'Review', title: 'Does this look right?', help: null,
    check: () => (isBill && !f.accountId ? 'There’s no Accounts Payable account yet. Add one under Accounts & Funds first.' : null),
    render: () => (
      <Review sentence={sentence} rows={[
        [isIncome ? 'From' : 'Vendor', company?.name || '—'], ['Amount', amt], [isBill ? 'Bill date' : 'Date', date(f.date)],
        ...(isBill ? [['Due', date(f.dueDate || addDays(f.date, f.terms ?? 0))], ['Bill number', f.refNumber]] : [[isIncome ? 'Deposited to' : 'Paid from', acctName(f.accountId)], ['Method', methodText]]),
        ['Account', acctName(f.lineAccountId)], ['Fund', fundName], ['Note', f.memo],
      ]} />
    ),
  });

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const amount = round2(toNum(f.amount)).toFixed(2);
      const body = {
        date: f.date, amount, accountId: f.accountId, companyId: f.companyId, memo: f.memo || null,
        lines: [{ accountId: f.lineAccountId, amount, fundId: f.fundId, memo: f.memo || null }],
        ...(isBill
          ? { dueDate: f.dueDate || addDays(f.date, f.terms ?? 0), refNumber: f.refNumber || null }
          : { method: f.method === 'check' ? 'check' : 'electronic', checkNumber: f.method === 'check' ? f.checkNumber || null : null, refNumber: f.method === 'cash' ? 'Cash' : null }),
      };
      const r = await api.post(isIncome ? '/income' : isBill ? '/bills' : '/expenses', body);
      onSaved({ kind, id: r.id, sentence, toUndeposited: isIncome && byId[f.accountId]?.is_undeposited_funds, companyId: f.companyId });
    } catch (e) { setError(e); setBusy(false); }
  };

  return (
    <>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Wizard steps={steps} step={step} setStep={setStep} onFinish={save} busy={busy} finishLabel={isBill ? 'Save bill' : 'Save'} />
      {quickAdd !== null && (
        <QuickAddCompany kind={isIncome ? 'income' : 'expense'} initialName={quickAdd} onClose={() => setQuickAdd(null)}
          onCreated={(c) => { setQuickAdd(null); chooseCompany(c.id, c); }} />
      )}
    </>
  );
}

/** Deposits: which bank, which waiting items, date. */
function DepositFlow({ onSaved }) {
  const { lookups } = useApp();
  const accounts = lookups?.accounts || [];
  const [items, setItems] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [f, setF] = useState(() => ({ accountId: accounts.find((a) => a.account_type === 'bank' && !a.is_undeposited_funds && a.is_active)?.id || null, date: today(), memo: '' }));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bankOptions = useAccountOptions((a) => a.account_type === 'bank' && !a.is_undeposited_funds, { current: f.accountId });
  useEffect(() => { api.get('/undeposited-funds').then(setItems).catch(setError); }, []);
  const chosen = (items || []).filter((i) => picked.has(i.id));
  const total = round2(chosen.reduce((s, i) => s + Number(i.amount), 0));
  const bankName = accounts.find((a) => a.id === f.accountId)?.name || '';
  const toggle = (id) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); setPicked(s); };

  if (items && !items.length) {
    return (
      <div className="card guide-card">
        <h2 className="guide-q">There’s nothing waiting to be deposited</h2>
        <p className="muted">A deposit groups the checks and cash you recorded as received into <strong>Undeposited Funds</strong>. Record those first with “I received money”, then come back here when you take them to the bank.</p>
        <p className="muted small">Money that went straight into the bank (like an online donation) doesn’t need a deposit; record it with “I received money” and choose the bank account.</p>
        <div className="guide-nav"><Link className="btn btn-primary" to="/guide/income">I received money</Link></div>
      </div>
    );
  }
  const steps = [
    {
      key: 'items', label: 'Items', title: 'Which checks and cash did you deposit?', help: 'Tick everything on your deposit slip. The total should match the slip.',
      check: () => (!chosen.length ? 'Tick at least one item.' : null),
      render: () => !items ? <p className="muted">Loading…</p> : (
        <>
          <div className="row between wrap gap">
            <button type="button" className="link" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>{picked.size === items.length ? 'Untick all' : 'Tick all'}</button>
            <strong>{chosen.length} item{chosen.length === 1 ? '' : 's'} · {money(total)}</strong>
          </div>
          <div className="table-wrap mt">
            <table className="table clickable compact">
              <thead><tr><th style={{ width: 36 }} /><th>Received</th><th>From</th><th>Check</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} onClick={() => toggle(i.id)} className={picked.has(i.id) ? 'selected' : ''}>
                    <td className="center"><input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} aria-label="Include" /></td>
                    <td>{date(i.date)}</td><td>{i.company_name}</td><td>{i.check_number}</td><td className="num">{money(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ),
    },
    {
      key: 'bank', label: 'Bank', title: 'Which bank account, and on what date?', help: 'Use the date on the deposit slip.',
      check: () => (!f.accountId ? 'Choose the bank account.' : !f.date ? 'Enter the date.' : null),
      render: () => (
        <div className="grid g2">
          <Field label="Bank account" required><Combo options={bankOptions} value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} placeholder="Choose a bank account" /></Field>
          <Field label="Deposit date" required><input type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Note" hint="Optional" className="span2"><input className="input" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
        </div>
      ),
    },
  ];
  const sentence = `You deposited ${chosen.length} item${chosen.length === 1 ? '' : 's'} totaling ${money(total)} into ${bankName} on ${date(f.date)}.`;
  steps.push({
    key: 'review', label: 'Review', title: 'Does this match your deposit slip?',
    render: () => <Review sentence={sentence} rows={[['Bank account', bankName], ['Date', date(f.date)], ['Items', `${chosen.length}`], ['Total', money(total)], ['Note', f.memo]]} />,
  });
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/deposits', { date: f.date, accountId: f.accountId, memo: f.memo || null, incomeIds: chosen.map((i) => i.id) });
      onSaved({ kind: 'deposit', id: r.id, sentence });
    } catch (e) { setError(e); setBusy(false); }
  };
  return (
    <>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Wizard steps={steps} step={step} setStep={setStep} onFinish={save} busy={busy} finishLabel="Save deposit" />
    </>
  );
}

const PATHS = { income: '/income', expense: '/expenses', bill: '/bills', deposit: '/deposits' };

export default function GuideMe() {
  const { kind } = useParams();
  const navigate = useNavigate();
  const [done, setDone] = useState(null);
  const [round, setRound] = useState(0); // restarts the wizard for "another one"
  useEffect(() => { setDone(null); }, [kind]);
  const k = KINDS.find((x) => x.key === kind);

  if (!k) {
    return (
      <Page title="Guide Me" subtitle="Answer a few questions and the entry is made for you">
        <p className="muted">What happened? Pick the one that fits.</p>
        <div className="guide-kinds">
          {KINDS.map(({ key, icon: Icon, title, desc }) => (
            <Link key={key} to={`/guide/${key}`} className="guide-kind">
              <span className="guide-kind-icon" aria-hidden="true"><Icon size={22} /></span>
              <span className="guide-kind-title">{title}</span>
              <span className="guide-kind-desc">{desc}</span>
            </Link>
          ))}
        </div>
        <p className="muted small mt">Not sure? Money you <em>received</em> is income. Money you <em>spent</em> is an expense; if you haven’t paid it yet, it’s a bill. When you take checks you already recorded to the bank, that’s a deposit.</p>
      </Page>
    );
  }
  return (
    <Page title={TITLES[kind]} subtitle={<Link to="/guide">Guide Me</Link>}>
      {done ? (
        <div className="card guide-card">
          <h2 className="guide-q"><Check size={22} aria-hidden="true" className="ok" /> Saved</h2>
          <p className="guide-sentence">{done.sentence}</p>
          <div className="guide-nav wrap">
            <button type="button" className="btn btn-primary" onClick={() => { setDone(null); setRound((r) => r + 1); }}>Record another</button>
            {done.toUndeposited && <Link className="btn" to="/guide/deposit">Deposit it now</Link>}
            {done.kind === 'bill' && <Link className="btn" to={`/bills/pay?vendor=${done.companyId}&bill=${done.id}`}>Pay this bill now</Link>}
            <Link className="btn" to={`${PATHS[done.kind]}/${done.id}`}>Open it</Link>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/guide')}>Done</button>
          </div>
        </div>
      ) : kind === 'deposit'
        ? <DepositFlow key={round} onSaved={setDone} />
        : <MoneyFlow key={`${kind}-${round}`} kind={kind} onSaved={setDone} />}
    </Page>
  );
}
