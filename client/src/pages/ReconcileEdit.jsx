import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, MoneyInput, Page, isBanking, useAccountOptions, useFundOptions } from '../components/ui.jsx';
import { TXN_LABEL, date, money, round2, toNum, today, txnPath } from '../format.js';
import AuditInfo from '../components/AuditInfo.jsx';
import Attachments, { linkPendingAttachments } from '../components/Attachments.jsx';
import { ClosedPeriodNotice, closedPeriod } from '../components/ClosedPeriod.jsx';

const blankAdj = (d) => ({ amount: '', date: d, accountId: null, fundId: null });
const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const readBase64 = (f) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(new Error(`Couldn't read ${f.name}`));
  reader.readAsDataURL(f);
});
// Create screens for a statement line missing from the books (as from a bank feed line).
const CREATE = { income: ['/income/new', 'Create Income'], deposit: ['/deposits/new', 'Create Deposit'], expense: ['/expenses/new', 'Create Expense'],
  journal: ['/advanced/journal-entries/new', 'Journal Entry'], transfer: ['/register/transfers/new', 'Transfer'] };
// Payment side (reduces the bank balance): expenses, and journal entries that credit this account.
const isOut = (t) => (t.direction ? t.direction === 'out' : t.transaction_type === 'expense');

export default function ReconcileEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { lookups, me } = useApp();
  const [savedDate, setSavedDate] = useState(null); // statement date as saved (for the closed-period check)
  const [rec, setRec] = useState(null);
  const [txns, setTxns] = useState([]);
  const [cleared, setCleared] = useState(new Set());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [extract, setExtract] = useState(undefined); // statement read by Claude (null = removed)
  const [match, setMatch] = useState(null);
  const [reading, setReading] = useState(false);
  const [canRead, setCanRead] = useState(false);
  const fileInput = useRef(null);
  const [pendingFiles, setPendingFiles] = useState([]); // attached before the reconciliation is first saved
  const [filesKey, setFilesKey] = useState(0);
  useEffect(() => { api.get('/attachments/config').then((c) => setCanRead(Boolean(c.extractionEnabled))).catch(() => {}); }, []);
  const bankOptions = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds);
  const accountOptions = useAccountOptions(() => true);
  const fundOptions = useFundOptions();

  const loadStart = async (accountId, base) => {
    if (!accountId) { setTxns([]); setRec({ ...base, accountId: null, beginningBalance: 0 }); return; }
    const s = await api.get(`/reconciliations/start?accountId=${accountId}`);
    if (s.inProgressId) { navigate(`/reconcile/${s.inProgressId}`, { replace: true }); return; }
    setRec({ ...base, accountId, accountType: s.account.account_type, beginningBalance: s.beginningBalance });
    setTxns(s.transactions);
    setCleared(new Set());
  };

  useEffect(() => {
    setError(null);
    if (isNew) {
      const d = today();
      loadStart(search.get('accountId') ? Number(search.get('accountId')) : null, {
        statementDate: d, statementEndingBalance: '', serviceCharge: blankAdj(d), interest: blankAdj(d), memo: '', isComplete: false,
      }).catch(setError);
      return;
    }
    api.get(`/reconciliations/${id}`).then((r) => {
      setRec({
        accountId: r.account_id, accountType: r.account_type, accountName: r.account_name, statementDate: r.statement_date,
        statementEndingBalance: Number(r.statement_ending_balance).toFixed(2), beginningBalance: Number(r.beginning_balance),
        serviceCharge: { amount: Number(r.service_charge_amount) ? Number(r.service_charge_amount).toFixed(2) : '', date: r.service_charge_date || r.statement_date, accountId: r.service_charge_account_id, fundId: r.service_charge_fund_id },
        interest: { amount: Number(r.interest_amount) ? Number(r.interest_amount).toFixed(2) : '', date: r.interest_date || r.statement_date, accountId: r.interest_account_id, fundId: r.interest_fund_id },
        memo: r.memo || '', isComplete: r.is_complete,
      });
      setTxns(r.transactions);
      setSavedDate(r.statement_date);
      const saved = new Set(r.transactions.filter((t) => t.cleared).map((t) => t.id));
      setCleared(saved);
      setExtract(r.statement_extract || undefined);
      if (r.statement_extract && !r.is_complete) {
        // Re-match: lines that were missing and now have a transaction (created from this screen) are cleared.
        api.post('/reconciliations/match-statement', { accountId: r.account_id, reconciliationId: r.transaction_id, extract: r.statement_extract }).then(({ match: m }) => {
          setMatch(m);
          const wasMissing = new Set(r.statement_extract.missing || []);
          const added = m.matched.filter((x) => wasMissing.has(x.index)).map((x) => x.transactionId);
          if (added.length) setCleared((c) => new Set([...c, ...added]));
        }).catch(setError);
      }
    }).catch(setError);
  }, [id, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    let deposits = 0; let payments = 0; let nd = 0; let np = 0;
    for (const t of txns) {
      if (!cleared.has(t.id)) continue;
      if (isOut(t)) { payments += Number(t.amount); np++; } else { deposits += Number(t.amount); nd++; }
    }
    if (!rec) return null;
    const sign = rec.accountType === 'credit_card' ? -1 : 1;
    const sc = toNum(rec.serviceCharge.amount);
    const ie = toNum(rec.interest.amount);
    const clearedBal = round2(rec.beginningBalance + sign * (deposits - payments - sc + ie));
    const ending = toNum(rec.statementEndingBalance);
    return { deposits, payments, nd, np, sc, ie, clearedBal, ending, difference: round2(clearedBal - ending) };
  }, [txns, cleared, rec]);

  if (!rec) return <Page title="Reconcile Account"><ErrorBanner error={error} /></Page>;
  const locked = rec.isComplete;
  const closed = closedPeriod(me.currentOrganization?.period_closing_date, isNew ? null : savedDate, rec.statementDate);
  const isCard = rec.accountType === 'credit_card';
  const set = (k, v) => setRec({ ...rec, [k]: v });
  const setAdj = (which, k, v) => setRec({ ...rec, [which]: { ...rec[which], [k]: v } });
  const toggle = (tid) => { if (locked) return; const s = new Set(cleared); if (s.has(tid)) s.delete(tid); else s.add(tid); setCleared(s); };
  const visible = txns.filter((t) => locked || t.date <= rec.statementDate || cleared.has(t.id));
  const setAll = (type, on) => {
    const s = new Set(cleared);
    for (const t of visible) if ((type === 'expense') === isOut(t)) { if (on) s.add(t.id); else s.delete(t.id); }
    setCleared(s);
  };

  const persist = async (complete) => {
    const statementExtract = extract === undefined ? undefined : extract && { ...extract, missing: match?.missing || [] };
    const body = { ...rec, clearedIds: [...cleared], complete, statementExtract };
    const res = isNew ? await api.post('/reconciliations', body) : await api.put(`/reconciliations/${id}`, body);
    if (isNew && pendingFiles.length) { await linkPendingAttachments(pendingFiles, { transactionId: res.id }); setPendingFiles([]); }
    return res.id;
  };
  const openReport = async () => {
    if (locked) { navigate(`/reconcile/${id}/report`); return; }
    setBusy(true); setError(null);
    try { navigate(`/reconcile/${await persist(false)}/report`); } catch (err) { setError(err); setBusy(false); }
  };
  const save = async (complete) => {
    setBusy(true);
    setError(null);
    try {
      const savedId = await persist(complete);
      if (complete) navigate('/reconcile');
      else if (isNew) navigate(`/reconcile/${savedId}`, { replace: true });
      else navigate('/reconcile');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  // ----- Statement upload -----
  const guessAccount = (kind) => {
    const list = lookups?.accounts || [];
    const re = kind === 'fee' ? /service charge|bank (fee|charge)|bank service/i : /interest/i;
    const types = kind === 'fee' ? ['expense', 'other_expense'] : ['income', 'other_income'];
    return list.find((a) => a.is_active && types.includes(a.account_type) && re.test(a.name))?.id || null;
  };
  const applyStatement = (x, m) => {
    setExtract(x);
    setMatch(m);
    setRec((prev) => {
      const end = x.statement.periodEnd || prev.statementDate;
      const adj = (cur, amount, kind) => (Number(amount)
        ? { ...cur, amount: Number(amount).toFixed(2), date: end, accountId: cur.accountId || guessAccount(kind) }
        : { ...cur, amount: '', date: end });
      return {
        ...prev,
        statementDate: end,
        statementEndingBalance: x.statement.closingBalance ?? prev.statementEndingBalance,
        serviceCharge: adj(prev.serviceCharge, m.serviceCharge, 'fee'),
        interest: adj(prev.interest, m.interest, 'interest'),
      };
    });
    setCleared(new Set(m.matched.map((y) => y.transactionId)));
  };
  const readStatement = async (f) => {
    setError(null);
    if (f.size > MAX_STATEMENT_BYTES) { setError('Statements can be at most 10 MB.'); return; }
    setReading(true);
    try {
      const r = await api.post('/reconciliations/extract-statement', { accountId: rec.accountId, reconciliationId: isNew ? undefined : Number(id), fileName: f.name, data: await readBase64(f) });
      applyStatement(r.extract, r.match);
      // The server keeps the statement file as an attachment.
      if (r.attachment) { if (isNew) setPendingFiles((p) => [...p, r.attachment]); else setFilesKey((k) => k + 1); }
    } catch (err) { setError(err); } finally { setReading(false); }
  };
  const createFrom = async (index, kind) => {
    setBusy(true); setError(null);
    try {
      const savedId = await persist(false); // keep this reconciliation (and the statement) to come back to
      const { ids: [feedId] } = await api.post('/bank-feed/lines', { accountId: rec.accountId, lines: [extract.items[index]] });
      navigate(`${CREATE[kind][0]}?feed=${feedId}&return=${encodeURIComponent(`/reconcile/${savedId}`)}`);
    } catch (err) { setError(err); setBusy(false); }
  };
  const onStatement = new Map((match?.matched || []).map((m) => [m.transactionId, extract?.items[m.index]]));
  const notOnStatement = new Set(match?.notOnStatement || []);
  const undo = async () => {
    if (!window.confirm('Undo this completed reconciliation? It will become editable again.')) return;
    try { await api.post(`/reconciliations/${id}/undo`); window.location.reload(); } catch (err) { setError(err); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this reconciliation? Cleared transactions will be released and any service charge / interest entries removed.')) return;
    try { await api.del(`/reconciliations/${id}`); navigate('/reconcile'); } catch (err) { setError(err); }
  };

  const adjRow = (which, label) => (
    <div className="grid g4 adj">
      <Field label={label}><MoneyInput value={rec[which].amount} onChange={(v) => setAdj(which, 'amount', v)} placeholder="0.00" disabled={locked} /></Field>
      <Field label="Date"><input type="date" className="input" value={rec[which].date || ''} onChange={(e) => setAdj(which, 'date', e.target.value)} disabled={locked} /></Field>
      <Field label="Account"><Combo options={accountOptions} value={rec[which].accountId} onChange={(v) => setAdj(which, 'accountId', v)} disabled={locked} placeholder="Select Account" /></Field>
      <Field label="Fund"><Combo options={fundOptions} value={rec[which].fundId} onChange={(v) => setAdj(which, 'fundId', v)} disabled={locked} placeholder="Select Fund" /></Field>
    </div>
  );

  return (
    <Page title="Reconcile Account" subtitle={locked ? 'Completed' : rec.accountName} wide
      actions={<>
        {!isNew && rec.accountId && <button type="button" className="btn" disabled={busy} onClick={openReport} title={locked ? '' : 'Saves the reconciliation, then shows the report'}>Reconciliation Report</button>}
        {locked && <button type="button" className="btn" onClick={undo} disabled={closed.locked}>Undo Reconciliation</button>}
      </>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <ClosedPeriodNotice state={closed} noun="reconciliation" />
      <div className="card form">
        <div className="grid g4">
          <Field label="Bank Account" className="span2">
            {isNew ? <Combo options={bankOptions} value={rec.accountId} onChange={(v) => loadStart(v, rec).catch(setError)} placeholder="Select Bank Account" allowClear={false} />
              : <div className="input readonly">{rec.accountName || lookups?.accounts.find((a) => a.id === rec.accountId)?.name}</div>}
          </Field>
          <Field label="Statement Ending Date"><input type="date" className="input" value={rec.statementDate} onChange={(e) => set('statementDate', e.target.value)} disabled={locked} /></Field>
          <Field label="Statement Ending Balance"><MoneyInput currency value={rec.statementEndingBalance} onChange={(v) => set('statementEndingBalance', v)} placeholder="0.00" disabled={locked} /></Field>
        </div>
        {adjRow('serviceCharge', 'Service Charge')}
        {adjRow('interest', 'Interest Earned')}
        {isCard && <p className="muted small">Credit card balances are entered as the amount owed. Charges increase the balance; credits and payments reduce it.</p>}
        {rec.accountId && !locked && canRead && !extract && (
          <div className="row gap wrap statement-upload">
            <button type="button" className="btn btn-sm" disabled={reading || busy} onClick={() => fileInput.current?.click()}>{reading ? 'Reading statement…' : 'Upload statement (PDF or image)'}</button>
            <span className="muted small">{reading ? 'Claude is reading the statement. This can take a minute for a long statement.' : 'Claude reads the statement, fills in the date, ending balance, service charge and interest, and clears the transactions on it.'}</span>
          </div>
        )}
        <input ref={fileInput} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/*" onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) readStatement(f); }} />
      </div>

      {extract && rec.accountId && (
        <div className="card statement-panel">
          <div className="row between wrap gap">
            <div>
              <strong>Statement{extract.fileName ? `: ${extract.fileName}` : ''}</strong>
              {extract.statement.periodStart && extract.statement.periodEnd && <span className="muted"> · {date(extract.statement.periodStart)} – {date(extract.statement.periodEnd)}</span>}
              {extract.statement.openingBalance !== null && extract.statement.closingBalance !== null && <span className="muted"> · balance {money(extract.statement.openingBalance)} → {money(extract.statement.closingBalance)}</span>}
              {extract.statement.balanced === true && <span className="badge ok">Lines match the balances</span>}
            </div>
            {!locked && <span className="row gap">
              <button type="button" className="btn btn-sm btn-ghost" disabled={reading || busy} onClick={() => fileInput.current?.click()}>{reading ? 'Reading…' : 'Upload a different statement'}</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setExtract(null); setMatch(null); }}>Remove</button>
            </span>}
          </div>
          {match && !locked && (
            <p className="flush">
              {match.matched.length} transaction{match.matched.length === 1 ? ' is' : 's are'} on the statement and {match.matched.length === 1 ? 'was' : 'were'} cleared.
              {match.notOnStatement.length > 0 && ` ${match.notOnStatement.length} dated on or before the statement date ${match.notOnStatement.length === 1 ? 'isn’t' : 'aren’t'} on it and ${match.notOnStatement.length === 1 ? 'was' : 'were'} left uncleared.`}
              {(Number(match.serviceCharge) > 0 || Number(match.interest) > 0) && ` Service charges (${money(match.serviceCharge)}) and interest (${money(match.interest)}) from the statement are filled in above.`}
            </p>
          )}
          {(extract.warnings.length > 0 || extract.notes) && (
            <ul className="flush warn small">
              {extract.warnings.map((w, i) => <li key={i}>{w}</li>)}
              {extract.notes && <li>Claude’s note: {extract.notes}</li>}
            </ul>
          )}
          {match && !locked && match.missing.length > 0 && (
            <>
              <h4 className="subhead">On the statement but not in your books ({match.missing.length})</h4>
              <div className="table-wrap">
                <table className="table compact">
                  <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
                  <tbody>
                    {match.missing.map((i) => {
                      const line = extract.items[i];
                      const inflow = Number(line.amount) > 0;
                      return (
                        <tr key={i}>
                          <td>{date(line.date)}</td>
                          <td>{line.description}</td>
                          <td className={`num${inflow ? '' : ' neg'}`}>{money(line.amount)}</td>
                          <td className="actions nowrap">
                            {(inflow ? ['income', 'deposit'] : ['expense']).map((k) => (
                              <button key={k} type="button" className="btn btn-sm" disabled={busy || closed.blocked} onClick={() => createFrom(i, k)}>{CREATE[k][1]}</button>
                            ))}
                            {['journal', 'transfer'].map((k) => <button key={k} type="button" className="btn btn-sm btn-ghost" disabled={busy || closed.blocked} onClick={() => createFrom(i, k)}>{CREATE[k][1]}</button>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted small flush">Creating a transaction saves this reconciliation, then brings you back here with the new transaction cleared.</p>
            </>
          )}
          {match && !locked && !match.missing.length && <p className="muted small flush">Every transaction on the statement is in your books.</p>}
        </div>
      )}

      {rec.accountId && (
        <div className="rec-layout">
          <div className="table-wrap">
            <div className="row gap between rec-tools">
              <span className="muted small">Showing transactions dated on or before the statement date.</span>
              {!locked && <span className="row gap">
                <button type="button" className="btn btn-sm" onClick={() => setAll('deposit', true)}>Mark all {isCard ? 'credits' : 'deposits'}</button>
                <button type="button" className="btn btn-sm" onClick={() => setAll('expense', true)}>Mark all {isCard ? 'charges' : 'payments'}</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCleared(new Set())}>Clear all</button>
              </span>}
            </div>
            <table className="table clickable">
              <thead><tr><th className="center">Clear</th><th>Date</th><th>Type</th><th>Number</th><th>Payee</th><th className="num">{isCard ? 'Credit' : 'Deposit'}</th><th className="num">{isCard ? 'Charge' : 'Payment'}</th></tr></thead>
              <tbody>
                {visible.map((t) => (
                  <tr key={t.id} onClick={() => toggle(t.id)} className={cleared.has(t.id) ? 'selected' : ''}>
                    <td className="center"><input type="checkbox" checked={cleared.has(t.id)} disabled={locked} onChange={() => toggle(t.id)} onClick={(e) => e.stopPropagation()} aria-label="Cleared" /></td>
                    <td>{date(t.date)}</td>
                    <td><Link to={txnPath(t.transaction_type, t.id)} onClick={(e) => e.stopPropagation()}>{TXN_LABEL[t.transaction_type]}</Link></td>
                    <td>{t.check_number || t.ref_number}</td>
                    <td>{t.company_name || (t.transaction_type === 'deposit' ? 'Deposit' : t.transaction_type === 'journal' ? t.memo || 'Journal entry' : t.transaction_type === 'transfer' ? t.memo || 'Transfer' : '')}
                      {!locked && onStatement.has(t.id) && <span className="badge ok" title={`${date(onStatement.get(t.id).date)} · ${onStatement.get(t.id).description}`}>On statement</span>}
                      {!locked && notOnStatement.has(t.id) && <span className="badge" title="Not found on the uploaded statement">Not on statement</span>}</td>
                    <td className="num">{!isOut(t) ? money(t.amount) : ''}</td>
                    <td className="num">{isOut(t) ? money(t.amount) : ''}</td>
                  </tr>
                ))}
                {!visible.length && <tr><td colSpan={7} className="muted center">No uncleared transactions for this account.</td></tr>}
              </tbody>
            </table>
          </div>

          <aside className="card rec-summary">
            <dl>
              <dt>Beginning Balance</dt><dd>{money(rec.beginningBalance)}</dd>
              <dt>{totals.nd} {isCard ? 'Credits' : 'Deposits'}</dt><dd>{money(totals.deposits)}</dd>
              <dt>{totals.np} {isCard ? 'Charges' : 'Payments'}</dt><dd>{money(totals.payments)}</dd>
              {totals.sc > 0 && <><dt>Service Charge</dt><dd>{money(-totals.sc)}</dd></>}
              {totals.ie > 0 && <><dt>Interest Earned</dt><dd>{money(totals.ie)}</dd></>}
              <dt className="sep">Cleared Balance</dt><dd className="sep">{money(totals.clearedBal)}</dd>
              <dt>Ending Balance</dt><dd>{money(totals.ending)}</dd>
              <dt className={`sep strong ${totals.difference === 0 ? 'ok' : 'warn'}`}>Difference</dt>
              <dd className={`sep strong ${totals.difference === 0 ? 'ok' : 'warn'}`}>{money(totals.difference)}</dd>
            </dl>
            {!locked && (
              <div className="stack">
                <button type="button" className="btn btn-primary btn-block" disabled={busy || totals.difference !== 0 || closed.blocked} onClick={() => save(true)}
                  title={totals.difference !== 0 ? 'The difference must be $0.00 to complete' : ''}>Complete Reconciliation</button>
                <button type="button" className="btn btn-block" disabled={busy || closed.blocked} onClick={() => save(false)}>Save &amp; Complete Later</button>
                <button type="button" className="btn btn-ghost btn-block" onClick={() => navigate('/reconcile')}>Cancel</button>
                {!isNew && <button type="button" className="btn btn-danger btn-block" onClick={remove} disabled={closed.locked}>Delete</button>}
              </div>
            )}
          </aside>
        </div>
      )}
      {rec.accountId && (
        <Attachments owner={isNew ? null : { transactionId: Number(id) }} txnType="reconciliation" pending={pendingFiles} onPendingChange={setPendingFiles} refreshKey={filesKey} />
      )}
      {!isNew && <AuditInfo table="transactions" id={id} />}
    </Page>
  );
}
