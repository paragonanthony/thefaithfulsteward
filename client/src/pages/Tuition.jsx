import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { Empty, ErrorBanner, Field, Page, Pager, SortTh, usePagedLoad } from '../components/ui.jsx';
import { date, money } from '../format.js';

export default function Tuition() {
  const navigate = useNavigate();
  const location = useLocation();
  const [notice, setNotice] = useState(location.state?.notice || null);
  const [status, setStatus] = useState(() => sessionStorage.getItem('tuition:status') || 'open');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading, total, totals, page, pageSize, setPage, sort, onSort } = usePagedLoad('/tuition', { status, search: query });
  const setStatusRemembered = (s) => { setStatus(s); try { sessionStorage.setItem('tuition:status', s); } catch { /* ignore */ } };
  const sum = (k) => totals[k]; // over every matching record, not just this page

  return (
    <Page title="Tuition"
      actions={<>
        <Link className="btn" to="/income/new?from=tuition">Receive Tuition</Link>
        <Link className="btn" to="/tuition/bulk">Create Multiple</Link>
        <Link className="btn btn-primary" to="/tuition/new"><Plus size={16} aria-hidden="true" />New Tuition Record</Link>
      </>}>
      <div className="filter-bar">
        <Field label="Show">
          <select className="input" value={status} onChange={(e) => setStatusRemembered(e.target.value)}>
            <option value="open">Balance due</option>
            <option value="paid">Paid in full</option>
            <option value="all">All</option>
          </select>
        </Field>
        <form className="row gap grow" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
          <input className="input grow" placeholder="Search customer or description" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn">Search</button>
        </form>
      </div>
      <ErrorBanner error={error} />
      {notice && <div className="alert alert-info">{notice} <button type="button" className="link" onClick={() => setNotice(null)}>✕</button></div>}
      {data?.length > 0 && (
        <div className="stat-row">
          <div className="stat"><span>Tuition</span><strong>{money(sum('amount'))}</strong></div>
          <div className="stat"><span>Paid</span><strong>{money(sum('paid'))}</strong></div>
          <div className="stat"><span>Balance due</span><strong>{money(sum('balance'))}</strong></div>
        </div>
      )}
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} scroll={false} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><SortTh k="date" sort={sort} onSort={onSort} first="desc">Date</SortTh><SortTh k="company" sort={sort} onSort={onSort}>Customer</SortTh><SortTh k="description" sort={sort} onSort={onSort}>Description</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Tuition</SortTh><SortTh k="paid" sort={sort} onSort={onSort} className="num" first="desc">Paid</SortTh><SortTh k="balance" sort={sort} onSort={onSort} className="num" first="desc">Balance</SortTh><th /></tr></thead>
          <tbody>
            {data?.map((r) => {
              const bal = Number(r.balance);
              return (
                <tr key={r.id} onClick={() => navigate(`/tuition/${r.id}`)}>
                  <td>{date(r.date)}</td>
                  <td>{r.company_name}</td>
                  <td>{r.description}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td className="num">{money(r.paid)}</td>
                  <td className={`num${bal < 0 ? ' neg' : bal === 0 ? ' ok' : ''}`}>{bal < 0 ? `${money(-bal)} credit` : money(bal)}</td>
                  <td className="actions">
                    {bal > 0 && <Link className="btn btn-sm" to={`/income/new?tuition=${r.id}`} onClick={(e) => e.stopPropagation()}>Receive</Link>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {data?.length > 0 && <tfoot><tr><td colSpan={3}>{total.toLocaleString()} record{total === 1 ? '' : 's'}{total > data.length ? ' (all pages)' : ''}</td><td className="num">{money(sum('amount'))}</td><td className="num">{money(sum('paid'))}</td><td className="num">{money(sum('balance'))}</td><td /></tr></tfoot>}
        </table>
        {!loading && !data?.length && <Empty>{status === 'open' ? 'No tuition balances due.' : 'No tuition records found.'} Use “New Tuition Record” or “Create Multiple” to add tuition.</Empty>}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </Page>
  );
}
