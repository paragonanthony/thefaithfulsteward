import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Wallet } from 'lucide-react';
import { DateRange, Empty, ErrorBanner, Page, Pager, SortTh, Tabs, usePagedLoad } from '../components/ui.jsx';
import { date, money, startOfYear, today } from '../format.js';

export function IncomeDepositTabs({ value }) {
  const navigate = useNavigate();
  return <Tabs tabs={[{ value: 'income', label: 'Income' }, { value: 'deposits', label: 'Deposits' }]} value={value} onChange={(v) => navigate(`/${v}`)} />;
}

export function useDateRange(key) {
  const [range, setRange] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(`range:${key}`)) || { from: startOfYear(), to: today() }; } catch { return { from: startOfYear(), to: today() }; }
  });
  const update = (r) => { setRange(r); try { sessionStorage.setItem(`range:${key}`, JSON.stringify(r)); } catch { /* ignore */ } };
  return [range, update];
}

export default function TxnList({ type }) {
  const isIncome = type === 'income';
  const base = isIncome ? '/income' : '/expenses';
  const [range, setRange] = useDateRange(type);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { data, error, loading, total, totals, page, pageSize, setPage, sort, onSort } = usePagedLoad(base, { ...range, search: query });

  return (
    <Page title={isIncome ? 'Income' : 'Expenses'} actions={<>{!isIncome && <Link className="btn" to="/bills/pay"><Wallet size={16} aria-hidden="true" />Pay Bills</Link>}<Link className="btn btn-primary" to={`${base}/new`}><Plus size={16} aria-hidden="true" />{isIncome ? 'Record Income' : 'Record Expense'}</Link></>}>
      {isIncome && <IncomeDepositTabs value="income" />}
      <DateRange from={range.from} to={range.to} onChange={setRange}>
        <form className="row gap grow" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
          <input className="input grow" placeholder="Search name, number, memo or amount" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn">Search</button>
        </form>
      </DateRange>
      <ErrorBanner error={error} />
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} scroll={false} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead>
            <tr>
              <SortTh k="date" sort={sort} onSort={onSort} first="desc">Date</SortTh><SortTh k="company" sort={sort} onSort={onSort}>{isIncome ? 'Received From' : 'Paid To'}</SortTh><SortTh k="account" sort={sort} onSort={onSort}>{isIncome ? 'Deposit To' : 'Bank Account'}</SortTh><SortTh k="number" sort={sort} onSort={onSort}>Check Number</SortTh><SortTh k="memo" sort={sort} onSort={onSort}>Memo</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh>
            </tr>
          </thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.id} onClick={() => navigate(`${base}/${t.id}`)}>
                <td>{date(t.date)}</td>
                <td>{t.company_name}</td>
                <td>{t.account_name}</td>
                <td>{t.check_number || t.ref_number}</td>
                <td className="truncate">{t.memo}</td>
                <td className="num">{money(t.amount)}</td>
              </tr>
            ))}
          </tbody>
          {data?.length > 0 && <tfoot><tr><td colSpan={5}>{total.toLocaleString()} transaction{total === 1 ? '' : 's'}{total > data.length ? ' (all pages)' : ''}</td><td className="num">{money(totals.amount)}</td></tr></tfoot>}
        </table>
        {!loading && !data?.length && <Empty>No {isIncome ? 'income' : 'expenses'} in this date range.</Empty>}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </Page>
  );
}
