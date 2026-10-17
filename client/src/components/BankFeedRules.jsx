import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { Combo, ErrorBanner, Field, Modal, MoneyInput, isBanking, useAccountOptions, useCompanyOptions, useLoad } from './ui.jsx';
import { money } from '../format.js';

const DIRECTIONS = [['any', 'Money in or out'], ['in', 'Money in'], ['out', 'Money out']];
const blankRule = { name: '', matchText: '', direction: 'any', minAmount: '', maxAmount: '', bankAccountId: null, companyId: null, accountId: null, isActive: true };

/** Rule fields from a saved rule (API row). */
export const ruleForm = (r) => ({
  name: r.name || '', matchText: r.match_text, direction: r.direction, minAmount: r.min_amount ? Number(r.min_amount).toFixed(2) : '',
  maxAmount: r.max_amount ? Number(r.max_amount).toFixed(2) : '', bankAccountId: r.bank_account_id, companyId: r.company_id, accountId: r.account_id, isActive: r.is_active,
});

/** One-line summary of what a rule matches. */
export function ruleCondition(r) {
  const parts = [`Description contains “${r.match_text}”`];
  if (r.direction !== 'any') parts.push(r.direction === 'in' ? 'money in' : 'money out');
  if (r.min_amount && r.max_amount) parts.push(`${money(r.min_amount)} up to (not including) ${money(r.max_amount)}`);
  else if (r.min_amount) parts.push(`${money(r.min_amount)} or more`);
  else if (r.max_amount) parts.push(`under ${money(r.max_amount)}`);
  if (r.bank_account_name) parts.push(`on ${r.bank_account_name}`);
  return parts.join(' · ');
}

/** Add or edit a rule. `initial` pre-fills a new rule (e.g. from a bank feed line). */
export function RuleDialog({ rule, initial, onClose, onSaved }) {
  const { lookups } = useApp();
  const [f, setF] = useState(() => (rule ? ruleForm(rule) : { ...blankRule, ...initial }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const companyOptions = useCompanyOptions(f.companyId);
  const accountOptions = useAccountOptions(() => true, { current: f.accountId });
  const bankOptions = useAccountOptions((a) => isBanking(a), { current: f.bankAccountId });
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v?.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));
  const company = lookups?.companies.find((c) => c.id === f.companyId);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = rule ? await api.put(`/bank-feed-rules/${rule.id}`, f) : await api.post('/bank-feed-rules', f);
      onSaved(r);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Modal title={rule ? 'Edit Bank Feed Rule' : 'New Bank Feed Rule'} onClose={onClose} width={620}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="feed-rule" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save Rule'}</button></>}>
      <form id="feed-rule" onSubmit={save}>
        <ErrorBanner error={err} onClose={() => setErr(null)} />
        <h4 className="flush">When a bank line…</h4>
        <div className="grid g2">
          <Field label="Description contains" required hint="Upper / lower case doesn’t matter"><input className="input" value={f.matchText} onChange={set('matchText')} autoFocus /></Field>
          <Field label="Money in or out">
            <select className="input" value={f.direction} onChange={set('direction')}>{DIRECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field>
          <Field label="Amount from" hint="Optional. The amount is this or more (ignoring + / −)"><MoneyInput currency value={f.minAmount} onChange={set('minAmount')} placeholder="Any" /></Field>
          <Field label="Amount under" hint="Optional. The amount is less than this"><MoneyInput currency value={f.maxAmount} onChange={set('maxAmount')} placeholder="Any" /></Field>
          <Field label="Bank account" className="span2" hint="Optional. Only lines on this bank or card account"><Combo options={bankOptions} value={f.bankAccountId} onChange={set('bankAccountId')} placeholder="Any bank account" /></Field>
        </div>
        <h4>…set</h4>
        <div className="grid g2">
          <Field label="Customer / Vendor"><Combo options={companyOptions} value={f.companyId} onChange={set('companyId')} placeholder="Leave blank" /></Field>
          <Field label="Account" hint={!f.accountId && company && (company.default_expense_account_id || company.default_income_account_id) ? 'Blank: the customer / vendor’s default account' : undefined}>
            <Combo options={accountOptions} value={f.accountId} onChange={set('accountId')} placeholder="Leave blank" />
          </Field>
          <Field label="Name" hint="Optional; shown on the lines the rule sets"><input className="input" value={f.name} onChange={set('name')} /></Field>
          <Field label="Status">
            <label className="check"><input type="checkbox" checked={f.isActive} onChange={set('isActive')} /> Active</label>
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/** Bank feed rules on the Bank Feed Setup screen. */
export default function BankFeedRules() {
  const { data, error, reload } = useLoad(() => api.get('/bank-feed-rules'), []);
  const [editing, setEditing] = useState(null); // rule, or {} for a new one
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const rules = data || [];
  const done = (text) => (r) => { setMsg(`${text}${r?.assigned ? ` ${r.assigned} unmatched line${r.assigned === 1 ? ' is' : 's are'} now set by rules.` : ''}`); reload(); };
  const move = async (i, d) => {
    const ids = rules.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { done('Order saved.')(await api.put('/bank-feed-rules/order', { ids })); } catch (e) { setErr(e); }
  };
  const remove = async (r) => {
    if (!window.confirm('Delete this rule? Lines it set will be cleared (or set by another rule).')) return;
    try { done('Rule deleted.')(await api.del(`/bank-feed-rules/${r.id}`)); } catch (e) { setErr(e); }
  };
  return (
    <section className="card mt">
      <div className="row between wrap gap">
        <div>
          <h3 className="card-title flush">Bank feed rules</h3>
          <span className="muted small">Set the customer / vendor and account on new bank lines from their description and amount. The first matching rule wins.</span>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}><Plus size={15} aria-hidden="true" />Add rule</button>
      </div>
      <ErrorBanner error={error || err} onClose={() => setErr(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}
      {rules.length ? (
        <table className="table compact mt">
          <thead><tr><th style={{ width: 64 }}>Order</th><th>When</th><th>Customer / Vendor</th><th>Account</th><th /></tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={r.id} className={r.is_active ? '' : 'muted'}>
                <td className="nowrap">
                  <button type="button" className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                  <button type="button" className="icon-btn" title="Move down" disabled={i === rules.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                </td>
                <td>{r.name && <strong>{r.name} </strong>}{!r.is_active && <span className="badge">Inactive</span>}<div className="small">{ruleCondition(r)}</div></td>
                <td>{r.company_name || <span className="muted">—</span>}</td>
                <td>{r.account_name ? `${r.account_number ? `${r.account_number} · ` : ''}${r.account_name}` : <span className="muted">{r.company_name ? 'Default account' : '—'}</span>}</td>
                <td className="actions nowrap">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : data && <p className="muted small">No rules yet. Example: description contains “Caseys”, money out, amount from $10 → the Fuel account; and another for under $10 → Food.</p>}
      {editing && (
        <RuleDialog rule={editing.id ? editing : null} onClose={() => setEditing(null)}
          onSaved={(r) => { setEditing(null); done(editing.id ? 'Rule saved.' : 'Rule added.')(r); }} />
      )}
    </section>
  );
}
