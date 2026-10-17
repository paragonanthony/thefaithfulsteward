import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, Page, useAccountOptions } from '../components/ui.jsx';
import { TXN_LABEL, date, money, txnPath } from '../format.js';
import AuditInfo from '../components/AuditInfo.jsx';

const EMPTY = { name: '', address1: '', address2: '', city: '', state: '', postal: '', phone1: '', phone2: '', email: '', notes: '', default_income_account_id: null, default_expense_account_id: null, is_active: true };

export default function CompanyEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { reloadLookups } = useApp();
  const [c, setC] = useState(EMPTY);
  const [txns, setTxns] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const accountOptions = useAccountOptions(() => true); // spec: both dropdowns list all accounts

  useEffect(() => {
    if (isNew) return;
    api.get(`/companies/${id}`).then((d) => { setTxns(d.transactions); setC({ ...EMPTY, ...d }); }).catch(setError);
  }, [id, isNew]);

  const set = (k) => (e) => setC({ ...c, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) await api.post('/companies', c); else await api.put(`/companies/${id}`, c);
      await reloadLookups();
      navigate('/companies');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${c.name}?`)) return;
    try { await api.del(`/companies/${id}`); await reloadLookups(); navigate('/companies'); } catch (err) { setError(err); }
  };

  return (
    <Page title={isNew ? 'New Customer / Donor / Vendor' : c.name || 'Customer / Donor / Vendor'}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <form className="card form" onSubmit={save}>
        <div className="grid g2">
          <Field label="Name" required className="span2"><input className="input" autoFocus value={c.name} onChange={set('name')} /></Field>
          <Field label="Address 1" className="span2"><input className="input" value={c.address1 || ''} onChange={set('address1')} /></Field>
          <Field label="Address 2" className="span2"><input className="input" value={c.address2 || ''} onChange={set('address2')} /></Field>
        </div>
        <div className="grid g3">
          <Field label="City"><input className="input" value={c.city || ''} onChange={set('city')} /></Field>
          <Field label="State"><input className="input" value={c.state || ''} onChange={set('state')} maxLength={30} /></Field>
          <Field label="Postal"><input className="input" value={c.postal || ''} onChange={set('postal')} /></Field>
        </div>
        <div className="grid g3">
          <Field label="Phone 1"><input className="input" value={c.phone1 || ''} onChange={set('phone1')} /></Field>
          <Field label="Phone 2"><input className="input" value={c.phone2 || ''} onChange={set('phone2')} /></Field>
          <Field label="Email"><input className="input" type="email" value={c.email || ''} onChange={set('email')} /></Field>
        </div>
        <div className="grid g2">
          <Field label="Default Income Account"><Combo options={accountOptions} value={c.default_income_account_id} onChange={set('default_income_account_id')} /></Field>
          <Field label="Default Expense Account"><Combo options={accountOptions} value={c.default_expense_account_id} onChange={set('default_expense_account_id')} /></Field>
        </div>
        <Field label="Notes"><textarea className="input" rows={3} placeholder="Type here" value={c.notes || ''} onChange={set('notes')} /></Field>
        <label className="check"><input type="checkbox" checked={c.is_active} onChange={set('is_active')} /> Active</label>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy}>Save</button>
          <button type="button" className="btn" onClick={() => navigate('/companies')}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove}>Delete</button>}
        </div>
      </form>
      {!isNew && <AuditInfo table="companies" id={id} />}
      {!isNew && (
        <>
          <h2 className="section-title">Transactions</h2>
          <div className="table-wrap">
            <table className="table clickable">
              <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Memo</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} onClick={() => navigate(txnPath(t.transaction_type, t.id))}>
                    <td>{date(t.date)}</td><td>{TXN_LABEL[t.transaction_type]}</td><td>{t.check_number || t.ref_number}</td><td>{t.memo}</td><td className="num">{money(t.amount)}</td>
                  </tr>
                ))}
                {!txns.length && <tr><td colSpan={5} className="muted center">No transactions yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
