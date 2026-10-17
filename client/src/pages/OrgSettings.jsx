import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Page } from '../components/ui.jsx';
import { clearPeriodsCache } from '../components/reportControls.jsx';
import ExtractionPrompts from '../components/ExtractionPrompts.jsx';
import ClaudeKeySettings from '../components/ClaudeKeySettings.jsx';
import AuditInfo from '../components/AuditInfo.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function OrgSettings() {
  const { refresh, isOrgAdmin } = useApp();
  const [org, setOrg] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [keyVersion, setKeyVersion] = useState(0); // refreshes the prompts' "not set up" note after the key changes
  useEffect(() => { api.get('/org').then(setOrg).catch(setError); }, []);
  if (!org) return <Page title="Organization Settings"><ErrorBanner error={error} /></Page>;
  const set = (k) => (e) => setOrg({ ...org, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try { await api.put('/org', org); clearPeriodsCache(); await refresh(); setMsg('Settings saved.'); } catch (err) { setError(err); }
  };
  return (
    <Page title="Organization Settings">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {msg && <div className="alert alert-info">{msg}</div>}
      <form className="card form narrow" onSubmit={save}>
        <Field label="Organization name" required><input className="input" value={org.name} onChange={set('name')} disabled={!isOrgAdmin} /></Field>
        <div className="grid g2">
          <Field label="Fiscal year starts in" hint="Used for report date ranges and the current-year change in net assets">
            <select className="input" value={org.fiscal_year_start_month} onChange={set('fiscal_year_start_month')} disabled={!isOrgAdmin}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="EIN" hint="Printed on donation receipts"><input className="input" value={org.ein || ''} onChange={set('ein')} disabled={!isOrgAdmin} /></Field>
        </div>
        <Field label="Address 1"><input className="input" value={org.address1 || ''} onChange={set('address1')} disabled={!isOrgAdmin} /></Field>
        <Field label="Address 2"><input className="input" value={org.address2 || ''} onChange={set('address2')} disabled={!isOrgAdmin} /></Field>
        <div className="grid g3">
          <Field label="City"><input className="input" value={org.city || ''} onChange={set('city')} disabled={!isOrgAdmin} /></Field>
          <Field label="State"><input className="input" value={org.state || ''} onChange={set('state')} disabled={!isOrgAdmin} /></Field>
          <Field label="Postal"><input className="input" value={org.postal || ''} onChange={set('postal')} disabled={!isOrgAdmin} /></Field>
        </div>
        <div className="grid g2">
          <Field label="Phone"><input className="input" value={org.phone || ''} onChange={set('phone')} disabled={!isOrgAdmin} /></Field>
          <Field label="Email"><input className="input" value={org.email || ''} onChange={set('email')} disabled={!isOrgAdmin} /></Field>
        </div>
        <div className="subhead flush">Features</div>
        <label className="check">
          <input type="checkbox" checked={Boolean(org.tuition_enabled)} onChange={(e) => setOrg({ ...org, tuition_enabled: e.target.checked })} disabled={!isOrgAdmin} />
          Enable Tuition Tracking
          <span className="muted small"> — record tuition owed by customers and apply income payments to it</span>
        </label>
        {isOrgAdmin && <div className="form-actions"><button className="btn btn-primary">Save</button></div>}
      </form>
      <AuditInfo table="organizations" id={org.id} refreshKey={msg} />
      <ClaudeKeySettings onChange={() => setKeyVersion((v) => v + 1)} />
      <ExtractionPrompts key={keyVersion} />
    </Page>
  );
}
