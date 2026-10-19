import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { HttpError, ah, idOrNull, isDate, loadOwned } from '../util.js';
import {
  deleteReconciliation, priorStatementBalance, reconciledItems, reconciliationCandidates, saveReconciliation, undoReconciliation,
} from '../services/ledger.js';
import { BANKING_TYPES } from '../accountTypes.js';
import { parseUpload, saveAttachment, typeInfo } from '../services/attachments.js';
import { NOT_SET_MESSAGE, extractStatement, extractionConfigured } from '../services/extraction.js';
import { cleanExtract, matchStatement } from '../services/statementMatch.js';
import { isStatementFile, parseStatementFile } from '../services/statementFile.js';

const r = Router();
r.use(requireAuth, requireOrg);
const ctx = (req) => ({ orgId: req.orgId, userId: req.user.id });

r.get('/', ah(async (req, res) => {
  const params = [req.orgId];
  let where = `t.organization_id = $1 AND t.transaction_type = 'reconciliation'`;
  if (req.query.accountId) { params.push(Number(req.query.accountId)); where += ` AND t.account_id = $${params.length}`; }
  if (isDate(req.query.from)) { params.push(req.query.from); where += ` AND r.statement_date >= $${params.length}`; }
  if (isDate(req.query.to)) { params.push(req.query.to); where += ` AND r.statement_date <= $${params.length}`; }
  const { rows } = await query(
    `SELECT t.id, r.statement_date, r.statement_ending_balance, r.is_complete, a.name AS account_name, t.account_id
       FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id JOIN accounts a ON a.id = t.account_id
      WHERE ${where} ORDER BY r.statement_date DESC, t.id DESC`,
    params,
  );
  res.json(rows);
}));

/** Data for starting a new reconciliation of an account. */
r.get('/start', ah(async (req, res) => {
  const accountId = Number(req.query.accountId);
  const accts = await loadOwned({ query }, 'accounts', [accountId], req.orgId, 'account');
  const { rows: inProgress } = await query(
    `SELECT t.id FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND NOT r.is_complete`, [req.orgId, accountId]);
  res.json({
    account: accts[accountId],
    inProgressId: inProgress[0]?.id || null,
    beginningBalance: (await priorStatementBalance({ query }, req.orgId, accountId)) / 100,
    transactions: await reconciliationCandidates({ query }, req.orgId, accountId, null),
  });
}));

/** The bank account (and in-progress reconciliation, if any) a statement upload or match is for. */
async function statementTarget(req) {
  const accountId = idOrNull(req.body.accountId);
  if (!accountId) throw new HttpError(400, 'Choose the bank account first');
  const accts = await loadOwned({ query }, 'accounts', [accountId], req.orgId, 'account');
  if (!BANKING_TYPES.includes(accts[accountId].account_type)) throw new HttpError(400, 'Select a Bank or Credit Card account');
  const recId = idOrNull(req.body.reconciliationId);
  if (recId) {
    const { rows } = await query(
      `SELECT r.is_complete FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id
        WHERE t.id = $1 AND t.organization_id = $2 AND t.account_id = $3`, [recId, req.orgId, accountId]);
    if (!rows.length) throw new HttpError(404, 'Reconciliation not found');
    if (rows[0].is_complete) throw new HttpError(409, 'This reconciliation is complete. Undo it before making changes.');
  }
  return { account: accts[accountId], recId };
}

async function match(req, account, recId, extract) {
  const candidates = await reconciliationCandidates({ query }, req.orgId, account.id, recId);
  return matchStatement(extract.items, candidates, { statementEnd: extract.statement?.periodEnd });
}

/**
 * Read the statement: a CSV, OFX, QFX or QBO download directly, or a PDF or image with Claude (a CSV whose columns
 * can't be worked out goes to Claude too, when the organization has a key). Returns the extract (lines, period,
 * balances) and how its lines match the transactions waiting to be cleared. With reconciliationId, the extract is
 * saved on that reconciliation.
 */
r.post('/extract-statement', ah(async (req, res) => {
  const { account, recId } = await statementTarget(req);
  const file = parseUpload(req.body);
  const canAsk = () => extractionConfigured({ query }, req.orgId);
  let result;
  if (isStatementFile(file.fileName)) {
    try {
      result = parseStatementFile(file, account);
    } catch (err) {
      if (!(err instanceof HttpError) || !typeInfo(file.fileName)?.claude || !(await canAsk())) throw err;
      result = await extractStatement({ query }, req.orgId, file, account);
    }
  } else {
    if (!(await canAsk())) throw new HttpError(503, `${NOT_SET_MESSAGE} Or upload the statement as a CSV, OFX, QFX or QBO file from your bank.`);
    if (!typeInfo(file.fileName)?.claude) throw new HttpError(400, 'Upload the statement as a CSV, OFX, QFX or QBO file, or as a PDF or an image (JPEG, PNG, GIF or WebP).');
    result = await extractStatement({ query }, req.orgId, file, account);
  }
  const extract = cleanExtract({ ...result, fileName: file.fileName });
  const m = await match(req, account, recId, extract);
  if (recId) await query('UPDATE reconciliations SET statement_extract = $1 WHERE transaction_id = $2', [JSON.stringify({ ...extract, missing: m.missing }), recId]);
  // Keep the statement with the reconciliation (a new one holds it as a pending attachment until it's first saved).
  let attachment = null;
  try {
    attachment = await withTransaction((db) => saveAttachment(db, ctx(req), { fileName: req.body.fileName, data: req.body.data, transactionId: recId || undefined }));
  } catch (err) {
    if (!(err instanceof HttpError)) throw err; // e.g. the 25-file limit: the statement is still read
  }
  res.json({ extract: { ...extract, missing: m.missing }, match: m, attachment });
}));

/** Match a saved statement again (e.g. after creating transactions for its missing lines). */
r.post('/match-statement', ah(async (req, res) => {
  const { account, recId } = await statementTarget(req);
  const extract = cleanExtract(req.body.extract);
  if (!extract) throw new HttpError(400, 'No statement to match');
  res.json({ match: await match(req, account, recId, extract) });
}));

/**
 * Reconciliation report as of the statement date: the balances, the transactions cleared in this reconciliation,
 * and those dated on or before the statement date that were still uncleared at that point.
 */
r.get('/:id/report', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [rec] } = await query(
    `SELECT t.id, t.account_id, t.memo, r.*, a.account_type, a.account_number, a.name AS account_name, o.name AS organization_name,
            u.display_name AS prepared_by
       FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id JOIN accounts a ON a.id = t.account_id
       JOIN organizations o ON o.id = t.organization_id LEFT JOIN users u ON u.id = t.updated_by_user_id
      WHERE t.id = $1 AND t.organization_id = $2 AND t.transaction_type = 'reconciliation'`, [id, req.orgId]);
  if (!rec) throw new HttpError(404, 'Reconciliation not found');
  const D = rec.statement_date;
  const cleared = await reconciledItems({ query }, req.orgId, id, rec.account_id);
  // Not cleared as of D: never cleared, cleared later (a later statement, or a reconciliation still in progress).
  const notYet = (col) => `(${col} IS NULL OR (${col} <> $4 AND EXISTS (SELECT 1 FROM reconciliations rr WHERE rr.transaction_id = ${col} AND (rr.statement_date > $3 OR NOT rr.is_complete))))`;
  const { rows: uncleared } = await query(
    `SELECT t.id, t.transaction_type, t.date, t.amount, t.check_number, t.ref_number, t.memo, c.name AS company_name,
            CASE WHEN t.transaction_type = 'expense' THEN 'out' ELSE 'in' END AS direction
       FROM transactions t LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND t.transaction_type IN ('income', 'expense', 'deposit') AND t.date <= $3
        AND ${notYet('t.reconciliation_id')}
     UNION ALL
     SELECT t.id, t.transaction_type, t.date, ABS(SUM(d.amount))::numeric(14,2), NULL, NULL, t.memo, NULL,
            CASE WHEN SUM(d.amount) >= 0 THEN 'in' ELSE 'out' END
       FROM transactions t JOIN transaction_details d ON d.transaction_id = t.id
      WHERE t.organization_id = $1 AND d.account_id = $2 AND t.transaction_type IN ('journal', 'transfer') AND t.date <= $3
        AND ${notYet('d.reconciliation_id')}
      GROUP BY t.id HAVING SUM(d.amount) <> 0
      ORDER BY date, id`,
    [req.orgId, rec.account_id, D, id]);
  const { rows: [gl] } = await query(
    `SELECT COALESCE(SUM(ROUND(d.debit * 100) - ROUND(d.credit * 100)), 0)::bigint AS net
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
      WHERE h.organization_id = $1 AND d.account_id = $2 AND h.date <= $3`, [req.orgId, rec.account_id, D]);
  const { rows: attachments } = await query(
    `SELECT a.id, a.file_name, a.size_bytes, a.created_at FROM attachments a WHERE a.organization_id = $1 AND a.transaction_id = $2 ORDER BY a.created_at`, [req.orgId, id]);

  // Card balances are amounts owed: charges (out) raise them, credits (in) lower them.
  const sign = rec.account_type === 'credit_card' ? -1 : 1;
  const cents = (v) => Math.round(Number(v) * 100);
  const sum = (list, dir) => list.filter((x) => x.direction === dir).reduce((s, x) => s + cents(x.amount), 0);
  const count = (list, dir) => list.filter((x) => x.direction === dir).length;
  const beginning = cents(rec.beginning_balance);
  const sc = cents(rec.service_charge_amount);
  const ie = cents(rec.interest_amount);
  const clearedIn = sum(cleared, 'in');
  const clearedOut = sum(cleared, 'out');
  const clearedBalance = beginning + sign * (clearedIn - clearedOut - sc + ie);
  const ending = cents(rec.statement_ending_balance);
  const unIn = sum(uncleared, 'in');
  const unOut = sum(uncleared, 'out');
  const expectedRegister = clearedBalance + sign * (unIn - unOut);
  const register = sign * Number(gl.net);
  const d = (c) => (c / 100).toFixed(2);
  res.json({
    organization: rec.organization_name,
    account: { id: rec.account_id, name: rec.account_name, number: rec.account_number, type: rec.account_type },
    reconciliation: {
      id, statementDate: D, isComplete: rec.is_complete, completedAt: rec.completed_at, preparedBy: rec.prepared_by, memo: rec.memo,
      serviceChargeDate: rec.service_charge_date, interestDate: rec.interest_date,
    },
    summary: {
      beginningBalance: d(beginning),
      clearedDeposits: { count: count(cleared, 'in'), total: d(clearedIn) },
      clearedPayments: { count: count(cleared, 'out'), total: d(clearedOut) },
      serviceCharge: d(sc),
      interest: d(ie),
      clearedBalance: d(clearedBalance),
      statementEndingBalance: d(ending),
      difference: d(clearedBalance - ending),
      unclearedDeposits: { count: count(uncleared, 'in'), total: d(unIn) },
      unclearedPayments: { count: count(uncleared, 'out'), total: d(unOut) },
      expectedRegisterBalance: d(expectedRegister),
      registerBalance: d(register),
      registerDifference: d(register - expectedRegister),
    },
    cleared,
    uncleared,
    attachments,
    statement: rec.statement_extract ? { fileName: rec.statement_extract.fileName, periodStart: rec.statement_extract.statement?.periodStart, periodEnd: rec.statement_extract.statement?.periodEnd } : null,
  });
}));

r.get('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query(
    `SELECT t.id, t.account_id, t.memo, r.*, a.account_type, a.name AS account_name
       FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND t.organization_id = $2`,
    [id, req.orgId],
  );
  if (!rows.length) throw new HttpError(404, 'Reconciliation not found');
  const rec = rows[0];
  const transactions = rec.is_complete
    ? await reconciledItems({ query }, req.orgId, id, rec.account_id)
    : await reconciliationCandidates({ query }, req.orgId, rec.account_id, id);
  res.json({ ...rec, transactions });
}));

r.post('/', ah(async (req, res) => {
  const id = await withTransaction((db) => saveReconciliation(db, ctx(req), req.body));
  res.status(201).json({ id });
}));
r.put('/:id', ah(async (req, res) => {
  const id = await withTransaction((db) => saveReconciliation(db, ctx(req), req.body, Number(req.params.id)));
  res.json({ id });
}));
r.post('/:id/undo', ah(async (req, res) => {
  await withTransaction((db) => undoReconciliation(db, req.orgId, Number(req.params.id)));
  res.json({ ok: true });
}));
r.delete('/:id', ah(async (req, res) => {
  await withTransaction((db) => deleteReconciliation(db, req.orgId, Number(req.params.id)));
  res.json({ ok: true });
}));

export default r;
