import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError, ah, idOrNull, isDate, loadOwned } from '../util.js';
import { listQuery } from '../paging.js';
import { deleteTransaction, payBills, saveDeposit, saveIncomeExpense, saveJournal, saveTransfer, undepositedFunds } from '../services/ledger.js';

const r = Router();
r.use(requireAuth, requireOrg);
const ctx = (req) => ({ orgId: req.orgId, userId: req.user.id });

function listFilter(req, type) {
  const params = [req.orgId, type];
  let where = 't.organization_id = $1 AND t.transaction_type = $2';
  if (isDate(req.query.from)) { params.push(req.query.from); where += ` AND t.date >= $${params.length}`; }
  if (isDate(req.query.to)) { params.push(req.query.to); where += ` AND t.date <= $${params.length}`; }
  const s = String(req.query.search || '').trim();
  if (s) {
    params.push(s);
    const p = `$${params.length}`;
    where += ` AND (c.name ILIKE '%'||${p}||'%' OR t.check_number ILIKE '%'||${p}||'%' OR t.ref_number ILIKE '%'||${p}||'%'
               OR t.memo ILIKE '%'||${p}||'%' OR t.amount::text = ${p} OR a.name ILIKE '%'||${p}||'%')`;
  }
  return { where, params };
}

async function getTxn(orgId, id, type) {
  const { rows } = await query(
    `SELECT t.*, c.name AS company_name, a.name AS account_name, f.name AS fund_name,
            (SELECT r.is_complete FROM reconciliations r WHERE r.transaction_id = t.reconciliation_id) AS reconciled
       FROM transactions t LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN funds f ON f.id = t.fund_id
      WHERE t.id = $1 AND t.organization_id = $2 AND t.transaction_type = $3`,
    [id, orgId, type],
  );
  if (!rows.length) throw new HttpError(404, 'Transaction not found');
  const { rows: lines } = await query(
    `SELECT d.*, a.name AS account_name, a.account_number, f.name AS fund_name, tr.description AS tuition_description,
            b.ref_number AS bill_ref_number, b.date AS bill_date,
            (SELECT rr.is_complete FROM reconciliations rr WHERE rr.transaction_id = d.reconciliation_id) AS line_reconciled,
            lt.date AS linked_date, lt.check_number AS linked_check_number, lc.name AS linked_company_name
       FROM transaction_details d LEFT JOIN accounts a ON a.id = d.account_id LEFT JOIN funds f ON f.id = d.fund_id
       LEFT JOIN transactions lt ON lt.id = d.linked_transaction_id LEFT JOIN companies lc ON lc.id = lt.company_id
       LEFT JOIN tuition_records tr ON tr.id = d.tuition_id
       LEFT JOIN transactions b ON b.id = d.bill_id
      WHERE d.transaction_id = $1 ORDER BY d.sort_order, d.id`,
    [id],
  );
  const { rows: gl } = await query(
    `SELECT h.id AS header_id, h.date, h.entry_kind, d.debit, d.credit, a.account_number, a.name AS account_name, f.name AS fund_name
       FROM gl_headers h JOIN gl_details d ON d.gl_header_id = h.id JOIN accounts a ON a.id = d.account_id LEFT JOIN funds f ON f.id = d.fund_id
      WHERE h.transaction_id = $1 ORDER BY h.id, d.id`,
    [id],
  );
  let deposit = null;
  if (type === 'income') {
    const { rows: dep } = await query(
      `SELECT t.id, t.date FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id
        WHERE d.linked_transaction_id = $1 AND t.transaction_type = 'deposit' LIMIT 1`, [id]);
    deposit = dep[0] || null;
  }
  // Bank feed lines matched to this transaction (a journal entry or transfer can match one per bank account).
  const { rows: feedMatches } = await query(
    `SELECT b.id, b.account_id, a.name AS account_name, b.date, b.description, b.amount, b.source,
            b.updated_at AS matched_at, u.display_name AS matched_by
       FROM bank_feed_items b JOIN accounts a ON a.id = b.account_id LEFT JOIN users u ON u.id = b.updated_by_user_id
      WHERE b.transaction_id = $1 AND b.organization_id = $2 AND b.status = 'matched'
      ORDER BY a.name, b.date, b.id`, [id, orgId]);
  let payments;
  if (type === 'bill') {
    ({ rows: payments } = await query(
      `SELECT t.id AS transaction_id, t.date, t.check_number, t.ref_number, t.transaction_method, d.amount, a.name AS account_name
         FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id LEFT JOIN accounts a ON a.id = t.account_id
        WHERE d.bill_id = $1 AND t.organization_id = $2 ORDER BY t.date, t.id`, [id, orgId]));
    const paid = payments.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0);
    rows[0].paid = (paid / 100).toFixed(2);
    rows[0].balance = ((Math.round(Number(rows[0].amount) * 100) - paid) / 100).toFixed(2);
  }
  return { ...rows[0], lines, gl, deposit, payments, feedMatches };
}

// ----- Income & Expense -----
for (const [path, type] of [['income', 'income'], ['expenses', 'expense']]) {
  r.get(`/${path}`, ah(async (req, res) => {
    const { where, params } = listFilter(req, type);
    res.json(await listQuery(query, req, {
      sql: `SELECT t.id, t.date, t.amount, t.check_number, t.ref_number, t.memo, t.transaction_method, c.name AS company_name, a.name AS account_name,
              c.email AS company_email
         FROM transactions t LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN accounts a ON a.id = t.account_id
        WHERE ${where}`,
      params, orderBy: 't.date DESC, t.id DESC', sums: { amount: 'SUM(q.amount)' },
      sorts: {
        date: 't.date', company: 'lower(c.name)', account: 'lower(a.name)', number: "lower(COALESCE(NULLIF(t.check_number, ''), t.ref_number))",
        memo: 'lower(t.memo)', amount: 't.amount',
      },
    }));
  }));
  r.get(`/${path}/:id`, ah(async (req, res) => res.json(await getTxn(req.orgId, Number(req.params.id), type))));
  r.post(`/${path}`, ah(async (req, res) => {
    const id = await withTransaction((db) => saveIncomeExpense(db, ctx(req), type, req.body));
    res.status(201).json({ id });
  }));
  r.put(`/${path}/:id`, ah(async (req, res) => {
    const id = await withTransaction((db) => saveIncomeExpense(db, ctx(req), type, req.body, Number(req.params.id)));
    res.json({ id });
  }));
  r.delete(`/${path}/:id`, ah(async (req, res) => {
    await withTransaction((db) => deleteTransaction(db, req.orgId, Number(req.params.id), type));
    res.json({ ok: true });
  }));
}

// ----- Bills (owed to vendors, posted to Accounts Payable) -----
const BILL_PAID = `(SELECT COALESCE(SUM(d.amount), 0) FROM transaction_details d WHERE d.bill_id = t.id)`;
r.get('/bills', ah(async (req, res) => {
  const { where: base, params } = listFilter(req, 'bill');
  let where = base;
  if (req.query.companyId) { params.push(idOrNull(req.query.companyId)); where += ` AND t.company_id = $${params.length}`; }
  const status = req.query.status || 'open';
  if (status === 'open') where += ` AND t.amount > ${BILL_PAID}`;
  else if (status === 'paid') where += ` AND t.amount <= ${BILL_PAID}`;
  res.json(await listQuery(query, req, {
    sql: `SELECT t.id, t.date, t.due_date, t.amount, t.ref_number, t.memo, t.company_id, t.fund_id, c.name AS company_name, a.name AS account_name,
            ${BILL_PAID}::numeric(14,2) AS paid, (t.amount - ${BILL_PAID})::numeric(14,2) AS balance
       FROM transactions t LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE ${where}`,
    params, cap: 2000,
    orderBy: status === 'open' ? 'COALESCE(t.due_date, t.date), t.id' : 't.date DESC, t.id DESC',
    sorts: { date: 't.date', due: 't.due_date', company: 'lower(c.name)', ref: 'lower(t.ref_number)', memo: 'lower(t.memo)', amount: 't.amount', paid: 'paid', balance: 'balance' },
    sums: {
      amount: 'SUM(q.amount)', paid: 'SUM(q.paid)', balance: 'SUM(q.balance)',
      overdue: 'SUM(CASE WHEN q.balance > 0 AND q.due_date < CURRENT_DATE THEN q.balance END)',
      overdueCount: 'COUNT(*) FILTER (WHERE q.balance > 0 AND q.due_date < CURRENT_DATE)',
    },
  }));
}));
r.get('/bills/:id', ah(async (req, res) => res.json(await getTxn(req.orgId, Number(req.params.id), 'bill'))));
r.post('/bills', ah(async (req, res) => {
  const id = await withTransaction((db) => saveIncomeExpense(db, ctx(req), 'bill', req.body));
  res.status(201).json({ id });
}));
r.put('/bills/:id', ah(async (req, res) => {
  const id = await withTransaction((db) => saveIncomeExpense(db, ctx(req), 'bill', req.body, Number(req.params.id)));
  res.json({ id });
}));
r.delete('/bills/:id', ah(async (req, res) => {
  await withTransaction((db) => deleteTransaction(db, req.orgId, Number(req.params.id), 'bill'));
  res.json({ ok: true });
}));
/** Pay Bills: one expense paying one or more bills from a vendor (in full or in part). Returns the expense id. */
r.post('/bill-payments', ah(async (req, res) => {
  const id = await withTransaction((db) => payBills(db, ctx(req), req.body));
  res.status(201).json({ id });
}));

// ----- Journal entries -----
r.get('/journal-entries', ah(async (req, res) => {
  const params = [req.orgId];
  let where = `t.organization_id = $1 AND t.transaction_type = 'journal'`;
  if (isDate(req.query.from)) { params.push(req.query.from); where += ` AND t.date >= $${params.length}`; }
  if (isDate(req.query.to)) { params.push(req.query.to); where += ` AND t.date <= $${params.length}`; }
  const s = String(req.query.search || '').trim();
  if (s) {
    // Matches the description, entry number, amount, or any line's description / account
    params.push(s);
    const p = `$${params.length}`;
    where += ` AND (t.memo ILIKE '%'||${p}||'%' OR t.id::text = ${p} OR t.amount::text = ${p} OR EXISTS (
      SELECT 1 FROM transaction_details d JOIN accounts a ON a.id = d.account_id
       WHERE d.transaction_id = t.id AND (d.memo ILIKE '%'||${p}||'%' OR a.name ILIKE '%'||${p}||'%' OR a.account_number = ${p})))`;
  }
  res.json(await listQuery(query, req, {
    sql: `SELECT t.id, t.date, t.amount, t.memo, f.name AS fund_name,
            (SELECT COUNT(*)::int FROM transaction_details d WHERE d.transaction_id = t.id) AS line_count
       FROM transactions t LEFT JOIN funds f ON f.id = t.fund_id
      WHERE ${where}`,
    params, orderBy: 't.date DESC, t.id DESC',
    sorts: { date: 't.date', id: 't.id', memo: 'lower(t.memo)', fund: 'lower(f.name)', lines: 'line_count', amount: 't.amount' },
  }));
}));
r.get('/journal-entries/:id', ah(async (req, res) => res.json(await getTxn(req.orgId, Number(req.params.id), 'journal'))));
r.post('/journal-entries', ah(async (req, res) => {
  const id = await withTransaction((db) => saveJournal(db, ctx(req), req.body));
  res.status(201).json({ id });
}));
r.put('/journal-entries/:id', ah(async (req, res) => {
  const id = await withTransaction((db) => saveJournal(db, ctx(req), req.body, Number(req.params.id)));
  res.json({ id });
}));
r.delete('/journal-entries/:id', ah(async (req, res) => {
  await withTransaction((db) => deleteTransaction(db, req.orgId, Number(req.params.id), 'journal'));
  res.json({ ok: true });
}));

// ----- Bank transfers -----
r.get('/transfers/:id', ah(async (req, res) => res.json(await getTxn(req.orgId, Number(req.params.id), 'transfer'))));
r.post('/transfers', ah(async (req, res) => {
  const id = await withTransaction((db) => saveTransfer(db, ctx(req), req.body));
  res.status(201).json({ id });
}));
r.put('/transfers/:id', ah(async (req, res) => {
  const id = await withTransaction((db) => saveTransfer(db, ctx(req), req.body, Number(req.params.id)));
  res.json({ id });
}));
r.delete('/transfers/:id', ah(async (req, res) => {
  await withTransaction((db) => deleteTransaction(db, req.orgId, Number(req.params.id), 'transfer'));
  res.json({ ok: true });
}));

// ----- Deposits -----
r.get('/undeposited-funds', ah(async (req, res) => {
  const depositId = req.query.depositId ? Number(req.query.depositId) : null;
  res.json(await undepositedFunds({ query }, req.orgId, depositId));
}));
r.get('/deposits', ah(async (req, res) => {
  const { where, params } = listFilter(req, 'deposit');
  res.json(await listQuery(query, req, {
    sql: `SELECT t.id, t.date, t.amount, t.memo, a.name AS account_name,
            (SELECT COUNT(*)::int FROM transaction_details d WHERE d.transaction_id = t.id) AS item_count
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN companies c ON c.id = t.company_id
      WHERE ${where}`,
    params, orderBy: 't.date DESC, t.id DESC', sums: { amount: 'SUM(q.amount)' },
    sorts: { date: 't.date', account: 'lower(a.name)', items: 'item_count', memo: 'lower(t.memo)', amount: 't.amount' },
  }));
}));
r.get('/deposits/:id', ah(async (req, res) => res.json(await getTxn(req.orgId, Number(req.params.id), 'deposit'))));
r.post('/deposits', ah(async (req, res) => {
  const id = await withTransaction((db) => saveDeposit(db, ctx(req), req.body));
  res.status(201).json({ id });
}));
r.put('/deposits/:id', ah(async (req, res) => {
  const id = await withTransaction((db) => saveDeposit(db, ctx(req), req.body, Number(req.params.id)));
  res.json({ id });
}));
r.delete('/deposits/:id', ah(async (req, res) => {
  await withTransaction((db) => deleteTransaction(db, req.orgId, Number(req.params.id), 'deposit'));
  res.json({ ok: true });
}));

// ----- Find a transaction's type (used to open a transaction from reports / registers) -----
r.get('/transactions/:id', ah(async (req, res) => {
  const { rows } = await query('SELECT id, transaction_type FROM transactions WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  if (!rows.length) throw new HttpError(404, 'Transaction not found');
  res.json(rows[0]);
}));

// ----- Bank account register (from the general ledger) -----
r.get('/register', ah(async (req, res) => {
  const accountId = Number(req.query.accountId);
  const accts = await loadOwned({ query }, 'accounts', [accountId], req.orgId, 'account');
  const acct = accts[accountId];
  const sign = TYPE_BY_KEY[acct.account_type]?.normal === 'credit' ? -1 : 1;
  const from = isDate(req.query.from) ? req.query.from : '1900-01-01';
  const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  const { rows: open } = await query(
    `SELECT COALESCE(SUM(ROUND(d.debit*100) - ROUND(d.credit*100)),0)::bigint AS net
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
      WHERE h.organization_id = $1 AND d.account_id = $2 AND h.date < $3`,
    [req.orgId, accountId, from],
  );
  const { rows } = await query(
    `SELECT h.id AS gl_id, h.date, h.entry_kind, h.transaction_id, t.transaction_type, t.check_number, t.ref_number, t.memo,
            c.name AS company_name,
            CASE WHEN t.transaction_type IN ('journal', 'transfer')
                 THEN EXISTS (SELECT 1 FROM transaction_details td WHERE td.transaction_id = t.id AND td.account_id = $2 AND td.reconciliation_id IS NOT NULL)
                 ELSE t.reconciliation_id IS NOT NULL END AS is_cleared,
            SUM(ROUND(d.debit*100) - ROUND(d.credit*100))::bigint AS net
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
       LEFT JOIN transactions t ON t.id = h.transaction_id LEFT JOIN companies c ON c.id = t.company_id
      WHERE h.organization_id = $1 AND d.account_id = $2 AND h.date BETWEEN $3 AND $4
      GROUP BY h.id, t.id, c.name
      ORDER BY h.date, h.id`,
    [req.orgId, accountId, from, to],
  );
  let balance = Number(open[0].net) * sign;
  const opening = balance;
  const entries = rows.map((x) => {
    const amount = Number(x.net) * sign;
    balance += amount;
    const label = x.entry_kind === 'service_charge' ? 'Service Charge' : x.entry_kind === 'interest' ? 'Interest Earned' : null;
    return {
      date: x.date,
      transactionId: x.transaction_id,
      type: label ? 'reconciliation' : x.transaction_type,
      number: x.check_number || x.ref_number || '',
      toFrom: label || x.company_name || (x.transaction_type === 'deposit' ? 'Deposit' : x.transaction_type === 'journal' ? 'Journal Entry' : x.transaction_type === 'transfer' ? 'Transfer' : ''),
      memo: x.memo,
      cleared: Boolean(x.is_cleared) || Boolean(label),
      amount: amount / 100,
      balance: balance / 100,
    };
  });
  res.json({ account: acct, openingBalance: opening / 100, endingBalance: balance / 100, entries });
}));

export default r;
