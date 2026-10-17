import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../api.js';
import { Combo, DateRange, Empty, ErrorBanner, Field, Page, Pager, SortTh, isBanking, sortRows, useAccountOptions, useLoad, useSort } from '../components/ui.jsx';
import { TXN_LABEL, acct, date, money, txnPath } from '../format.js';
import { useDateRange } from './TxnList.jsx';

export default function Register() {
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useDateRange('register');
  const [accountId, setAccountIdState] = useState(() => params.get('accountId') || sessionStorage.getItem('register:account') || null);
  const navigate = useNavigate();
  const options = useAccountOptions(isBanking, { includeInactive: true });
  const setAccountId = (v) => {
    setAccountIdState(v);
    try { sessionStorage.setItem('register:account', v ?? ''); } catch { /* ignore */ }
    setParams(v ? { accountId: v } : {});
  };
  const { data, error, loading } = useLoad(
    () => (accountId ? api.get(`/register${qs({ accountId, ...range })}`) : Promise.resolve(null)),
    [accountId, range.from, range.to],
  );
  // 500 entries a page; each page starts with the balance carried forward from the page before.
  const PAGE = 500;
  const [pg, setPg] = useState({ key: '', page: 1 });
  const pageKey = `${accountId}|${range.from}|${range.to}`;
  const page = pg.key === pageKey ? pg.page : 1;
  const setPage = (p) => setPg({ key: pageKey, page: p });
  // Sorting by a column (other than the usual date order) hides the running balance's "balance forward" row.
  const [sort, onSort] = useSort('sort:/register');
  const all = data ? sortRows(data.entries, sort, {
    date: (e) => e.date, type: (e) => TXN_LABEL[e.type] || '', number: (e) => e.number || '', toFrom: (e) => e.toFrom || '', memo: (e) => e.memo || '',
    cleared: (e) => (e.cleared ? 1 : 0), amount: (e) => e.amount, balance: (e) => e.balance,
  }) : [];
  const dateOrder = !sort || (sort.key === 'date' && sort.dir === 'asc');
  const entries = all.slice((page - 1) * PAGE, page * PAGE);
  const carried = data && page > 1 ? all[(page - 1) * PAGE - 1]?.balance : data?.openingBalance;
  const pager = data && <Pager page={page} pageSize={PAGE} total={data.entries.length} onPage={setPage} />;

  return (
    <Page title="Bank Account Register"
      actions={<Link className="btn btn-primary" to={`/register/transfers/new${accountId ? `?from=${accountId}` : ''}`}><Plus size={16} aria-hidden="true" />Bank Transfer</Link>}>
      <DateRange from={range.from} to={range.to} onChange={setRange}>
        <Field label="Bank Account" className="grow"><Combo options={options} value={accountId} onChange={setAccountId} placeholder="Select Bank Account" /></Field>
      </DateRange>
      <ErrorBanner error={error} />
      {!accountId && <Empty>Select a bank or credit card account to see its register.</Empty>}
      {data && <Pager page={page} pageSize={PAGE} total={data.entries.length} onPage={setPage} scroll={false} />}
      {data && (
        <div className="table-wrap">
          <table className="table clickable">
            <thead><tr><SortTh k="date" sort={sort} onSort={onSort}>Date</SortTh><SortTh k="type" sort={sort} onSort={onSort}>Type</SortTh><SortTh k="number" sort={sort} onSort={onSort}>Number</SortTh><SortTh k="toFrom" sort={sort} onSort={onSort}>To/From</SortTh><SortTh k="memo" sort={sort} onSort={onSort}>Memo</SortTh><SortTh k="cleared" sort={sort} onSort={onSort} className="center" first="desc">Cleared</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh><SortTh k="balance" sort={sort} onSort={onSort} className="num" first="desc">Balance</SortTh></tr></thead>
            <tbody>
              {dateOrder && <tr className="muted"><td colSpan={7}>{page > 1 ? 'Balance forward' : 'Beginning balance'}</td><td className="num">{acct(carried)}</td></tr>}
              {entries.map((e, i) => (
                <tr key={i} onClick={() => e.transactionId && navigate(txnPath(e.type, e.transactionId))}>
                  <td>{date(e.date)}</td>
                  <td>{TXN_LABEL[e.type] || ''}</td>
                  <td>{e.number}</td>
                  <td>{e.toFrom}</td>
                  <td className="truncate">{e.memo}</td>
                  <td className="center">{e.cleared ? '✓' : ''}</td>
                  <td className={`num${e.amount < 0 ? ' neg' : ''}`}>{acct(e.amount)}</td>
                  <td className="num">{acct(e.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !data.entries.length && <Empty>No activity in this date range.</Empty>}
          <div className="register-total">Ending Balance: <strong>{money(data.endingBalance)}</strong></div>
        </div>
      )}
      {pager}
    </Page>
  );
}
