import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError, ah, emptyToNull, fromCents, idOrNull, isDate, loadOwned, requireDate, toCents } from '../util.js';
import { listQuery } from '../paging.js';

const r = Router();
r.use(requireAuth, requireOrg);

/** Tuition endpoints only work when the organization has turned the feature on. */
r.use(ah(async (req, res, next) => {
  const { rows } = await query('SELECT tuition_enabled FROM organizations WHERE id = $1', [req.orgId]);
  if (!rows[0]?.tuition_enabled) throw new HttpError(403, 'Tuition tracking is not enabled for this organization (see Organization settings)');
  next();
}));

// paid = sum of income lines linked to the record
const SELECT_TUITION = `
  SELECT tr.*, c.name AS company_name, a.name AS income_account_name, a.account_number AS income_account_number, f.name AS fund_name,
         COALESCE(p.paid, 0)::numeric(14,2) AS paid, (tr.amount - COALESCE(p.paid, 0))::numeric(14,2) AS balance
    FROM tuition_records tr
    JOIN companies c ON c.id = tr.company_id
    LEFT JOIN accounts a ON a.id = tr.income_account_id
    LEFT JOIN funds f ON f.id = tr.fund_id
    LEFT JOIN (SELECT d.tuition_id, SUM(d.amount) AS paid FROM transaction_details d WHERE d.tuition_id IS NOT NULL GROUP BY d.tuition_id) p ON p.tuition_id = tr.id`;

r.get('/', ah(async (req, res) => {
  const params = [req.orgId];
  let where = 'tr.organization_id = $1';
  const add = (sql, v) => { params.push(v); where += ` AND ${sql.replace('?', `$${params.length}`)}`; };
  if (req.query.companyId) add('tr.company_id = ?', Number(req.query.companyId));
  if (isDate(req.query.from)) add('tr.date >= ?', req.query.from);
  if (isDate(req.query.to)) add('tr.date <= ?', req.query.to);
  const s = String(req.query.search || '').trim();
  if (s) {
    params.push(s);
    where += ` AND (c.name ILIKE '%'||$${params.length}||'%' OR tr.description ILIKE '%'||$${params.length}||'%')`;
  }
  // status: open (balance > 0), paid (balance <= 0), all. `include` keeps specific ids (e.g. already linked on a line).
  const status = req.query.status || 'all';
  const include = String(req.query.include || '').split(',').map(Number).filter(Boolean);
  let statusSql = '';
  if (status === 'open' || status === 'paid') {
    statusSql = status === 'open' ? 'tr.amount - COALESCE(p.paid, 0) > 0' : 'tr.amount - COALESCE(p.paid, 0) <= 0';
    if (include.length) { params.push(include); statusSql = `(${statusSql} OR tr.id = ANY($${params.length}::int[]))`; }
    statusSql = ` AND ${statusSql}`;
  }
  res.json(await listQuery(query, req, {
    sql: `${SELECT_TUITION} WHERE ${where}${statusSql}`, params, orderBy: 'tr.date DESC, c.name, tr.id DESC', cap: 2000, idCol: 'tr.id',
    sorts: { date: 'tr.date', company: 'lower(c.name)', description: 'lower(tr.description)', amount: 'tr.amount', paid: 'paid', balance: 'balance' },
    sums: { amount: 'SUM(q.amount)', paid: 'SUM(q.paid)', balance: 'SUM(q.balance)' },
  }));
}));

r.get('/:id', ah(async (req, res) => {
  const { rows } = await query(`${SELECT_TUITION} WHERE tr.id = $1 AND tr.organization_id = $2`, [Number(req.params.id), req.orgId]);
  if (!rows.length) throw new HttpError(404, 'Tuition record not found');
  const { rows: payments } = await query(
    `SELECT t.id AS transaction_id, t.date, t.check_number, t.ref_number, d.amount, d.memo
       FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id
      WHERE d.tuition_id = $1 AND t.organization_id = $2 ORDER BY t.date, t.id`,
    [rows[0].id, req.orgId],
  );
  res.json({ ...rows[0], payments });
}));

/** Validate the shared fields of a tuition record (customer is validated by the caller). */
async function recordValues(req, body) {
  const date = requireDate(body.date);
  const amount = toCents(body.amount);
  if (amount <= 0) throw new HttpError(400, 'Tuition amount must be greater than zero');
  const accountId = idOrNull(body.incomeAccountId);
  const fundId = idOrNull(body.fundId);
  if (accountId) {
    const a = await loadOwned({ query }, 'accounts', [accountId], req.orgId, 'account');
    if (TYPE_BY_KEY[a[accountId].account_type]?.category !== 'income') throw new HttpError(400, 'The tuition account must be an income account');
  }
  if (fundId) await loadOwned({ query }, 'funds', [fundId], req.orgId, 'fund');
  const description = emptyToNull(String(body.description ?? '').trim().slice(0, 200));
  const memo = emptyToNull(String(body.memo ?? '').trim().slice(0, 1000));
  return { date, amount, accountId, fundId, description, memo };
}

r.post('/', ah(async (req, res) => {
  const companyId = idOrNull(req.body.companyId);
  if (!companyId) throw new HttpError(400, 'Customer is required');
  await loadOwned({ query }, 'companies', [companyId], req.orgId, 'customer');
  const v = await recordValues(req, req.body);
  const { rows } = await query(
    `INSERT INTO tuition_records (organization_id, company_id, date, description, amount, income_account_id, fund_id, memo, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [req.orgId, companyId, v.date, v.description, fromCents(v.amount), v.accountId, v.fundId, v.memo, req.user.id],
  );
  res.status(201).json({ id: rows[0].id });
}));

/** Create one tuition record per selected customer with the same date, amount and details. */
r.post('/bulk', ah(async (req, res) => {
  const ids = [...new Set((req.body.companyIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new HttpError(400, 'Select at least one customer');
  if (ids.length > 2000) throw new HttpError(400, 'Select at most 2,000 customers at a time');
  await loadOwned({ query }, 'companies', ids, req.orgId, 'customer');
  const v = await recordValues(req, req.body);
  const skipDuplicates = req.body.skipDuplicates !== false;
  const result = await withTransaction(async (db) => {
    let created = 0;
    const skipped = [];
    for (const companyId of ids) {
      if (skipDuplicates) {
        const { rows } = await db.query(
          `SELECT 1 FROM tuition_records WHERE organization_id = $1 AND company_id = $2 AND date = $3 AND COALESCE(description, '') = COALESCE($4, '') LIMIT 1`,
          [req.orgId, companyId, v.date, v.description],
        );
        if (rows.length) { skipped.push(companyId); continue; }
      }
      await db.query(
        `INSERT INTO tuition_records (organization_id, company_id, date, description, amount, income_account_id, fund_id, memo, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.orgId, companyId, v.date, v.description, fromCents(v.amount), v.accountId, v.fundId, v.memo, req.user.id],
      );
      created++;
    }
    return { created, skipped };
  });
  res.status(201).json(result);
}));

r.put('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = (await loadOwned({ query }, 'tuition_records', [id], req.orgId, 'tuition record'))[id];
  const companyId = idOrNull(req.body.companyId) || existing.company_id;
  if (companyId !== existing.company_id) {
    const { rows } = await query('SELECT 1 FROM transaction_details WHERE tuition_id = $1 LIMIT 1', [id]);
    if (rows.length) throw new HttpError(409, 'This tuition record has payments, so its customer cannot be changed');
    await loadOwned({ query }, 'companies', [companyId], req.orgId, 'customer');
  }
  const v = await recordValues(req, req.body);
  await query(
    `UPDATE tuition_records SET company_id=$1, date=$2, description=$3, amount=$4, income_account_id=$5, fund_id=$6, memo=$7, updated_at=now()
      WHERE id=$8 AND organization_id=$9`,
    [companyId, v.date, v.description, fromCents(v.amount), v.accountId, v.fundId, v.memo, id, req.orgId],
  );
  res.json({ id });
}));

r.delete('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await loadOwned({ query }, 'tuition_records', [id], req.orgId, 'tuition record');
  const { rows } = await query('SELECT 1 FROM transaction_details WHERE tuition_id = $1 LIMIT 1', [id]);
  if (rows.length) throw new HttpError(409, 'This tuition record has payments. Remove the payments from their income transactions before deleting it.');
  await query('DELETE FROM tuition_records WHERE id = $1 AND organization_id = $2', [id, req.orgId]);
  res.json({ ok: true });
}));

export default r;
