import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { BANKING_TYPES } from '../accountTypes.js';
import { HttpError, ah, fromCents, idOrNull, isDate, loadOwned, toCents } from '../util.js';
import { matchFeedItem, saveIncomeExpense } from '../services/ledger.js';
import { parseUpload, typeInfo } from '../services/attachments.js';
import { NOT_SET_MESSAGE, extractStatement, extractionConfigured } from '../services/extraction.js';
import { applyRules } from '../services/bankFeedRules.js';
import { pageParams, sortOrder } from '../paging.js';
import { classifyFeedLines } from '../services/feedClassify.js';

const r = Router();
r.use(requireAuth, requireOrg);

async function bankAccount(req, id) {
  const accts = await loadOwned({ query }, 'accounts', [Number(id)], req.orgId, 'account');
  const acct = accts[Number(id)];
  if (!BANKING_TYPES.includes(acct.account_type)) throw new HttpError(400, 'Select a Bank or Credit Card account');
  return acct;
}

r.get('/', ah(async (req, res) => {
  const acct = await bankAccount(req, req.query.accountId);
  const status = ['unmatched', 'matched', 'ignored'].includes(req.query.status) ? req.query.status : 'unmatched';
  // ?page=N: 500 lines a page (the tab counts give the total); otherwise the newest 1,000.
  const pg = pageParams(req);
  const { rows: items } = await query(
    `SELECT b.*, t.transaction_type, t.date AS txn_date, COALESCE(c.name, CASE WHEN t.transaction_type IN ('journal', 'transfer') THEN COALESCE(t.memo, 'Transfer') END) AS company_name,
            COALESCE(fr.name, fr.match_text) AS rule_name
       FROM bank_feed_items b LEFT JOIN transactions t ON t.id = b.transaction_id LEFT JOIN companies c ON c.id = t.company_id
       LEFT JOIN bank_feed_rules fr ON fr.id = b.rule_id
      WHERE b.organization_id = $1 AND b.account_id = $2 AND b.status = $3
      ORDER BY ${sortOrder(req, { date: 'b.date', description: 'lower(b.description)', amount: 'b.amount' }, 'b.date DESC, b.id DESC', 'b.id')}
      ${pg ? `LIMIT ${pg.size} OFFSET ${pg.offset}` : 'LIMIT 1000'}`,
    [req.orgId, acct.id, status],
  );
  const { rows: counts } = await query(
    'SELECT status, COUNT(*)::int AS n FROM bank_feed_items WHERE organization_id = $1 AND account_id = $2 GROUP BY status',
    [req.orgId, acct.id],
  );

  // Suggest matches for unmatched items: same account, same amount and direction, within 10 days, not already matched.
  // Journal entries are matched on their net effect on this account, once per account.
  if (status === 'unmatched' && items.length) {
    // Only transactions dated near this page's lines can match, so the candidates stop at its date range ± 10 days.
    const dates = items.map((i) => Date.parse(i.date));
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const from = day(Math.min(...dates) - 10 * 86400000);
    const to = day(Math.max(...dates) + 10 * 86400000);
    const { rows: candidates } = await query(
      `SELECT t.id, t.transaction_type, t.date, t.amount, t.check_number, c.name AS company_name,
              CASE WHEN t.transaction_type = 'expense' THEN -ROUND(t.amount * 100) ELSE ROUND(t.amount * 100) END::bigint AS signed
         FROM transactions t LEFT JOIN companies c ON c.id = t.company_id
        WHERE t.organization_id = $1 AND t.account_id = $2 AND t.transaction_type IN ('income','expense','deposit')
          AND t.date BETWEEN $3 AND $4
          AND NOT EXISTS (SELECT 1 FROM bank_feed_items b WHERE b.transaction_id = t.id)
       UNION ALL
       SELECT t.id, t.transaction_type, t.date, ABS(SUM(d.amount))::numeric(14,2), NULL, COALESCE(t.memo, CASE WHEN t.transaction_type = 'transfer' THEN 'Transfer' END), SUM(ROUND(d.amount * 100))::bigint
         FROM transactions t JOIN transaction_details d ON d.transaction_id = t.id AND d.account_id = $2
        WHERE t.organization_id = $1 AND t.transaction_type IN ('journal', 'transfer')
          AND t.date BETWEEN $3 AND $4
          AND NOT EXISTS (SELECT 1 FROM bank_feed_items b WHERE b.transaction_id = t.id AND b.account_id = $2)
        GROUP BY t.id
       HAVING SUM(d.amount) <> 0`,
      [req.orgId, acct.id, from, to],
    );
    const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
    const byCents = new Map();
    for (const c of candidates) {
      const k = Number(c.signed);
      if (!byCents.has(k)) byCents.set(k, []);
      byCents.get(k).push(c);
    }
    for (const item of items) {
      item.suggestions = (byCents.get(toCents(item.amount)) || [])
        .filter((c) => dayDiff(c.date, item.date) <= 10)
        .sort((a, b) => dayDiff(a.date, item.date) - dayDiff(b.date, item.date))
        .slice(0, 5);
    }
  }
  const countBy = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  res.json({ items, counts: countBy, ...(pg ? { total: countBy[status] || 0, page: pg.page, pageSize: pg.size } : {}) });
}));

/**
 * Auto Classify: Claude suggests a customer / vendor and account for the bank account's unmatched lines that nobody
 * (and no rule) has assigned yet. Uses the organization's "Bank Feed Auto Classify" prompt.
 */
r.post('/auto-classify', ah(async (req, res) => {
  const acct = await bankAccount(req, req.body.accountId);
  // No single transaction: Claude can take a while, and each batch's answers are saved as they come in.
  res.json(await classifyFeedLines({ query }, req.orgId, acct));
}));

/** Import parsed statement lines: [{ date, description, amount, externalId }]. Duplicates are skipped. */
r.post('/import', ah(async (req, res) => {
  const acct = await bankAccount(req, req.body.accountId);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw new HttpError(400, 'No lines to import');
  if (items.length > 5000) throw new HttpError(400, 'Import at most 5,000 lines at a time');
  const result = await withTransaction(async (db) => {
    let imported = 0;
    let skipped = 0;
    const ids = [];
    for (const [i, it] of items.entries()) {
      if (!isDate(it.date)) throw new HttpError(400, `Line ${i + 1}: invalid date "${it.date}"`);
      const cents = toCents(it.amount);
      if (!cents) { skipped++; continue; }
      const description = String(it.description || '').slice(0, 500);
      const externalId = it.externalId ? String(it.externalId).slice(0, 200) : null;
      const { rows: dup } = await db.query(
        `SELECT 1 FROM bank_feed_items WHERE organization_id = $1 AND account_id = $2 AND
           (($3::text IS NOT NULL AND external_id = $3) OR ($3::text IS NULL AND date = $4 AND amount = $5 AND description = $6)) LIMIT 1`,
        [req.orgId, acct.id, externalId, it.date, fromCents(cents), description],
      );
      if (dup.length) { skipped++; continue; }
      const { rows: [row] } = await db.query(
        'INSERT INTO bank_feed_items (organization_id, account_id, date, description, amount, external_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [req.orgId, acct.id, it.date, description, fromCents(cents), externalId],
      );
      ids.push(row.id);
      imported++;
    }
    const assigned = await applyRules(db, req.orgId, { itemIds: ids });
    return { imported, skipped, assigned };
  });
  res.json(result);
}));

/**
 * Read a PDF or image of a statement with Claude and return its lines for review (nothing is saved yet; the reviewed
 * lines are imported with POST /import). Lines that look like ones already in the feed (same date and amount) are flagged.
 */
r.post('/extract-statement', ah(async (req, res) => {
  const acct = await bankAccount(req, req.body.accountId);
  if (!(await extractionConfigured({ query }, req.orgId))) throw new HttpError(503, NOT_SET_MESSAGE);
  const file = parseUpload(req.body);
  if (!typeInfo(file.fileName)?.claude) throw new HttpError(400, 'Upload the statement as a PDF or an image (JPEG, PNG, GIF or WebP), or as a CSV / OFX / QFX file.');
  const result = await extractStatement({ query }, req.orgId, file, acct);
  if (result.items.length) {
    const dates = result.items.map((i) => i.date).sort();
    const { rows } = await query(
      `SELECT date, amount FROM bank_feed_items WHERE organization_id = $1 AND account_id = $2 AND date BETWEEN $3 AND $4`,
      [req.orgId, acct.id, dates[0], dates.at(-1)]);
    const have = new Map();
    for (const r0 of rows) { const k = `${r0.date}|${Number(r0.amount).toFixed(2)}`; have.set(k, (have.get(k) || 0) + 1); }
    for (const i of result.items) {
      const k = `${i.date}|${i.amount}`;
      if (have.get(k)) { i.possibleDuplicate = true; have.set(k, have.get(k) - 1); }
    }
  }
  res.json(result);
}));

/**
 * Add statement lines to the bank feed and return their ids (for creating transactions from lines found on a
 * statement while reconciling). A line that's already in the feed and not matched is reused.
 */
r.post('/lines', ah(async (req, res) => {
  const acct = await bankAccount(req, req.body.accountId);
  const lines = Array.isArray(req.body.lines) ? req.body.lines.slice(0, 500) : [];
  if (!lines.length) throw new HttpError(400, 'No lines to add');
  const ids = await withTransaction(async (db) => {
    const out = [];
    for (const [i, it] of lines.entries()) {
      if (!isDate(it.date)) throw new HttpError(400, `Line ${i + 1}: invalid date "${it.date}"`);
      const cents = toCents(it.amount);
      if (!cents) throw new HttpError(400, `Line ${i + 1}: the amount can't be zero`);
      const description = String(it.description || '').slice(0, 500);
      const { rows: [existing] } = await db.query(
        `SELECT id FROM bank_feed_items WHERE organization_id = $1 AND account_id = $2 AND date = $3 AND amount = $4 AND description = $5 AND status = 'unmatched' LIMIT 1`,
        [req.orgId, acct.id, it.date, fromCents(cents), description]);
      if (existing) { out.push(existing.id); continue; }
      const { rows: [row] } = await db.query(
        'INSERT INTO bank_feed_items (organization_id, account_id, date, description, amount) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [req.orgId, acct.id, it.date, description, fromCents(cents)]);
      out.push(row.id);
    }
    await applyRules(db, req.orgId, { itemIds: out });
    return out;
  });
  res.status(201).json({ ids });
}));

async function feedItem(req) {
  const { rows } = await query('SELECT * FROM bank_feed_items WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  if (!rows.length) throw new HttpError(404, 'Bank feed item not found');
  return rows[0];
}

r.get('/:id', ah(async (req, res) => res.json(await feedItem(req))));

r.post('/:id/match', ah(async (req, res) => {
  await withTransaction((db) => matchFeedItem(db, req.orgId, Number(req.params.id), Number(req.body.transactionId)));
  res.json({ ok: true });
}));
/**
 * Choose the customer / vendor and account for an unmatched line. They become the defaults for a transaction created
 * from it. A line assigned by hand keeps its values when rules change; clearing both lets the rules apply again.
 */
r.put('/:id/assign', ah(async (req, res) => {
  const item = await feedItem(req);
  if (item.status !== 'unmatched') throw new HttpError(409, 'Only lines that aren’t matched or ignored can be assigned');
  const companyId = idOrNull(req.body.companyId);
  const accountId = idOrNull(req.body.accountId);
  if (companyId) await loadOwned({ query }, 'companies', [companyId], req.orgId, 'customer / vendor');
  if (accountId) await loadOwned({ query }, 'accounts', [accountId], req.orgId, 'account');
  if (accountId === item.account_id) throw new HttpError(400, 'Choose an account other than the bank account itself');
  const updated = await withTransaction(async (db) => {
    const manual = Boolean(companyId || accountId);
    await db.query('UPDATE bank_feed_items SET company_id = $1, assigned_account_id = $2, assigned_by = $3, rule_id = NULL, assign_note = NULL WHERE id = $4',
      [companyId, accountId, manual ? 'user' : null, item.id]);
    if (!manual) await applyRules(db, req.orgId, { itemIds: [item.id] });
    const { rows: [row] } = await db.query(
      `SELECT b.*, COALESCE(fr.name, fr.match_text) AS rule_name FROM bank_feed_items b LEFT JOIN bank_feed_rules fr ON fr.id = b.rule_id WHERE b.id = $1`, [item.id]);
    return row;
  });
  res.json(updated);
}));

/**
 * Quick Add: create the transaction for an unmatched line from its own details — Income for money in, an Expense for
 * money out — on the line's bank account, with the line's account (and its default fund), customer / vendor (optional),
 * date, amount and description, and match it. The line must have an account.
 */
r.post('/:id/quick-add', ah(async (req, res) => {
  const item = await feedItem(req);
  if (item.status !== 'unmatched') throw new HttpError(409, 'This line is already matched or ignored');
  if (!item.assigned_account_id) throw new HttpError(400, 'Choose an account for this line first');
  const type = Number(item.amount) > 0 ? 'income' : 'expense';
  const amount = Math.abs(Number(item.amount)).toFixed(2);
  const id = await withTransaction(async (db) => {
    const { rows: [acct] } = await db.query('SELECT default_fund_id FROM accounts WHERE id = $1 AND organization_id = $2', [item.assigned_account_id, req.orgId]);
    return saveIncomeExpense(db, { orgId: req.orgId, userId: req.user.id }, type, {
      date: typeof item.date === 'string' ? item.date : new Date(item.date).toISOString().slice(0, 10),
      amount, accountId: item.account_id, companyId: item.company_id, method: 'electronic', memo: item.description || null,
      lines: [{ accountId: item.assigned_account_id, amount, fundId: acct?.default_fund_id ?? null, memo: item.description || null }],
      bankFeedItemId: item.id,
    });
  });
  res.status(201).json({ id, type });
}));

r.post('/:id/ignore', ah(async (req, res) => {
  await feedItem(req);
  await query(`UPDATE bank_feed_items SET status = 'ignored', transaction_id = NULL WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));
r.post('/:id/clear', ah(async (req, res) => {
  await feedItem(req);
  await query(`UPDATE bank_feed_items SET status = 'unmatched', transaction_id = NULL WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));
r.delete('/:id', ah(async (req, res) => {
  const item = await feedItem(req);
  if (item.status === 'matched') throw new HttpError(409, 'Clear the match before deleting this line');
  await query('DELETE FROM bank_feed_items WHERE id = $1 AND organization_id = $2', [item.id, req.orgId]);
  res.json({ ok: true });
}));

export default r;
