import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Modal, Page, useLoad } from '../components/ui.jsx';
import { longDate } from '../format.js';

const MODE_LABEL = { total: 'Total only', fund: 'By fund', month: 'By month', quarter: 'By quarter', year: 'By year', prior_year: 'vs. prior year' };
const TYPE_LABEL = { pnl: 'Activity (Profit & Loss style)', balance_sheet: 'Position (Balance Sheet style)', tuition: 'Tuition records', trial_balance: 'Debit and credit balances of every account', bill_aging: 'Unpaid bills by vendor and days past due' };
const GROUP_LABEL = { none: 'Not grouped', customer: 'By customer', fund: 'By fund', description: 'By description', month: 'By month' };

export default function Reports() {
  const navigate = useNavigate();
  const { me } = useApp();
  const tuitionOn = Boolean(me.currentOrganization?.tuition_enabled);
  const { data, error, reload } = useLoad(() => api.get('/reports'), []);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const financial = (data || []).filter((r) => r.type !== 'tuition');
  const standard = financial.filter((r) => r.builtin_key);
  const custom = financial.filter((r) => !r.builtin_key);
  const tuition = (data || []).filter((r) => r.type === 'tuition');

  const copy = async (r) => {
    try { const c = await api.post(`/reports/${r.id}/copy`, { name: `${r.name} (Copy)` }); navigate(`/reports/${c.id}/design`); } catch (e) { setErr(e); }
  };
  const remove = async (r) => {
    if (!window.confirm(`Delete the report "${r.name}"?`)) return;
    try { await api.del(`/reports/${r.id}`); reload(); } catch (e) { setErr(e); }
  };

  const card = (r) => (
    <div key={r.id} className="report-card">
      <Link to={`/reports/${r.id}`} className="report-card-main">
        <span className="report-card-title">{r.name}</span>
        <span className="report-card-desc">{r.description || TYPE_LABEL[r.type]}</span>
        <span className="report-card-meta">{r.type === 'tuition' ? GROUP_LABEL[r.group_by] || '' : r.type === 'trial_balance' ? 'Debit / Credit' : r.type === 'bill_aging' ? 'Aging' : MODE_LABEL[r.column_mode] || ''}{!r.builtin_key && r.created_by ? ` · by ${r.created_by}` : ''} · updated {longDate(String(r.updated_at).slice(0, 10))}</span>
      </Link>
      <div className="report-card-actions">
        <Link className="btn btn-sm btn-primary" to={`/reports/${r.id}`}>Run</Link>
        <Link className="btn btn-sm" to={`/reports/${r.id}/design`}>{r.type === 'trial_balance' || r.type === 'bill_aging' ? 'Settings' : 'Customize'}</Link>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy(r)}>Copy</button>
        {!r.builtin_key && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>Delete</button>}
      </div>
    </div>
  );

  return (
    <Page title="Reports" actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New Report</button>}>
      <ErrorBanner error={error || err} onClose={() => setErr(null)} />
      <h2 className="section-title">Standard Reports</h2>
      <div className="report-cards">{standard.map(card)}</div>
      <h2 className="section-title">Custom Reports</h2>
      {custom.length ? <div className="report-cards">{custom.map(card)}</div>
        : <p className="muted">No custom reports yet. Customize a standard report and save a copy, or start a new report with the Report Designer.</p>}
      {tuitionOn && (
        <>
          <h2 className="section-title">Tuition Reports</h2>
          <div className="report-cards">{tuition.map(card)}</div>
        </>
      )}
      {creating && (
        <Modal title="New Report" onClose={() => setCreating(false)} width={560}>
          <p className="muted">Choose what kind of figures the report shows. You can change everything else in the Report Designer.</p>
          <div className="choice-list">
            <button type="button" className="choice" onClick={() => navigate('/reports/new/design?type=pnl')}>
              <strong>Activity for a period</strong><span className="muted">Income and expense totals between two dates, like a Profit and Loss / Statement of Activities.</span>
            </button>
            <button type="button" className="choice" onClick={() => navigate('/reports/new/design?type=balance_sheet')}>
              <strong>Balances as of a date</strong><span className="muted">Account balances on a date, like a Balance Sheet / Statement of Financial Position.</span>
            </button>
            {tuitionOn && (
              <button type="button" className="choice" onClick={() => navigate('/reports/new/design?type=tuition')}>
                <strong>Tuition report</strong><span className="muted">A list of tuition records with amounts paid and balances due, with your choice of columns, filters, grouping and aging.</span>
              </button>
            )}
          </div>
        </Modal>
      )}
    </Page>
  );
}
