import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../api.js';
import { BankAccountSelect, DateRange, Empty, ErrorBanner, Field, Page, isBanking, useAccountOptions, useLoad } from '../components/ui.jsx';
import { date, money } from '../format.js';
import { useDateRange } from './TxnList.jsx';

export default function ReconcileList() {
  const [range, setRange] = useDateRange('reconcile');
  const [accountId, setAccountId] = useState(null);
  const navigate = useNavigate();
  const options = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds);
  const { data, error, loading } = useLoad(() => api.get(`/reconciliations${qs({ accountId, ...range })}`), [accountId, range.from, range.to]);

  return (
    <Page title="Reconciliations"
      actions={<button type="button" className="btn btn-primary" onClick={() => navigate(`/reconcile/new${accountId ? `?accountId=${accountId}` : ''}`)}><Plus size={16} aria-hidden="true" />Reconcile Account</button>}>
      <DateRange from={range.from} to={range.to} onChange={setRange}>
        <Field label="Bank Account" className="grow"><BankAccountSelect options={options} value={accountId} onChange={setAccountId} placeholder="All bank accounts" /></Field>
      </DateRange>
      <ErrorBanner error={error} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><th>Statement Date</th><th>Bank Account</th><th>Status</th><th className="num">Statement Balance</th><th /></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} onClick={() => navigate(`/reconcile/${r.id}`)}>
                <td>{date(r.statement_date)}</td><td>{r.account_name}</td>
                <td>{r.is_complete ? <span className="badge ok">Completed</span> : <span className="badge warn">In progress</span>}</td>
                <td className="num">{money(r.statement_ending_balance)}</td>
                <td className="actions"><Link className="btn btn-sm btn-ghost" to={`/reconcile/${r.id}/report`} onClick={(e) => e.stopPropagation()}>Report</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !data?.length && <Empty>No reconciliations in this date range.</Empty>}
      </div>
    </Page>
  );
}
