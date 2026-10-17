import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Empty, ErrorBanner, Field, Page, Pager, SortTh, usePagedLoad } from '../components/ui.jsx';
import { date, money, today } from '../format.js';

export default function Bills() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(() => { try { return sessionStorage.getItem('bills:status') || 'open'; } catch { return 'open'; } });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading, total, totals, page, pageSize, setPage, sort, onSort } = usePagedLoad('/bills', { status, search: query });
  const setStatusRemembered = (s) => { setStatus(s); try { sessionStorage.setItem('bills:status', s); } catch { /* ignore */ } };
  const now = today();

  return (
    <Page title="Bills"
      actions={<>
        <Link className="btn" to="/bills/pay">Pay Bills</Link>
        <Link className="btn btn-primary" to="/bills/new"><Plus size={16} aria-hidden="true" />Enter Bill</Link>
      </>}>
      <div className="filter-bar">
        <Field label="Show">
          <select className="input" value={status} onChange={(e) => setStatusRemembered(e.target.value)}>
            <option value="open">Unpaid</option>
            <option value="paid">Paid</option>
            <option value="all">All</option>
          </select>
        </Field>
        <form className="row gap grow" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
          <input className="input grow" placeholder="Search vendor, bill number, memo or amount" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn">Search</button>
        </form>
      </div>
      <ErrorBanner error={error} />
      {status !== 'paid' && data?.length > 0 && (
        <div className="stat-row">
          <div className="stat"><span>Unpaid bills</span><strong>{money(totals.balance)}</strong></div>
          <div className="stat"><span>Overdue</span><strong className={Number(totals.overdueCount) ? 'neg' : ''}>{money(totals.overdue)}</strong></div>
        </div>
      )}
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} scroll={false} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><SortTh k="date" sort={sort} onSort={onSort} first="desc">Bill Date</SortTh><SortTh k="due" sort={sort} onSort={onSort}>Due</SortTh><SortTh k="company" sort={sort} onSort={onSort}>Vendor</SortTh><SortTh k="ref" sort={sort} onSort={onSort}>Bill #</SortTh><SortTh k="memo" sort={sort} onSort={onSort}>Memo</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh><SortTh k="paid" sort={sort} onSort={onSort} className="num" first="desc">Paid</SortTh><SortTh k="balance" sort={sort} onSort={onSort} className="num" first="desc">Balance</SortTh><th /></tr></thead>
          <tbody>
            {data?.map((b) => {
              const bal = Number(b.balance);
              const late = bal > 0 && b.due_date && b.due_date < now;
              return (
                <tr key={b.id} onClick={() => navigate(`/bills/${b.id}`)}>
                  <td>{date(b.date)}</td>
                  <td className={late ? 'neg' : ''}>{b.due_date ? date(b.due_date) : ''}{late && <span className="badge warn">Overdue</span>}</td>
                  <td>{b.company_name}</td>
                  <td>{b.ref_number}</td>
                  <td className="muted">{b.memo}</td>
                  <td className="num">{money(b.amount)}</td>
                  <td className="num">{money(b.paid)}</td>
                  <td className={`num${bal === 0 ? ' ok' : ''}`}>{money(bal)}</td>
                  <td className="actions">
                    {bal > 0 && <Link className="btn btn-sm" to={`/bills/pay?vendor=${b.company_id}&bill=${b.id}`} onClick={(e) => e.stopPropagation()}>Pay</Link>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {data?.length > 0 && <tfoot><tr><td colSpan={5}>{total.toLocaleString()} bill{total === 1 ? '' : 's'}{total > data.length ? ' (all pages)' : ''}</td><td className="num">{money(totals.amount)}</td><td className="num">{money(totals.paid)}</td><td className="num">{money(totals.balance)}</td><td /></tr></tfoot>}
        </table>
        {!loading && !data?.length && <Empty>{status === 'open' ? 'No unpaid bills.' : 'No bills found.'} Use “Enter Bill” to record a bill from a vendor.</Empty>}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </Page>
  );
}
