import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { HandCoins, Save, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Combo, ErrorBanner, Field, MoneyInput, Page, useAccountOptions, useCompanyOptions, useFundOptions, useGoBack } from '../components/ui.jsx';
import QuickAddCompany from '../components/QuickAddCompany.jsx';
import { date, money, today } from '../format.js';
import AuditInfo from '../components/AuditInfo.jsx';
import Attachments, { linkPendingAttachments } from '../components/Attachments.jsx';

export const isIncomeAccount = (a) => a.account_type === 'income' || a.account_type === 'other_income';

export default function TuitionEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const goBack = useGoBack('/tuition'); // back to where the record was opened from
  const [rec, setRec] = useState(isNew ? { companyId: null, date: today(), description: '', amount: '', incomeAccountId: null, fundId: null, memo: '' } : null);
  const [info, setInfo] = useState(null); // paid / balance / payments for an existing record
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [quickAdd, setQuickAdd] = useState(null);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [savedMsg, setSavedMsg] = useState(null);
  const [suggestCompany, setSuggestCompany] = useState(null);
  const companyOptions = useCompanyOptions(rec?.companyId);
  const accountOptions = useAccountOptions(isIncomeAccount, { current: rec?.incomeAccountId });
  const fundOptions = useFundOptions(rec?.fundId);

  useEffect(() => {
    if (isNew) return;
    api.get(`/tuition/${id}`).then((r) => {
      setInfo(r);
      setRec({ companyId: r.company_id, date: r.date, description: r.description || '', amount: Number(r.amount).toFixed(2), incomeAccountId: r.income_account_id, fundId: r.fund_id, memo: r.memo || '' });
    }).catch(setError);
  }, [id, isNew, reloadKey]);

  if (!rec) return <Page title="Tuition"><ErrorBanner error={error} /></Page>;
  const set = (k) => (v) => setRec({ ...rec, [k]: v?.target ? v.target.value : v });
  const hasPayments = info?.payments?.length > 0;

  const save = async (after) => {
    setBusy(true);
    setError(null);
    try {
      const r = isNew ? await api.post('/tuition', rec) : await api.put(`/tuition/${id}`, rec);
      if (isNew) { await linkPendingAttachments(pendingFiles, { tuitionId: r.id }); setPendingFiles([]); }
      if (after === 'stay') {
        setSavedMsg('Saved.');
        setBusy(false);
        if (isNew) navigate(`/tuition/${r.id}`, { replace: true }); else setReloadKey((k) => k + 1);
        return;
      }
      if (after === 'receive') navigate(`/income/new?tuition=${r.id}`); else goBack();
    } catch (err) { setError(err); setBusy(false); }
  };
  const applyExtracted = ({ fields: f }) => {
    setRec((p) => ({
      ...p,
      ...(f.date ? { date: f.date } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.amount ? { amount: f.amount } : {}),
      ...(f.incomeAccountId ? { incomeAccountId: f.incomeAccountId } : {}),
      ...(f.fundId ? { fundId: f.fundId } : {}),
      ...(f.memo ? { memo: f.memo } : {}),
      ...(f.companyId && !hasPayments ? { companyId: f.companyId } : {}),
    }));
    setSuggestCompany(!f.companyId && f.companyName && !hasPayments ? f.companyName : null);
  };
  const remove = async () => {
    if (!window.confirm('Delete this tuition record?')) return;
    try { await api.del(`/tuition/${id}`); goBack(); } catch (err) { setError(err); }
  };

  return (
    <Page panel title={isNew ? 'New Tuition Record' : 'Tuition Record'} subtitle={info ? info.company_name : undefined}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {savedMsg && <div className="alert alert-info">{savedMsg} <button type="button" className="link" onClick={() => setSavedMsg(null)}>✕</button></div>}
      {info && (
        <div className="stat-row">
          <div className="stat"><span>Tuition</span><strong>{money(info.amount)}</strong></div>
          <div className="stat"><span>Paid</span><strong>{money(info.paid)}</strong></div>
          <div className="stat"><span>Balance due</span><strong className={Number(info.balance) <= 0 ? 'ok' : ''}>{money(info.balance)}</strong></div>
        </div>
      )}
      {suggestCompany && (
        <div className="alert alert-info narrow">
          <span>“{suggestCompany}” from the document isn’t in your customers.{' '}
            <button type="button" className="link" onClick={() => { setQuickAdd(suggestCompany); setSuggestCompany(null); }}>Add as a new customer</button></span>
          <button type="button" className="link" onClick={() => setSuggestCompany(null)}>✕</button>
        </div>
      )}
      <form className="card form narrow" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="grid g2">
          <Field label="Customer" required hint={hasPayments ? 'Customer can’t be changed once payments are applied' : undefined}>
            <Combo options={companyOptions} value={rec.companyId} onChange={set('companyId')} disabled={hasPayments}
              onCreate={(name) => setQuickAdd(name)} createLabel="customer" />
          </Field>
          <Field label="Date" required><input type="date" className="input" value={rec.date} onChange={set('date')} /></Field>
        </div>
        <div className="grid g2">
          <Field label="Description"><input className="input" value={rec.description} onChange={set('description')} placeholder="e.g. 2026–27 Tuition" /></Field>
          <Field label="Total tuition" required><MoneyInput currency value={rec.amount} onChange={set('amount')} placeholder="0.00" /></Field>
        </div>
        <div className="grid g2">
          <Field label="Income account" hint="Used when receiving payment"><Combo options={accountOptions} value={rec.incomeAccountId} onChange={set('incomeAccountId')} /></Field>
          <Field label="Fund"><Combo options={fundOptions} value={rec.fundId} onChange={set('fundId')} /></Field>
        </div>
        <Field label="Memo"><textarea className="input" rows={2} value={rec.memo} onChange={set('memo')} /></Field>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}><Save size={16} aria-hidden="true" />Save &amp; Close</button>
          <button type="button" className="btn" disabled={busy} onClick={() => save('stay')}><Save size={16} aria-hidden="true" />Save</button>
          {(isNew || Number(info?.balance) > 0) && <button type="button" className="btn" disabled={busy} onClick={() => save('receive')}><HandCoins size={16} aria-hidden="true" />Save &amp; Receive Payment</button>}
          <button type="button" className="btn btn-link" onClick={goBack}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove} disabled={hasPayments} title={hasPayments ? 'Records with payments can’t be deleted' : ''}><Trash2 size={16} aria-hidden="true" />Delete</button>}
        </div>
      </form>
      <div className="narrow">
        <Attachments owner={isNew ? null : { tuitionId: Number(id) }} txnType="tuition" pending={pendingFiles} onPendingChange={setPendingFiles} onExtracted={applyExtracted} />
      </div>
      {!isNew && <AuditInfo table="tuition_records" id={id} refreshKey={reloadKey} />}

      {info && (
        <>
          <h2 className="section-title">Payments</h2>
          <div className="table-wrap narrow">
            <table className="table clickable">
              <thead><tr><th>Date</th><th>Number</th><th>Memo</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {info.payments.map((p, i) => (
                  <tr key={i} onClick={() => navigate(`/income/${p.transaction_id}`)}>
                    <td><Link to={`/income/${p.transaction_id}`} onClick={(e) => e.stopPropagation()}>{date(p.date)}</Link></td>
                    <td>{p.check_number || p.ref_number}</td><td>{p.memo}</td><td className="num">{money(p.amount)}</td>
                  </tr>
                ))}
                {!info.payments.length && <tr><td colSpan={4} className="muted center">No payments yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {quickAdd !== null && (
        <QuickAddCompany kind="income" initialName={quickAdd} initialAccountId={rec.incomeAccountId}
          onClose={() => setQuickAdd(null)} onCreated={(c) => { setQuickAdd(null); setRec((r) => ({ ...r, companyId: c.id })); }} />
      )}
    </Page>
  );
}
