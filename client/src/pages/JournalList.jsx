import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { DateRange, Empty, ErrorBanner, Page, Pager, SortTh, usePagedLoad } from '../components/ui.jsx';
import { date, money } from '../format.js';
import { useDateRange } from './TxnList.jsx';

export default function JournalList() {
  const [range, setRange] = useDateRange('journal');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { data, error, loading, total, page, pageSize, setPage, sort, onSort } = usePagedLoad('/journal-entries', { ...range, search: query });

  return (
    <Page title="Journal Entries" subtitle={<Link to="/advanced">Advanced</Link>}
      actions={<Link className="btn btn-primary" to="/advanced/journal-entries/new"><Plus size={16} aria-hidden="true" />Add Journal Entry</Link>}>
      <DateRange from={range.from} to={range.to} onChange={setRange}>
        <form className="row gap grow" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
          <input className="input grow" placeholder="Search description, account, entry # or amount" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn">Search</button>
        </form>
      </DateRange>
      <ErrorBanner error={error} />
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} scroll={false} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><SortTh k="date" sort={sort} onSort={onSort} first="desc">Date</SortTh><SortTh k="id" sort={sort} onSort={onSort} first="desc">Entry #</SortTh><SortTh k="memo" sort={sort} onSort={onSort}>Description</SortTh><SortTh k="fund" sort={sort} onSort={onSort}>Fund</SortTh><SortTh k="lines" sort={sort} onSort={onSort} className="num" first="desc">Lines</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh></tr></thead>
          <tbody>
            {data?.map((j) => (
              <tr key={j.id} onClick={() => navigate(`/advanced/journal-entries/${j.id}`)}>
                <td>{date(j.date)}</td>
                <td>{j.id}</td>
                <td className="truncate">{j.memo}</td>
                <td>{j.fund_name}</td>
                <td className="num">{j.line_count}</td>
                <td className="num">{money(j.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !data?.length && <Empty>No journal entries in this date range.</Empty>}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </Page>
  );
}
