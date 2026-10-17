import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Combo, Empty, ErrorBanner, Field, Modal, Page, Pager, SortTh, Tabs, isBanking, useAccountOptions, useCompanyOptions, useLoad, useSort } from '../components/ui.jsx';
import { useApp } from '../App.jsx';
import { RuleDialog } from '../components/BankFeedRules.jsx';
import AutoClassifyDialog from '../components/AutoClassify.jsx';
import { EyeOff, RefreshCw, Settings, Sparkles, Wand2, Zap } from 'lucide-react';
import { TXN_LABEL, date, money, txnPath } from '../format.js';

// ---------- statement file parsing (CSV / OFX / QFX) ----------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export function parseDate(s) {
  const v = String(s || '').trim();
  let m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}
const parseAmount = (s) => {
  const v = String(s || '').trim();
  if (!v) return 0;
  const neg = /^\(.*\)$/.test(v) || v.startsWith('-');
  const n = Number(v.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
};

function parseOfx(text) {
  const tag = (block, name) => (block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i')) || [])[1]?.trim();
  return [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map((m) => ({
    date: parseDate(tag(m[1], 'DTPOSTED')),
    amount: Number(tag(m[1], 'TRNAMT')),
    description: [tag(m[1], 'NAME'), tag(m[1], 'MEMO')].filter(Boolean).join(' — '),
    externalId: tag(m[1], 'FITID') || null,
  }));
}

const STATEMENT_FILE = /\.(pdf|png|jpe?g|gif|webp)$/i;
const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const readBase64 = (f) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(new Error(`Couldn't read ${f.name}`));
  reader.readAsDataURL(f);
});

function ImportDialog({ accountId, onClose, onDone }) {
  // { kind: 'csv', rows } | { kind: 'ofx', items } | { kind: 'statement', name, result?, include? }
  const [file, setFile] = useState(null);
  const [map, setMap] = useState({ header: true, date: 0, description: 1, amount: 2, debit: -1, credit: -1, flip: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [readsStatements, setReadsStatements] = useState(false);
  useEffect(() => { api.get('/attachments/config').then((c) => setReadsStatements(Boolean(c.extractionEnabled))).catch(() => {}); }, []);

  const readStatement = async (f) => {
    if (!readsStatements) { setError('Reading PDF or image statements needs this organization’s Claude API key (Organization Settings). Import a CSV, OFX or QFX file instead.'); return; }
    if (f.size > MAX_STATEMENT_BYTES) { setError('Statements can be at most 10 MB. Try exporting a shorter date range.'); return; }
    setFile({ kind: 'statement', name: f.name });
    try {
      const result = await api.post('/bank-feed/extract-statement', { accountId, fileName: f.name, data: await readBase64(f) });
      setFile({ kind: 'statement', name: f.name, result, include: result.items.map((i) => !i.possibleDuplicate) });
    } catch (err) { setError(err); setFile(null); }
  };

  const onFile = async (e) => {
    setError(null);
    const f = e.target.files[0];
    if (!f) return;
    if (STATEMENT_FILE.test(f.name)) { await readStatement(f); return; }
    const text = await f.text();
    if (/<OFX>/i.test(text) || /\.(ofx|qfx)$/i.test(f.name)) { setFile({ kind: 'ofx', items: parseOfx(text) }); return; }
    const rows = parseCsv(text);
    const head = rows[0] || [];
    const find = (re) => head.findIndex((h) => re.test(h));
    setMap({
      header: true,
      date: Math.max(0, find(/date/i)),
      description: Math.max(0, find(/desc|memo|payee|name/i)),
      amount: find(/amount/i),
      debit: find(/debit|withdraw/i),
      credit: find(/credit|deposit/i),
      flip: false,
    });
    setFile({ kind: 'csv', rows });
  };

  const items = useMemo(() => {
    if (!file) return [];
    if (file.kind === 'ofx') return file.items;
    if (file.kind === 'statement') {
      return (file.result?.items || []).map((i, k) => ({ date: i.date, description: i.description, amount: Number(i.amount) * (map.flip ? -1 : 1), possibleDuplicate: i.possibleDuplicate, include: file.include[k] }));
    }
    return file.rows.slice(map.header ? 1 : 0).map((r) => {
      let amount = map.amount >= 0 ? parseAmount(r[map.amount]) : parseAmount(r[map.credit]) - Math.abs(parseAmount(r[map.debit]));
      if (map.flip) amount = -amount;
      return { date: parseDate(r[map.date]), description: (r[map.description] || '').trim(), amount };
    });
  }, [file, map]);
  const bad = items.filter((i) => !i.date || !Number.isFinite(i.amount));
  const good = items.filter((i) => i.date && Number.isFinite(i.amount) && i.amount !== 0 && i.include !== false).map(({ include, possibleDuplicate, ...i }) => i);
  const toggle = (k, on) => setFile((f) => ({ ...f, include: f.include.map((v, j) => (j === k ? on : v)) }));
  const st = file?.kind === 'statement' ? file.result : null;

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/bank-feed/import', { accountId, items: good });
      onDone(res);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const head = file?.kind === 'csv' ? (map.header ? file.rows[0] : file.rows[0]?.map((_, i) => `Column ${i + 1}`)) || [] : [];
  const colSelect = (k, allowNone) => (
    <select className="input" value={map[k]} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })}>
      {allowNone && <option value={-1}>(none)</option>}
      {head.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
    </select>
  );

  return (
    <Modal title="Import Bank Activity" onClose={onClose} width={820}
      footer={<><span className="muted">{good.length} line(s) ready{bad.length ? `, ${bad.length} unreadable` : ''}</span>
        <button type="button" className="btn btn-primary" disabled={!good.length || busy} onClick={doImport}>Import {good.length || ''} lines</button></>}>
      <ErrorBanner error={error} />
      <p className="muted">
        Download your statement from your bank as a CSV, OFX or QFX file{readsStatements ? <>, or upload the <strong>PDF statement</strong> or a <strong>photo or scan</strong> of it, and Claude will read the transactions for you to review</> : ''}. Lines already imported are skipped.
      </p>
      <input type="file" accept={`.csv,.ofx,.qfx,text/csv${readsStatements ? ',.pdf,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/*' : ''}`} onChange={onFile} disabled={file?.kind === 'statement' && !file.result} />
      {file?.kind === 'statement' && !file.result && <div className="alert alert-info mt">Reading {file.name} with Claude… This can take a minute for a long statement.</div>}
      {st && (
        <div className="statement-summary mt">
          <div>
            <strong>{st.statement.accountName || 'Statement'}{st.statement.last4 ? ` ••${st.statement.last4}` : ''}</strong>
            {st.statement.periodStart && st.statement.periodEnd && <span className="muted"> · {date(st.statement.periodStart)} – {date(st.statement.periodEnd)}</span>}
            {st.statement.openingBalance !== null && st.statement.closingBalance !== null && (
              <span className="muted"> · balance {money(st.statement.openingBalance)} → {money(st.statement.closingBalance)}</span>
            )}
            {st.statement.balanced === true && <span className="badge ok">Lines match the balances</span>}
          </div>
          {(st.warnings.length > 0 || st.notes) && (
            <ul className="flush warn small">
              {st.warnings.map((w, i) => <li key={i}>{w}</li>)}
              {st.notes && <li>Claude’s note: {st.notes}</li>}
            </ul>
          )}
          <p className="muted small flush">Check the lines against the statement. Untick any you don’t want; lines that look like ones already in the feed (same date and amount) start unticked.</p>
          <label className="check"><input type="checkbox" checked={map.flip} onChange={(e) => setMap({ ...map, flip: e.target.checked })} /> Reverse signs (money in and out came out swapped)</label>
        </div>
      )}
      {file?.kind === 'csv' && (
        <div className="grid g3 mt">
          <Field label="Date column">{colSelect('date')}</Field>
          <Field label="Description column">{colSelect('description')}</Field>
          <Field label="Amount column" hint="Or use separate debit / credit columns">{colSelect('amount', true)}</Field>
          {map.amount < 0 && <><Field label="Debit (money out)">{colSelect('debit', true)}</Field><Field label="Credit (money in)">{colSelect('credit', true)}</Field></>}
          <label className="check"><input type="checkbox" checked={map.header} onChange={(e) => setMap({ ...map, header: e.target.checked })} /> First row is a header</label>
          <label className="check"><input type="checkbox" checked={map.flip} onChange={(e) => setMap({ ...map, flip: e.target.checked })} /> Reverse signs (money out is positive in file)</label>
        </div>
      )}
      {items.length > 0 && file.kind === 'statement' && (
        <div className="table-wrap mt preview statement-lines">
          <table className="table compact">
            <thead><tr><th style={{ width: 30 }}><input type="checkbox" aria-label="Import all lines" checked={file.include.every(Boolean)} onChange={(e) => setFile((f) => ({ ...f, include: f.include.map(() => e.target.checked) }))} /></th><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {items.map((i, k) => (
                <tr key={k} className={i.include ? '' : 'muted'}>
                  <td><input type="checkbox" aria-label={`Import ${i.description}`} checked={i.include} onChange={(e) => toggle(k, e.target.checked)} /></td>
                  <td>{date(i.date)}</td>
                  <td>{i.description}{i.possibleDuplicate && <span className="badge warn" title="A line with this date and amount is already in the bank feed">Possible duplicate</span>}</td>
                  <td className={`num${i.amount < 0 ? ' neg' : ''}`}>{money(i.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td /><td colSpan={2}>Total of ticked lines</td><td className="num">{money(good.reduce((s, i) => s + i.amount, 0))}</td></tr></tfoot>
          </table>
        </div>
      )}
      {items.length > 0 && file.kind !== 'statement' && (
        <div className="table-wrap mt preview">
          <table className="table compact">
            <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {items.slice(0, 50).map((i, k) => (
                <tr key={k} className={!i.date || !Number.isFinite(i.amount) ? 'bad' : ''}>
                  <td>{i.date ? date(i.date) : '??'}</td><td>{i.description}</td><td className="num">{Number.isFinite(i.amount) ? money(i.amount) : '??'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > 50 && <div className="muted small">…and {items.length - 50} more</div>}
        </div>
      )}
      {st && !st.items.length && <p className="muted mt">No transactions were found on this statement.</p>}
    </Modal>
  );
}

export default function BankFeed() {
  // ?account=ID&status=matched opens a given account and tab (e.g. from a transaction's "View in bank feed" link).
  const [search] = useSearchParams();
  const [accountId, setAccountIdState] = useState(() => search.get('account') || sessionStorage.getItem('feed:account') || null);
  const [status, setStatus] = useState(() => (['unmatched', 'matched', 'ignored'].includes(search.get('status')) ? search.get('status') : 'unmatched'));
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [err, setErr] = useState(null);
  const [choice, setChoice] = useState({}); // feed item id -> chosen transaction id
  const [syncing, setSyncing] = useState(false);
  const [ruleFrom, setRuleFrom] = useState(null); // bank line a new rule starts from
  const [classifying, setClassifying] = useState(false);
  const [canClassify, setCanClassify] = useState(false); // the server has a Claude API key
  useEffect(() => { api.get('/attachments/config').then((c) => setCanClassify(Boolean(c.extractionEnabled))).catch(() => {}); }, []);
  const [assigned, setAssigned] = useState({}); // feed item id -> latest assignment (saved without reloading the list)
  const { lookups } = useApp();
  const companyOptions = useCompanyOptions();
  const lineAccountOptions = useAccountOptions((a) => String(a.id) !== String(accountId));
  const companiesById = useMemo(() => Object.fromEntries((lookups?.companies || []).map((c) => [c.id, c])), [lookups]);
  // Sync Now appears once a bank connection feeds at least one account.
  const { data: conn, reload: reloadConn } = useLoad(() => api.get('/bank-connections/status').catch(() => null), []);
  const canSync = Boolean(conn?.configured && conn.connections.some((c) => c.accounts.some((a) => a.is_enabled && a.account_id)));
  const navigate = useNavigate();
  const options = useAccountOptions((a) => isBanking(a) && !a.is_undeposited_funds);
  const setAccountId = (v) => { setAccountIdState(v); try { sessionStorage.setItem('feed:account', v ?? ''); } catch { /* ignore */ } };
  // 500 lines a page; changing the account or tab goes back to page 1.
  const [pg, setPg] = useState({ key: '', page: 1 });
  const [sort, onSort] = useSort('sort:/bank-feed');
  const pageKey = `${accountId}|${status}|${sort?.key}|${sort?.dir}`;
  const page = pg.key === pageKey ? pg.page : 1;
  const setPage = (p) => setPg({ key: pageKey, page: p });
  const { data, error, reload } = useLoad(
    () => (accountId ? api.get(`/bank-feed${qs({ accountId, status, page, sort: sort?.key, dir: sort?.dir })}`) : Promise.resolve(null)),
    [accountId, status, page, sort?.key, sort?.dir],
  );

  const act = async (fn) => {
    setErr(null);
    try { await fn(); reload(); } catch (e) { setErr(e); }
  };
  const counts = data?.counts || {};
  useEffect(() => { setAssigned({}); }, [data]);
  // Customer / vendor and account for a line. Choosing a customer / vendor with a default account sets the account too.
  const assign = async (item, patch) => {
    const cur = { companyId: item.company_id, accountId: item.assigned_account_id, ...(assigned[item.id] ? { companyId: assigned[item.id].company_id, accountId: assigned[item.id].assigned_account_id } : {}) };
    const next = { ...cur, ...patch };
    if ('companyId' in patch && patch.companyId) {
      const c = companiesById[patch.companyId];
      const def = c && (Number(item.amount) > 0 ? c.default_income_account_id : c.default_expense_account_id);
      if (def && String(def) !== String(item.account_id)) next.accountId = def;
    }
    setErr(null);
    try {
      const row = await api.put(`/bank-feed/${item.id}/assign`, next);
      setAssigned((p) => ({ ...p, [item.id]: row }));
    } catch (e) { setErr(e); }
  };
  // Quick Add: create the income / expense straight from the line (it needs an account) and match it.
  const [adding, setAdding] = useState(null);
  const quickAdd = async (item) => {
    setAdding(item.id); setErr(null); setNotice(null);
    try {
      const r = await api.post(`/bank-feed/${item.id}/quick-add`);
      const amt = Math.abs(Number(item.amount));
      setNotice(<>Created {r.type === 'income' ? 'income' : 'an expense'} of {money(amt)} and matched it. <Link to={`/${r.type === 'income' ? 'income' : 'expenses'}/${r.id}`}>Open it</Link></>);
      reload();
    } catch (e) { setErr(e); } finally { setAdding(null); }
  };
  const CREATE = (amt) => [
    ...(amt > 0 ? [['income', 'Income', '/income/new'], ['deposit', 'Deposit', '/deposits/new']] : [['expense', 'Expense', '/expenses/new']]),
    ['journal', 'Journal Entry', '/advanced/journal-entries/new'],
    ['transfer', 'Transfer', '/register/transfers/new'],
  ];
  const syncNow = async () => {
    setSyncing(true); setErr(null); setNotice(null);
    try {
      const r = await api.post('/bank-connections/sync');
      setNotice(r.skipped && !r.added && !r.updated ? 'A sync is already running.'
        : `Synced: ${r.added} new, ${r.updated} updated.${r.errors.length ? ` SimpleFIN reported: ${r.errors.join(' · ')}` : ''}`);
      reload(); reloadConn();
    } catch (e) { setErr(e); } finally { setSyncing(false); }
  };

  return (
    <Page title="Bank Feed" actions={<>
      {canSync && <button type="button" className="btn" disabled={syncing} onClick={syncNow}><RefreshCw size={15} aria-hidden="true" />{syncing ? 'Syncing…' : 'Sync Now'}</button>}
      {canClassify && accountId && status === 'unmatched' && <button type="button" className="btn" onClick={() => setClassifying(true)} title="Use Claude to pick customers / vendors and accounts for unassigned lines"><Sparkles size={15} aria-hidden="true" />Auto Classify</button>}
      <Link className="btn" to="/bank-feed/rules"><Wand2 size={15} aria-hidden="true" />Rules</Link>
      <Link className="btn" to="/bank-feed/setup"><Settings size={15} aria-hidden="true" />Bank Feed Setup</Link>
      {accountId && <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>Import Statement</button>}
    </>}>
      <div className="filter-bar">
        <Field label="Bank Account" className="grow"><Combo options={options} value={accountId} onChange={setAccountId} placeholder="Select Bank Account" /></Field>
      </div>
      <ErrorBanner error={error || err} onClose={() => setErr(null)} />
      {notice && <div className="alert alert-info">{notice} <button type="button" className="link" onClick={() => setNotice(null)}>✕</button></div>}
      {!accountId && <Empty>Select a bank account to see its activity. Connect a bank under <Link to="/bank-feed/setup">Bank Feed Setup</Link>, or import a statement file, to start matching.</Empty>}
      {accountId && (
        <>
          <Tabs value={status} onChange={setStatus} tabs={[
            { value: 'unmatched', label: 'Not Matched', count: counts.unmatched || 0 },
            { value: 'matched', label: 'Matched', count: counts.matched || 0 },
            { value: 'ignored', label: 'Ignored', count: counts.ignored || 0 },
          ]} />
          {data && <Pager page={page} pageSize={data.pageSize || 500} total={data.total || 0} onPage={setPage} scroll={false} />}
          <div className="table-wrap">
            <table className="table">
              <thead>
                {status === 'unmatched'
                  ? <tr><SortTh k="date" sort={sort} onSort={onSort} first="desc">Date</SortTh><SortTh k="description" sort={sort} onSort={onSort}>Bank Memo</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh><th className="feed-pick">Customer / Vendor</th><th className="feed-pick">Account</th><th>Match or Create</th></tr>
                  : <tr><SortTh k="date" sort={sort} onSort={onSort} first="desc">Date</SortTh><SortTh k="description" sort={sort} onSort={onSort}>Bank Memo</SortTh><SortTh k="amount" sort={sort} onSort={onSort} className="num" first="desc">Amount</SortTh><th>To/From</th><th>Transaction</th><th /></tr>}
              </thead>
              <tbody>
                {data?.items.map((i) => {
                  const amt = Number(i.amount);
                  const sel = choice[i.id] ?? i.suggestions?.[0]?.id ?? '';
                  const a = assigned[i.id] || i;
                  return (
                    <tr key={i.id}>
                      <td>{date(i.date)}</td>
                      {/* Not Matched: long memos wrap (two lines) so the pickers and actions fit on screen */}
                      <td className={status === 'unmatched' ? 'feed-memo' : 'truncate'} title={i.description}>
                        {status === 'unmatched'
                          ? <span className="clamp2">{['simplefin', 'stripe', 'plaid'].includes(i.source) && <span className="badge feed-src" title="Imported from a bank connection">Live</span>}{i.description}</span>
                          : <>{['simplefin', 'stripe', 'plaid'].includes(i.source) && <span className="badge feed-src" title="Imported from a bank connection">Live</span>}{i.description}</>}
                      </td>
                      <td className={`num${amt < 0 ? ' neg' : ''}`}>{money(amt)}</td>
                      {status === 'unmatched' ? (
                        <>
                          <td className="feed-pick"><Combo options={companyOptions} value={a.company_id} onChange={(v) => assign(i, { companyId: v })} placeholder="—" /></td>
                          <td className="feed-pick">
                            <Combo options={lineAccountOptions} value={a.assigned_account_id} onChange={(v) => assign(i, { accountId: v })} placeholder="—" />
                            {a.assigned_by === 'rule' && <div className="muted small" title="Set by a bank feed rule">Rule: {a.rule_name}</div>}
                            {a.assigned_by === 'claude' && <div className="muted small clamp2" title={a.assign_note ? `Auto Classify: ${a.assign_note}` : 'Set by Auto Classify'}><Sparkles size={11} aria-hidden="true" /> {a.assign_note || 'Auto Classify'}</div>}
                          </td>
                          <td className="feed-actions">
                            {i.suggestions?.length > 0 && (
                              <div className="feed-match">
                                <select className="input" value={sel} aria-label="Suggested match" onChange={(e) => setChoice({ ...choice, [i.id]: e.target.value })}>
                                  {i.suggestions.map((s) => <option key={s.id} value={s.id}>{date(s.date)} · {TXN_LABEL[s.transaction_type]} · {s.company_name || ''} {s.check_number ? `#${s.check_number}` : ''} · {money(s.amount)}</option>)}
                                </select>
                                <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/bank-feed/${i.id}/match`, { transactionId: Number(sel) }))}>Match</button>
                              </div>
                            )}
                            <div className="feed-buttons">
                              <button type="button" className="icon-btn quick-add" disabled={!a.assigned_account_id || adding === i.id} onClick={() => quickAdd(i)}
                                title={a.assigned_account_id ? `Quick Add: create ${amt > 0 ? 'income' : 'an expense'} from this line and match it` : 'Quick Add needs an account on this line'}
                                aria-label="Quick Add"><Zap size={16} /></button>
                              {/* Creating a transaction uses the line's customer / vendor and account as defaults */}
                              <select className="input create-select" value="" aria-label="Create a transaction"
                                onChange={(e) => e.target.value && navigate(`${e.target.value}?feed=${i.id}`)}>
                                <option value="">Create…</option>
                                {CREATE(amt).map(([k, label, path]) => <option key={k} value={path}>{label}</option>)}
                              </select>
                              <button type="button" className="icon-btn" title="Create a rule from this line" aria-label="Create a rule from this line" onClick={() => setRuleFrom({ ...i, ...a })}><Wand2 size={16} /></button>
                              <button type="button" className="icon-btn" title="Ignore this line" aria-label="Ignore this line" onClick={() => act(() => api.post(`/bank-feed/${i.id}/ignore`))}><EyeOff size={16} /></button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{i.company_name}</td>
                          <td>{i.transaction_id ? <Link to={txnPath(i.transaction_type, i.transaction_id)}>{TXN_LABEL[i.transaction_type]} {date(i.txn_date)}</Link> : <span className="muted">—</span>}</td>
                          <td className="actions">
                            <button type="button" className="btn btn-sm" onClick={() => act(() => api.post(`/bank-feed/${i.id}/clear`))}>Clear</button>
                            {status === 'ignored' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.confirm('Delete this imported line?') && act(() => api.del(`/bank-feed/${i.id}`))}>Delete</button>}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data && !data.items.length && <Empty>{status === 'unmatched' ? 'Nothing to match. Import a statement file to bring in new bank activity.' : 'No lines.'}</Empty>}
          </div>
          {data && <Pager page={page} pageSize={data.pageSize || 500} total={data.total || 0} onPage={setPage} />}
        </>
      )}
      {classifying && (
        <AutoClassifyDialog accountId={accountId} accountName={options.find((o) => String(o.value) === String(accountId))?.label || 'this account'}
          unassigned={(data?.items || []).filter((i) => !(assigned[i.id] || i).assigned_by).length}
          onClose={() => setClassifying(false)}
          onDone={(r) => {
            setClassifying(false);
            setNotice(`Auto Classify set ${r.classified} of ${r.total} line${r.total === 1 ? '' : 's'}.${r.remaining ? ` ${r.remaining} still need${r.remaining === 1 ? 's' : ''} a customer / vendor or account${r.remaining > r.total - r.classified ? ' (run it again for more)' : ''}.` : ''} Check them before creating transactions.`);
            reload();
          }} />
      )}
      {ruleFrom && (
        <RuleDialog onClose={() => setRuleFrom(null)}
          initial={{ matchText: ruleFrom.description.slice(0, 40), direction: Number(ruleFrom.amount) > 0 ? 'in' : 'out', companyId: ruleFrom.company_id, accountId: ruleFrom.assigned_account_id }}
          onSaved={(r) => { setRuleFrom(null); setNotice(`Rule added.${r.assigned ? ` ${r.assigned} unmatched line${r.assigned === 1 ? ' is' : 's are'} now set by rules.` : ''} Manage rules with the Rules button.`); reload(); }} />
      )}
      {importing && <ImportDialog accountId={accountId} onClose={() => setImporting(false)}
        onDone={(r) => { setImporting(false); setNotice(`Imported ${r.imported} line(s); skipped ${r.skipped} duplicate or empty line(s).`); setStatus('unmatched'); reload(); }} />}
    </Page>
  );
}
