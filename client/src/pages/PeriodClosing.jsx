import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { ErrorBanner, Field, Page, useLoad } from '../components/ui.jsx';
import { longDate, today } from '../format.js';

/** Last day of the previous month, a common closing date. */
function lastMonthEnd() {
  const d = new Date();
  const end = new Date(d.getFullYear(), d.getMonth(), 0);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

export default function PeriodClosing() {
  const { isOrgAdmin, refresh } = useApp();
  const { data, error, reload } = useLoad(() => api.get('/period-closing'), []);
  const [date, setDate] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  if (!data) return <Page title="Period Closing"><ErrorBanner error={error} /></Page>;
  const current = data.closingDate;
  const value = date ?? current ?? lastMonthEnd();

  const apply = async (closingDate) => {
    const text = closingDate
      ? `Close the books through ${longDate(closingDate)}? Transactions dated on or before that date will no longer be able to be added, changed or deleted.`
      : `Reopen all periods? Transactions dated on or before ${longDate(current)} will be editable again.`;
    if (!window.confirm(text)) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.put('/period-closing', { closingDate, note });
      setMsg(!r.changed ? 'No change.' : closingDate ? `The books are now closed through ${longDate(closingDate)}.` : 'All periods are open.');
      setNote(''); setDate(null);
      await Promise.all([reload(), refresh()]);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Page title="Period Closing" subtitle={<Link to="/advanced">Advanced</Link>}>
      <ErrorBanner error={err} onClose={() => setErr(null)} />
      {msg && <div className="alert alert-info">{msg} <button type="button" className="link" onClick={() => setMsg(null)}>✕</button></div>}

      <section className="card form narrow">
        <div className="closing-status">
          <span className="muted small">Books closed through</span>
          <strong>{current ? longDate(current) : 'Not closed — all periods are open'}</strong>
        </div>
        <p className="muted small flush">
          When a period closing date is set, no transaction dated on or before it can be added, changed or deleted. This covers
          income, expenses, deposits, journal entries, reconciliations and imports. Clearing older transactions in a later bank
          reconciliation is still allowed.
        </p>
        {isOrgAdmin ? (
          <>
            <div className="grid g2">
              <Field label="Closing date"><input type="date" className="input" value={value} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. June reconciled and reviewed" /></Field>
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !value || value === current} onClick={() => apply(value)}>
                {current ? 'Change closing date' : 'Close period'}
              </button>
              {current && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => apply(null)}>Reopen all periods</button>}
            </div>
          </>
        ) : <p className="muted small flush">Only organization administrators can change the closing date.</p>}
      </section>

      <h2 className="section-title">History</h2>
      <div className="table-wrap narrow">
        <table className="table">
          <thead><tr><th>Changed</th><th>By</th><th>From</th><th>To</th><th>Note</th></tr></thead>
          <tbody>
            {data.history.map((h, i) => (
              <tr key={i}>
                <td>{new Date(h.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                <td>{h.changed_by}</td>
                <td>{h.previous_date ? longDate(h.previous_date) : <span className="muted">Open</span>}</td>
                <td>{h.closing_date ? longDate(h.closing_date) : <span className="muted">Reopened</span>}</td>
                <td>{h.note}</td>
              </tr>
            ))}
            {!data.history.length && <tr><td colSpan={5} className="muted center">The closing date has never been set.</td></tr>}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
