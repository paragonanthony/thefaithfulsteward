import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { DateRange, Empty, ErrorBanner, Page, Pager, SortTh, useLoad, usePagedLoad } from '../components/ui.jsx';
import { date, money } from '../format.js';
import { IncomeDepositTabs, useDateRange } from './TxnList.jsx';

export default function DepositList() {
  const [range, setRange] = useDateRange('deposit');
  const navigate = useNavigate();
  const { data, error, loading, total, totals, page, pageSize, setPage, sort, onSort } = usePagedLoad('/deposits', range);
  const { data: undeposited } = useLoad(() => api.get('/undeposited-funds'), []);
  return (
    <Page title="Deposits" actions={<Link className="btn btn-primary" to="/deposits/new"><Plus size={16} aria-hidden="true" />Create Deposit</Link>}>
      <IncomeDepositTabs value="deposits" />
      {undeposited?.length > 0 && (
        <div className="alert alert-info">
          {undeposited.length} income item{undeposited.length === 1 ? '' : 's'} totaling {money(undeposited.reduce((s, u) => s + Number(u.amount), 0))} {undeposited.length === 1 ? 'is' : 'are'} waiting to be deposited.{' '}
          <Link to="/deposits/new">Create a deposit</Link>
        </div>
      )}
      <DateRange from={range.from} to={range.to} onChange={setRange} />
      <ErrorBanner error={error} />
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} scroll={false} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><SortTh k="date" sort={sort} onSort={onSort} first="desc">Date</SortTh><SortTh k="account" sort={sort} onSort={onSort}>Bank Account</SortTh><SortTh k="items" sort={sort} onSort={onSort} first="desc">Items</SortTh><SortTh k="memo" sort={sort} onSort={onSort}>Memo</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh></tr></thead>
          <tbody>
            {data?.map((d) => (
              <tr key={d.id} onClick={() => navigate(`/deposits/${d.id}`)}>
                <td>{date(d.date)}</td><td>{d.account_name}</td><td>{d.item_count}</td><td className="truncate">{d.memo}</td><td className="num">{money(d.amount)}</td>
              </tr>
            ))}
          </tbody>
          {data?.length > 0 && <tfoot><tr><td colSpan={4}>{total.toLocaleString()} deposit{total === 1 ? '' : 's'}{total > data.length ? ' (all pages)' : ''}</td><td className="num">{money(totals.amount)}</td></tr></tfoot>}
        </table>
        {!loading && !data?.length && <Empty>No deposits in this date range.</Empty>}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </Page>
  );
}
