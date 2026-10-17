import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorBanner, Page, useLoad } from '../components/ui.jsx';
import { TXN_LABEL, date, longDate, money, txnPath } from '../format.js';

const payee = (t) => t.company_name || (t.transaction_type === 'deposit' ? 'Deposit' : t.memo || (t.transaction_type === 'transfer' ? 'Transfer' : t.transaction_type === 'journal' ? 'Journal entry' : ''));

function TxnTable({ title, rows, total, empty }) {
  return (
    <>
      <h4 className="rr-subhead">{title} <span className="muted">({rows.length})</span></h4>
      {rows.length ? (
        <table className="table compact rr-table">
          <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Payee / memo</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={`${t.transaction_type}-${t.id}`}>
                <td>{date(t.date)}</td>
                <td><Link to={txnPath(t.transaction_type, t.id)}>{TXN_LABEL[t.transaction_type]}</Link></td>
                <td>{t.check_number || t.ref_number || ''}</td>
                <td>{payee(t)}</td>
                <td className="num">{money(t.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total {title.toLowerCase()}</td><td className="num">{money(total)}</td></tr></tfoot>
        </table>
      ) : <p className="muted small">{empty}</p>}
    </>
  );
}

/** Printable reconciliation report: balances, cleared transactions, and what was uncleared as of the statement date. */
export default function ReconcileReport() {
  const { id } = useParams();
  const { data: r, error } = useLoad(() => api.get(`/reconciliations/${id}/report`), [id]);
  if (!r) return <Page title="Reconciliation Report"><ErrorBanner error={error} />{!error && <div className="muted">Loading…</div>}</Page>;
  const card = r.account.type === 'credit_card';
  const s = r.summary;
  const L = card
    ? { in: 'Credits and payments', out: 'Charges', inSign: '−', outSign: '+' }
    : { in: 'Deposits and credits', out: 'Checks and payments', inSign: '+', outSign: '−' };
  const inRows = (list) => list.filter((t) => t.direction === 'in');
  const outRows = (list) => list.filter((t) => t.direction === 'out');
  const asOf = longDate(r.reconciliation.statementDate);
  const line = (label, value, cls = '') => <tr className={cls}><td>{label}</td><td className="num">{value}</td></tr>;

  return (
    <Page title="Reconciliation Report" wide subtitle={<Link to={`/reconcile/${id}`}>Back to the reconciliation</Link>}
      actions={<button type="button" className="btn btn-primary" onClick={() => window.print()}>Print</button>}>
      <div className="report rr">
        <div className="report-head">
          <div className="report-org">{r.organization}</div>
          <div className="report-name">Reconciliation Report</div>
          <div className="report-sub">{r.account.number ? `${r.account.number} · ` : ''}{r.account.name} · statement ending {asOf}</div>
          <div className="report-sub">
            {r.reconciliation.isComplete ? `Completed${r.reconciliation.completedAt ? ` ${longDate(String(r.reconciliation.completedAt).slice(0, 10))}` : ''}${r.reconciliation.preparedBy ? ` by ${r.reconciliation.preparedBy}` : ''}` : 'In progress (not yet completed)'}
          </div>
        </div>

        <div className="rr-summary">
          <table className="table compact rr-sum">
            <thead><tr><th colSpan={2}>Statement</th></tr></thead>
            <tbody>
              {line('Beginning balance', money(s.beginningBalance))}
              {line(`${L.inSign} ${L.in} cleared (${s.clearedDeposits.count})`, money(s.clearedDeposits.total))}
              {line(`${L.outSign} ${L.out} cleared (${s.clearedPayments.count})`, money(s.clearedPayments.total))}
              {Number(s.serviceCharge) !== 0 && line(`${card ? '+' : '−'} Service charge`, money(s.serviceCharge))}
              {Number(s.interest) !== 0 && line(`${card ? '−' : '+'} Interest earned`, money(s.interest))}
              {line('Cleared balance', money(s.clearedBalance), 'rr-total')}
              {line('Statement ending balance', money(s.statementEndingBalance))}
              {line('Difference', money(s.difference), `rr-total ${Number(s.difference) === 0 ? 'ok' : 'warn'}`)}
            </tbody>
          </table>
          <table className="table compact rr-sum">
            <thead><tr><th colSpan={2}>Register as of {date(r.reconciliation.statementDate)}</th></tr></thead>
            <tbody>
              {line('Cleared balance', money(s.clearedBalance))}
              {line(`${L.inSign} Uncleared ${L.in.toLowerCase()} (${s.unclearedDeposits.count})`, money(s.unclearedDeposits.total))}
              {line(`${L.outSign} Uncleared ${L.out.toLowerCase()} (${s.unclearedPayments.count})`, money(s.unclearedPayments.total))}
              {line('Register balance', money(s.expectedRegisterBalance), 'rr-total')}
              {Number(s.registerDifference) !== 0 && <>
                {line('Register balance in the books', money(s.registerBalance))}
                {line('Not explained', money(s.registerDifference), 'warn')}
              </>}
            </tbody>
          </table>
        </div>
        {Number(s.registerDifference) !== 0 && (
          <p className="warn small">The books show a different balance for this account on {asOf}. This happens when a cleared transaction is dated after the statement date, or when earlier transactions were changed after an earlier reconciliation.</p>
        )}

        <h3 className="rr-head">Cleared transactions</h3>
        <TxnTable title={L.in} rows={inRows(r.cleared)} total={s.clearedDeposits.total} empty={`No ${L.in.toLowerCase()} were cleared.`} />
        <TxnTable title={L.out} rows={outRows(r.cleared)} total={s.clearedPayments.total} empty={`No ${L.out.toLowerCase()} were cleared.`} />

        <h3 className="rr-head">Uncleared transactions as of {asOf}</h3>
        <TxnTable title={L.in} rows={inRows(r.uncleared)} total={s.unclearedDeposits.total} empty={`No uncleared ${L.in.toLowerCase()}.`} />
        <TxnTable title={L.out} rows={outRows(r.uncleared)} total={s.unclearedPayments.total} empty={`No uncleared ${L.out.toLowerCase()}.`} />

        {(r.attachments.length > 0 || r.reconciliation.memo) && (
          <>
            <h3 className="rr-head">Notes and attachments</h3>
            {r.reconciliation.memo && <p>{r.reconciliation.memo}</p>}
            {r.attachments.length > 0 && (
              <ul className="rr-files">
                {r.attachments.map((f) => <li key={f.id}><a href={`/api/attachments/${f.id}/file`} target="_blank" rel="noopener noreferrer">{f.file_name}</a></li>)}
              </ul>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
