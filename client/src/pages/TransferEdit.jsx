import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, MoneyInput, Page, isBanking, useAccountOptions, useFundOptions, useGoBack } from '../components/ui.jsx';
import GlEntries from '../components/GlEntries.jsx';
import AuditInfo from '../components/AuditInfo.jsx';
import FeedMatchNote from '../components/FeedMatchNote.jsx';
import Attachments, { linkPendingAttachments } from '../components/Attachments.jsx';
import { ClosedPeriodNotice, closedPeriod } from '../components/ClosedPeriod.jsx';
import { feedReturn, today } from '../format.js';

const blank = (fromAccountId = null, toAccountId = null) => ({ date: today(), fromAccountId, toAccountId, amount: '', fundId: null, memo: '', refNumber: '' });

/** Move money between two bank or credit card accounts (Dr To, Cr From). */
export default function TransferEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [search] = useSearchParams();
  const feedId = isNew ? search.get('feed') : null;
  const navigate = useNavigate();
  const goBack = useGoBack(feedId ? feedReturn(search) : '/register'); // back to where the transfer was opened from
  const { me, lookups } = useApp();
  const [tr, setTr] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [savedMsg, setSavedMsg] = useState(null);
  const accountOptions = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds, { current: tr?.fromAccountId });
  const fundOptions = useFundOptions(tr?.fundId);

  useEffect(() => {
    setError(null);
    if (isNew) {
      setMeta(null);
      const from = Number(search.get('from')) || null;
      if (!feedId) { setTr(blank(from)); return; }
      // From a bank feed line: money out of the feed account is a transfer From it; money in is a transfer To it.
      api.get(`/bank-feed/${feedId}`).then((f) => {
        const out = Number(f.amount) < 0;
        // The other side defaults to the line's account when it's a bank or card account.
        const otherAcct = lookups?.accounts.find((x) => x.id === f.assigned_account_id);
        const other = otherAcct && isBanking(otherAcct) ? otherAcct.id : null;
        setTr({ ...blank(out ? f.account_id : other, out ? other : f.account_id), date: f.date, amount: Math.abs(Number(f.amount)).toFixed(2), memo: f.description || '' });
      }).catch(setError);
      return;
    }
    api.get(`/transfers/${id}`).then((d) => {
      setMeta(d);
      const toLine = d.lines.find((l) => Number(l.debit) > 0);
      const fromLine = d.lines.find((l) => Number(l.credit) > 0);
      setTr({ date: d.date, fromAccountId: fromLine?.account_id, toAccountId: toLine?.account_id, amount: Number(d.amount).toFixed(2), fundId: d.fund_id, memo: d.memo || '', refNumber: d.ref_number || '' });
    }).catch(setError);
  }, [id, isNew, feedId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tr) return <Page title="Bank Transfer"><ErrorBanner error={error} /></Page>;
  const set = (k) => (v) => setTr({ ...tr, [k]: v?.target ? v.target.value : v });
  const closed = closedPeriod(me.currentOrganization?.period_closing_date, meta?.date, tr.date);
  const reconciled = (meta?.lines || []).some((l) => l.line_reconciled);
  const back = feedId ? feedReturn(search) : `/register${tr.fromAccountId ? `?accountId=${tr.fromAccountId}` : ''}`;

  const save = async (after) => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...tr, bankFeedItemId: feedId ? Number(feedId) : undefined };
      let savedId = Number(id);
      if (isNew) {
        const r = await api.post('/transfers', body);
        savedId = r.id;
        await linkPendingAttachments(pendingFiles, { transactionId: r.id });
        setPendingFiles([]);
      } else await api.put(`/transfers/${id}`, body);
      if (after === 'stay') {
        setSavedMsg('Saved.');
        if (isNew) navigate(`/register/transfers/${savedId}`, { replace: true }); else setReloadKey((k) => k + 1);
      } else if (after === 'new' && !feedId) {
        if (isNew) setTr(blank(tr.fromAccountId, tr.toAccountId)); else navigate(`/register/transfers/new?from=${tr.fromAccountId}`, { replace: true });
      } else if (feedId) navigate(back);
      else goBack();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const applyExtracted = ({ fields: f }) => setTr((p) => ({
    ...p,
    ...(f.date ? { date: f.date } : {}),
    ...(f.memo ? { memo: f.memo } : {}),
    ...(f.refNumber ? { refNumber: f.refNumber } : {}),
    ...(f.fundId ? { fundId: f.fundId } : {}),
    ...(!reconciled && f.amount ? { amount: f.amount } : {}),
    ...(!reconciled && f.fromAccountId ? { fromAccountId: f.fromAccountId } : {}),
    ...(!reconciled && f.toAccountId ? { toAccountId: f.toAccountId } : {}),
  }));
  const remove = async () => {
    if (!window.confirm('Delete this transfer? Its general ledger entries will be removed.')) return;
    try { await api.del(`/transfers/${id}`); goBack(); } catch (err) { setError(err); }
  };

  return (
    <Page panel title={isNew ? 'New Bank Transfer' : 'Bank Transfer'} subtitle={<Link to="/register">Bank Registers</Link>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {savedMsg && <div className="alert alert-info">{savedMsg} <button type="button" className="link" onClick={() => setSavedMsg(null)}>✕</button></div>}
      <ClosedPeriodNotice state={closed} noun="transfer" />
      <FeedMatchNote matches={meta?.feedMatches} />
      {feedId && <div className="alert alert-info">Creating a transfer for a bank feed line. It will be matched automatically when saved.</div>}
      {reconciled && <div className="alert alert-warn">This transfer is cleared in a completed reconciliation, so its accounts and amount can’t change and it can’t be deleted. The date, memo and reference can still be edited.</div>}
      <form className="card form narrow" onSubmit={(e) => { e.preventDefault(); save('close'); }}>
        <div className="grid g2">
          <Field label="Date" required><input type="date" className="input" value={tr.date} onChange={set('date')} /></Field>
          <Field label="Amount" required><MoneyInput currency value={tr.amount} onChange={set('amount')} placeholder="0.00" disabled={reconciled} /></Field>
        </div>
        <div className="transfer-accounts">
          <Field label="From account" required><Combo options={accountOptions} value={tr.fromAccountId} onChange={set('fromAccountId')} placeholder="Select account" disabled={reconciled} /></Field>
          <button type="button" className="icon-btn swap" title="Swap From and To" disabled={reconciled}
            onClick={() => setTr({ ...tr, fromAccountId: tr.toAccountId, toAccountId: tr.fromAccountId })}>⇄</button>
          <Field label="To account" required><Combo options={accountOptions} value={tr.toAccountId} onChange={set('toAccountId')} placeholder="Select account" disabled={reconciled} /></Field>
        </div>
        {tr.fromAccountId && tr.fromAccountId === tr.toAccountId && <p className="warn small flush">From and To must be different accounts.</p>}
        <div className="grid g2">
          <Field label="Fund" hint="Optional; used on both sides"><Combo options={fundOptions} value={tr.fundId} onChange={set('fundId')} /></Field>
          <Field label="Reference #"><input className="input" value={tr.refNumber} onChange={set('refNumber')} /></Field>
        </div>
        <Field label="Memo"><input className="input" value={tr.memo} onChange={set('memo')} placeholder="e.g. Move reserve to savings" /></Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || closed.blocked}><Save size={16} aria-hidden="true" />Save &amp; Close</button>
          <button type="button" className="btn" disabled={busy || closed.blocked} onClick={() => save('stay')}><Save size={16} aria-hidden="true" />Save</button>
          {!feedId && <button type="button" className="btn" disabled={busy || closed.blocked} onClick={() => save('new')}><Plus size={16} aria-hidden="true" />Save &amp; New</button>}
          <button type="button" className="btn btn-link" onClick={goBack}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove} disabled={reconciled || closed.locked}><Trash2 size={16} aria-hidden="true" />Delete</button>}
        </div>
      </form>
      <Attachments owner={isNew ? null : { transactionId: Number(id) }} txnType="transfer" pending={pendingFiles} onPendingChange={setPendingFiles}
        onExtracted={applyExtracted} extractDisabled={closed.locked} />
      {meta?.gl && <GlEntries gl={meta.gl} />}
      {!isNew && <AuditInfo table="transactions" id={id} refreshKey={reloadKey} />}
    </Page>
  );
}
