import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import { api } from '../api.js';
import { Empty, ErrorBanner, Page, Pager, SortTh, usePagedLoad } from '../components/ui.jsx';

export default function Companies() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { data, error, loading, total, page, pageSize, setPage, sort, onSort } = usePagedLoad('/companies', { search: query });
  return (
    <Page title="Customers, Donors, and Vendors" actions={<><Link className="btn" to="/advanced/import/customers"><Upload size={16} aria-hidden="true" />Import</Link><Link className="btn btn-primary" to="/companies/new"><Plus size={16} aria-hidden="true" />New</Link></>}>
      <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
        <input className="input grow" placeholder="Search name, address, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn">Search</button>
      </form>
      <ErrorBanner error={error} />
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} scroll={false} />
      <div className="table-wrap">
        <table className="table clickable">
          <thead><tr><SortTh k="name" sort={sort} onSort={onSort}>Name</SortTh><SortTh k="address" sort={sort} onSort={onSort}>Address</SortTh><SortTh k="email" sort={sort} onSort={onSort}>Email</SortTh><SortTh k="phone" sort={sort} onSort={onSort}>Phone</SortTh></tr></thead>
          <tbody>
            {data?.map((c) => (
              <tr key={c.id} onClick={() => navigate(`/companies/${c.id}`)} className={c.is_active ? '' : 'inactive'}>
                <td><Link to={`/companies/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.name}</Link>{!c.is_active && <span className="badge">Inactive</span>}</td>
                <td>{[c.address1, c.city, c.state].filter(Boolean).join(', ')}</td>
                <td>{c.email}</td>
                <td>{c.phone1}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !data?.length && <Empty>No customers, donors or vendors found.</Empty>}
      </div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
    </Page>
  );
}
