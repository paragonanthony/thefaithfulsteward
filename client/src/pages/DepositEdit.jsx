import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Printer, Save, Trash2 } from 'lucide-react';
import { api, qs } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, Modal, Page, isBanking, useAccountOptions, useGoBack } from '../components/ui.jsx';
import { date, feedReturn, money, round2, today } from '../format.js';
import GlEntries from '../components/GlEntries.jsx';
import AuditInfo from '../components/AuditInfo.jsx';
import FeedMatchNote from '../components/FeedMatchNote.jsx';
import { ClosedPeriodNotice, closedPeriod } from '../components/ClosedPeriod.jsx';

export default function DepositEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [search] = useSearchParams();
  const feedId = search.get('feed');
  const navigate = useNavigate();
  const goBack = useGoBack(feedId ? feedReturn(search) : '/deposits'); // back to where the deposit was opened from
  const { lookups, me } = useApp();
  const [dep, setDep] = useState(null);
  const [items, setItems] = useState([]); // deposit details: linked income transactions
  const [meta, setMeta] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [savedMsg, setSavedMsg] = useState(null);
  const [picker, setPicker] = useState(null); // undeposited funds list while popup is open
  const [picked, setPicked] = useState(new Set());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Deposit To: bank & credit card accounts (not the undeposited funds holding account itself).
  const bankOptions = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds, { current: dep?.accountId });

  useEffect(() => {
    if (!lookups) return;
    if (isNew) {
      const firstBank = lookups.accounts.find((a) => a.account_type === 'bank' && !a.is_undeposited_funds && a.is_active);
      setDep({ date: today(), accountId: firstBank?.id || null, memo: '' });
      setItems([]);
      if (feedId) api.get(`/bank-feed/${feedId}`).then((f) => setDep((d) => ({ ...d, date: f.date, accountId: f.account_id, memo: f.description || '' }))).catch(setError);
      return;
    }
    api.get(`/deposits/${id}`).then((d) => {
      setMeta(d);
      setDep({ date: d.date, accountId: d.account_id, memo: d.memo || '' });
      setItems(d.lines.map((l) => ({ id: l.linked_transaction_id, date: l.linked_date, company_name: l.linked_company_name, check_number: l.linked_check_number, amount: l.amount, fund_name: l.fund_name })));
    }).catch(setError);
  }, [id, isNew, lookups, feedId, reloadKey]);

  const openPicker = async () => {
    try {
      const list = await api.get(`/undeposited-funds${qs({ depositId: isNew ? null : id })}`);
      const have = new Set(items.map((i) => i.id));
      setPicker(list.filter((x) => !have.has(x.id)));
      setPicked(new Set());
    } catch (err) { setError(err); }
  };
  const addSelected = () => {
    setItems([...items, ...picker.filter((p) => picked.has(p.id))].sort((a, b) => a.date.localeCompare(b.date)));
    setPicker(null);
  };

  const total = round2(items.reduce((s, i) => s + Number(i.amount), 0));
  const closed = closedPeriod(me.currentOrganization?.period_closing_date, meta?.date, dep?.date);
  const save = async (after) => {
    if (closed.locked && after === 'print') { navigate(`/print/deposit/${id}`); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { ...dep, incomeIds: items.map((i) => i.id), bankFeedItemId: isNew && feedId ? Number(feedId) : undefined };
      const res = isNew ? await api.post('/deposits', body) : await api.put(`/deposits/${id}`, body);
      if (after === 'stay') {
        setSavedMsg('Saved.');
        if (isNew) navigate(`/deposits/${res.id}`, { replace: true }); else setReloadKey((k) => k + 1);
      } else if (after === 'print') {
        if (isNew) navigate(`/deposits/${res.id}`, { replace: true });
        navigate(`/print/deposit/${res.id}`);
      } else if (feedId) navigate(feedReturn(search));
      else if (after === 'new') { if (isNew) { setItems([]); setDep({ ...dep, memo: '' }); } else navigate('/deposits/new', { replace: true }); }
      else goBack();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this deposit? The income items will return to Undeposited Funds.')) return;
    try { await api.del(`/deposits/${id}`); goBack(); } catch (err) { setError(err); }
  };

  if (!dep) return <Page title="Create/Edit Deposit"><ErrorBanner error={error} /></Page>;
  const allPicked = picker && picker.length > 0 && picker.every((p) => picked.has(p.id));

  return (
    <Page panel title={isNew ? 'Create Deposit' : 'Edit Deposit'} wide>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {savedMsg && <div className="alert alert-info">{savedMsg} <button type="button" className="link" onClick={() => setSavedMsg(null)}>✕</button></div>}
      <ClosedPeriodNotice state={closed} noun="deposit" />
      <FeedMatchNote matches={meta?.feedMatches} />
      {meta?.reconciled && <div className="alert alert-warn">This deposit is part of a completed reconciliation; its items and account are locked.</div>}
      <form className="card form" onSubmit={(e) => { e.preventDefault(); save('close'); }}>
        <div className="grid g4">
          <Field label="Date" required><input type="date" className="input" value={dep.date} onChange={(e) => setDep({ ...dep, date: e.target.value })} /></Field>
          <Field label="Deposit To" required className="span2"><Combo options={bankOptions} value={dep.accountId} onChange={(v) => setDep({ ...dep, accountId: v })} allowClear={false} disabled={meta?.reconciled} /></Field>
          <Field label="Amount"><div className="input readonly num">{money(total)}</div></Field>
        </div>
        <Field label="Memo"><input className="input" value={dep.memo} onChange={(e) => setDep({ ...dep, memo: e.target.value })} /></Field>

        <div className="row between mt">
          <h3 className="section-title flush">Deposit items</h3>
          <button type="button" className="btn" onClick={openPicker} disabled={meta?.reconciled}><Plus size={16} aria-hidden="true" />Add Undeposited Funds</button>
        </div>
        <table className="table">
          <thead><tr><th>Date</th><th>Received From</th><th>Check Number</th><th>Fund</th><th className="num">Amount</th><th style={{ width: 36 }} /></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td><Link to={`/income/${i.id}`}>{date(i.date)}</Link></td><td>{i.company_name}</td><td>{i.check_number}</td><td>{i.fund_name}</td>
                <td className="num">{money(i.amount)}</td>
                <td>{!meta?.reconciled && <button type="button" className="icon-btn" title="Remove from deposit" onClick={() => setItems(items.filter((x) => x.id !== i.id))}>✕</button>}</td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={6} className="muted center">No items yet. Click “Add Undeposited Funds”.</td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={4}>Deposit total</td><td className="num strong">{money(total)}</td><td /></tr></tfoot>
        </table>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !items.length || closed.blocked}><Save size={16} aria-hidden="true" />Save &amp; Close</button>
          <button type="button" className="btn" disabled={busy || !items.length || closed.blocked} onClick={() => save('stay')}><Save size={16} aria-hidden="true" />Save</button>
          <button type="button" className="btn" disabled={busy || !items.length || closed.blocked} onClick={() => save('new')}><Plus size={16} aria-hidden="true" />Save &amp; New</button>
          <button type="button" className="btn" disabled={busy || !items.length || (closed.dateClosed && !closed.locked)} onClick={() => save('print')}><Printer size={16} aria-hidden="true" />Print Deposit</button>
          <button type="button" className="btn btn-link" onClick={goBack}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove} disabled={meta?.reconciled || closed.locked}><Trash2 size={16} aria-hidden="true" />Delete</button>}
        </div>
      </form>
      {meta?.gl && <GlEntries gl={meta.gl} />}
      {!isNew && <AuditInfo table="transactions" id={id} refreshKey={reloadKey} />}

      {picker && (
        <Modal title="Undeposited Funds" onClose={() => setPicker(null)} width={760}
          footer={<>
            <span className="muted">{picked.size} selected · {money(picker.filter((p) => picked.has(p.id)).reduce((s, p) => s + Number(p.amount), 0))}</span>
            <button type="button" className="btn btn-primary" disabled={!picked.size} onClick={addSelected}>Add Selected To Deposit</button>
          </>}>
          {picker.length ? (
            <table className="table clickable">
              <thead><tr>
                <th>Date</th><th>Received From</th><th>Check Number</th><th>Fund</th><th className="num">Amount</th>
                <th className="center"><input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(picker.map((p) => p.id)))} /></th>
              </tr></thead>
              <tbody>
                {picker.map((p) => {
                  const toggle = () => { const s = new Set(picked); if (s.has(p.id)) s.delete(p.id); else s.add(p.id); setPicked(s); };
                  return (
                    <tr key={p.id} onClick={toggle} className={picked.has(p.id) ? 'selected' : ''}>
                      <td>{date(p.date)}</td><td>{p.company_name}</td><td>{p.check_number}</td><td>{p.fund_name}</td><td className="num">{money(p.amount)}</td>
                      <td className="center"><input type="checkbox" checked={picked.has(p.id)} onChange={toggle} onClick={(e) => e.stopPropagation()} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="muted">There are no undeposited income items. Income recorded to an account marked “Undeposited Funds” will appear here.</p>}
        </Modal>
      )}
    </Page>
  );
}
