import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CircleCheck, Plus, Save } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, MoneyInput, Page, isBanking, useAccountOptions, useFundOptions, useGoBack } from '../components/ui.jsx';
import GlEntries from '../components/GlEntries.jsx';
import { feedReturn, money, round2, toNum, today } from '../format.js';
import AuditInfo from '../components/AuditInfo.jsx';
import FeedMatchNote from '../components/FeedMatchNote.jsx';
import Attachments, { linkPendingAttachments } from '../components/Attachments.jsx';
import { ClosedPeriodNotice, closedPeriod } from '../components/ClosedPeriod.jsx';

let keySeq = 1;
const newLine = (over = {}) => ({ key: keySeq++, accountId: null, fundId: null, memo: '', debit: '', credit: '', ...over });
const blankEntry = () => ({ date: today(), memo: '', lines: [newLine(), newLine()] });
const LIST = '/advanced/journal-entries';

export default function JournalEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [search] = useSearchParams();
  const feedId = isNew ? search.get('feed') : null; // creating an entry for a bank feed line
  const navigate = useNavigate();
  const goBack = useGoBack(feedId ? feedReturn(search) : LIST); // back to where the entry was opened from
  const { lookups, me } = useApp();
  const [je, setJe] = useState(isNew ? blankEntry() : null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [focusLine, setFocusLine] = useState(null); // key of a line just added
  const [reloadKey, setReloadKey] = useState(0);
  const [savedMsg, setSavedMsg] = useState(null);
  const firstField = useRef(null);
  const accountOptions = useAccountOptions(() => true);
  const fundOptions = useFundOptions();
  const accountsById = useMemo(() => Object.fromEntries((lookups?.accounts || []).map((a) => [a.id, a])), [lookups]);

  useEffect(() => {
    if (isNew) {
      setMeta(null);
      if (!feedId) { setJe(blankEntry()); return; }
      // Bank side from the feed line: money in is a debit to the bank account, money out a credit.
      api.get(`/bank-feed/${feedId}`).then((f) => {
        const amt = Math.abs(Number(f.amount)).toFixed(2);
        const inflow = Number(f.amount) > 0;
        setJe({
          date: f.date, memo: f.description || '',
          lines: [
            newLine({ accountId: f.account_id, debit: inflow ? amt : '', credit: inflow ? '' : amt, memo: f.description || '' }),
            // The other side: the line's account (chosen on the Bank Feed or set by a rule), if any.
            newLine({ accountId: f.assigned_account_id || null, fundId: accountsById[f.assigned_account_id]?.default_fund_id || null, debit: inflow ? '' : amt, credit: inflow ? amt : '' }),
          ],
        });
      }).catch(setError);
      return;
    }
    api.get(`/journal-entries/${id}`).then((d) => {
      setMeta(d);
      setJe({
        date: d.date, memo: d.memo || '',
        lines: d.lines.map((l) => newLine({
          accountId: l.account_id, fundId: l.fund_id, memo: l.memo || '', reconciled: Boolean(l.line_reconciled),
          debit: Number(l.debit) ? Number(l.debit).toFixed(2) : '', credit: Number(l.credit) ? Number(l.credit).toFixed(2) : '',
        })),
      });
    }).catch(setError);
  }, [id, isNew, feedId, reloadKey]);

  if (!je) return <Page title="Journal Entry"><ErrorBanner error={error} /></Page>;

  const closed = closedPeriod(me.currentOrganization?.period_closing_date, meta?.date, je.date);
  const debits = round2(je.lines.reduce((s, l) => s + toNum(l.debit), 0));
  const credits = round2(je.lines.reduce((s, l) => s + toNum(l.credit), 0));
  const diff = round2(debits - credits);
  const touchesBank = je.lines.some((l) => l.accountId && accountsById[l.accountId] && isBanking(accountsById[l.accountId]));
  const reconciledAccounts = [...new Set(je.lines.filter((l) => l.reconciled).map((l) => accountsById[l.accountId]?.name).filter(Boolean))];

  const setHeader = (k, v) => setJe((p) => ({ ...p, [k]: v }));
  const setLine = (i, patch) => setJe((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  // Choosing an account sets its default fund on the line; a line without a fund otherwise takes the previous line's.
  const setLineAccount = (i, accountId) => setJe((p) => ({
    ...p,
    lines: p.lines.map((l, j) => (j === i
      ? { ...l, accountId, fundId: accountsById[accountId]?.default_fund_id || l.fundId || (i > 0 ? p.lines[i - 1].fundId : null) || null }
      : l)),
  }));
  // A line is either a debit or a credit: entering one clears the other.
  const setAmount = (i, side, v) => setLine(i, side === 'debit' ? { debit: v, ...(toNum(v) ? { credit: '' } : {}) } : { credit: v, ...(toNum(v) ? { debit: '' } : {}) });
  // A new line starts with whatever amount would balance the entry, on the side that needs it, and the previous line's fund.
  const addLine = () => {
    const key = keySeq++;
    setFocusLine(key); // the new line's account gets the cursor
    setJe((p) => {
      const d = round2(p.lines.reduce((s, l) => s + toNum(l.debit) - toNum(l.credit), 0));
      const fundId = p.lines.at(-1)?.fundId ?? null;
      return { ...p, lines: [...p.lines, newLine({ key, fundId, ...(d > 0 ? { credit: d.toFixed(2) } : d < 0 ? { debit: (-d).toFixed(2) } : {}) })] };
    });
  };
  const removeLine = (i) => setJe((p) => ({ ...p, lines: p.lines.length > 2 ? p.lines.filter((_, j) => j !== i) : p.lines.map((l, j) => (j === i ? newLine() : l)) }));

  const save = async (after) => {
    setError(null);
    if (diff !== 0) { setError(`The entry is out of balance by ${money(Math.abs(diff))}. Debits must equal credits.`); return; }
    setBusy(true);
    try {
      const body = { date: je.date, memo: je.memo, lines: je.lines.map(({ key, ...l }) => l), bankFeedItemId: feedId ? Number(feedId) : undefined };
      let savedId = Number(id);
      if (isNew) {
        const r = await api.post('/journal-entries', body);
        savedId = r.id;
        await linkPendingAttachments(pendingFiles, { transactionId: r.id });
        setPendingFiles([]);
      } else await api.put(`/journal-entries/${id}`, body);
      if (after === 'stay') {
        setSavedMsg('Saved.');
        if (isNew) navigate(`${LIST}/${savedId}`, { replace: true }); else setReloadKey((k) => k + 1);
      } else if (feedId) navigate(feedReturn(search));
      else if (after === 'new') {
        if (isNew) { setJe(blankEntry()); firstField.current?.focus(); window.scrollTo(0, 0); } else navigate(`${LIST}/new`, { replace: true });
      } else goBack();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this journal entry? Its general ledger lines will be removed.')) return;
    try { await api.del(`/journal-entries/${id}`); goBack(); } catch (err) { setError(err); }
  };

  // Fill from document: replaces the lines (reconciled lines keep their account) and fills the header fields found.
  // A fund read for the whole document goes on the lines that don't have their own.
  const applyExtracted = ({ fields: f }) => setJe((p) => {
    const next = { ...p };
    if (f.date) next.date = f.date;
    if (f.memo) next.memo = f.memo;
    if (f.lines?.length && !p.lines.some((l) => l.reconciled)) {
      next.lines = f.lines.map((l) => newLine({ accountId: l.accountId, fundId: l.fundId || accountsById[l.accountId]?.default_fund_id || f.fundId || null, memo: l.memo || '', debit: l.debit || '', credit: l.credit || '' }));
      while (next.lines.length < 2) next.lines.push(newLine());
    }
    return next;
  });

  return (
    <Page panel title={isNew ? 'New Journal Entry' : `Journal Entry #${id}`} subtitle={<Link to={LIST}>Journal Entries</Link>} wide>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {savedMsg && <div className="alert alert-info">{savedMsg} <button type="button" className="link" onClick={() => setSavedMsg(null)}>✕</button></div>}
      <ClosedPeriodNotice state={closed} noun="journal entry" />
      <FeedMatchNote matches={meta?.feedMatches} />
      {feedId && <div className="alert alert-info">Creating a journal entry for a bank feed line. The bank account line is filled in; choose the other account. It will be matched automatically when saved.</div>}
      {reconciledAccounts.length > 0 && <div className="alert alert-warn">This entry is cleared in a completed reconciliation of {reconciledAccounts.join(' and ')}. Its total to {reconciledAccounts.length > 1 ? 'those accounts' : 'that account'} can't change, and it can't be deleted. Other details can still be edited.</div>}
      <form className="card form" onSubmit={(e) => { e.preventDefault(); save('close'); }}>
        <div className="grid g4">
          <Field label="Date" required><input ref={firstField} type="date" className="input" value={je.date} onChange={(e) => setHeader('date', e.target.value)} /></Field>
          <Field label="Description" className="span3"><input className="input" value={je.memo} onChange={(e) => setHeader('memo', e.target.value)} placeholder="e.g. Accrue June rent" /></Field>
        </div>

        <div className="lines">
          <table className="table lines-table">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>Account</th><th style={{ width: '18%' }}>Fund</th><th>Description</th>
                <th style={{ width: 130 }} className="num">Debit</th><th style={{ width: 130 }} className="num">Credit</th><th style={{ width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {je.lines.map((l, i) => (
                <tr key={l.key}>
                  <td><Combo options={accountOptions} value={l.accountId} onChange={(v) => setLineAccount(i, v)} disabled={l.reconciled} autoFocus={l.key === focusLine} />{l.reconciled && <span className="badge ok" title="Cleared in a completed reconciliation">Reconciled</span>}</td>
                  <td><Combo options={fundOptions} value={l.fundId} onChange={(v) => setLine(i, { fundId: v })} placeholder="No fund" /></td>
                  <td><input className="input" value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} /></td>
                  <td><MoneyInput value={l.debit} onChange={(v) => setAmount(i, 'debit', v)} placeholder="" /></td>
                  <td><MoneyInput value={l.credit} onChange={(v) => setAmount(i, 'credit', v)} placeholder="" /></td>
                  <td><button type="button" className="icon-btn" title="Remove line" onClick={() => removeLine(i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><button type="button" className="btn btn-sm" onClick={addLine}><Plus size={16} aria-hidden="true" />Add line</button></td>
                <td colSpan={2}>{diff === 0 ? (debits ? <span className="pill ok"><CircleCheck size={15} aria-hidden="true" />Balanced</span> : '') : <span className="pill warn">Out of balance by {money(Math.abs(diff))}</span>}</td>
                <td className="num strong">{money(debits)}</td>
                <td className="num strong">{money(credits)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {touchesBank && !reconciledAccounts.length && <p className="muted small flush">Lines to bank or credit card accounts appear in that account's register and can be cleared when you reconcile it.</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || closed.blocked}><Save size={16} aria-hidden="true" />Save &amp; Close</button>
          <button type="button" className="btn" disabled={busy || closed.blocked} onClick={() => save('stay')}><Save size={16} aria-hidden="true" />Save</button>
          <button type="button" className="btn" disabled={busy || closed.blocked} onClick={() => save('new')}><Plus size={16} aria-hidden="true" />Save &amp; New</button>
          <button type="button" className="btn btn-link" onClick={goBack}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove} disabled={reconciledAccounts.length > 0 || closed.locked} title={reconciledAccounts.length ? "Cleared in a completed reconciliation" : ""}>Delete</button>}
        </div>
      </form>
      <Attachments owner={isNew ? null : { transactionId: Number(id) }} txnType="journal" pending={pendingFiles} onPendingChange={setPendingFiles}
        onExtracted={applyExtracted} extractDisabled={closed.locked} />
      {meta?.gl && <GlEntries gl={meta.gl} />}
      {!isNew && <AuditInfo table="transactions" id={id} refreshKey={reloadKey} />}
    </Page>
  );
}
