import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, Page, useFundOptions } from '../components/ui.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

// Layout of the "Select Account Type" screen.
const TYPE_ROWS = [['bank', 'credit_card'], ['line_of_credit', 'loan'], ['income', 'other_income'], ['expense', 'other_expense'],
  ['current_asset', 'fixed_asset'], ['current_liability', 'long_term_liability'], ['accounts_payable', 'equity']];
// Existing accounts can switch between these two types (e.g. to start entering bills against an existing payables account).
const SWITCHABLE = ['current_liability', 'accounts_payable'];

export default function AccountEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { lookups, reloadLookups } = useApp();
  const [a, setA] = useState(isNew ? null : undefined);
  const [error, setError] = useState(null);
  const fundOptions = useFundOptions(a?.default_fund_id);
  const [checkFormats, setCheckFormats] = useState([]);
  useEffect(() => { api.get('/check-formats').then(setCheckFormats).catch(() => {}); }, []);

  useEffect(() => {
    if (!isNew) api.get(`/accounts/${id}`).then(setA).catch(setError);
  }, [id, isNew]);

  const types = lookups?.accountTypes || [];
  const typeLabel = (k) => types.find((t) => t.key === k)?.label || k;

  if (isNew && !a) {
    return (
      <Page title="Create Account" subtitle="Select Account Type">
        <div className="type-grid">
          {TYPE_ROWS.flat().map((k) => (
            <button key={k} type="button" className="type-choice"
              onClick={() => setA({ account_type: k, name: '', account_number: '', description: '', account_group_id: null, default_fund_id: null, is_undeposited_funds: false, is_active: true })}>
              {typeLabel(k)}
            </button>
          ))}
        </div>
      </Page>
    );
  }
  if (!a) return <Page title="Edit Account"><ErrorBanner error={error} /></Page>;

  // Only account groups with the same type as the account are listed.
  const groupOptions = (lookups?.groups || []).filter((g) => g.account_type === a.account_type).map((g) => ({ value: g.id, label: g.name }));
  const set = (k) => (v) => setA({ ...a, [k]: v?.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v });

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      if (isNew) await api.post('/accounts', a); else await api.put(`/accounts/${id}`, a);
      await reloadLookups();
      navigate('/setup');
    } catch (err) { setError(err); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete account ${a.name}?`)) return;
    try { await api.del(`/accounts/${id}`); await reloadLookups(); navigate('/setup'); } catch (err) { setError(err); }
  };

  return (
    <Page title={isNew ? 'Create Account' : 'Edit Account'}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <form className="card form narrow" onSubmit={save}>
        {!isNew && SWITCHABLE.includes(a.account_type) ? (
          <Field label="Account Type" hint={a.account_type === 'accounts_payable' ? 'Bills post to Accounts Payable accounts' : 'Choose Accounts Payable to enter bills against this account'}>
            <select className="input" value={a.account_type} onChange={(e) => setA({ ...a, account_type: e.target.value, account_group_id: null })}>
              {SWITCHABLE.map((k) => <option key={k} value={k}>{typeLabel(k)}</option>)}
            </select>
          </Field>
        ) : (
          <div className="muted">Account Type: <strong>{typeLabel(a.account_type)}</strong>
            {isNew && <button type="button" className="link small" onClick={() => setA(null)}> change</button>}</div>
        )}
        <div className="grid g3">
          <Field label="Account Number"><input className="input" value={a.account_number || ''} onChange={set('account_number')} /></Field>
          <Field label="Account Name" required className="span2"><input className="input" autoFocus value={a.name} onChange={set('name')} /></Field>
        </div>
        <Field label="Description"><textarea className="input" rows={2} placeholder="Type here" value={a.description || ''} onChange={set('description')} /></Field>
        <div className="grid g2">
          <Field label="Account Group" hint={groupOptions.length ? '' : 'No groups exist for this account type'}>
            <Combo options={groupOptions} value={a.account_group_id} onChange={set('account_group_id')} />
          </Field>
          <Field label="Default Fund"><Combo options={fundOptions} value={a.default_fund_id} onChange={set('default_fund_id')} /></Field>
        </div>
        {a.account_type === 'bank' && !a.is_undeposited_funds && (
          <Field label="Check format" hint="Used when printing checks written from this account">
            <select className="input" value={a.check_format_id || ''} onChange={(e) => setA({ ...a, check_format_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Organization default{checkFormats.find((f) => f.is_default) ? ` (${checkFormats.find((f) => f.is_default).name})` : ''}</option>
              {checkFormats.filter((f) => !f.is_default).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
        )}
        {a.account_type === 'bank' && (
          <label className="check"><input type="checkbox" checked={a.is_undeposited_funds} onChange={set('is_undeposited_funds')} /> Undeposited Funds Account
            <span className="muted small"> — income recorded here is held until it is added to a deposit</span></label>
        )}
        <label className="check"><input type="checkbox" checked={a.is_active} onChange={set('is_active')} /> Active</label>
        <div className="form-actions">
          <button className="btn btn-primary">Save</button>
          <button type="button" className="btn" onClick={() => navigate('/setup')}>Cancel</button>
          {!isNew && <button type="button" className="btn btn-danger right" onClick={remove}>Delete</button>}
        </div>
      </form>
      {!isNew && <AuditInfo table="accounts" id={id} />}
    </Page>
  );
}
