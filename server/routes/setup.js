import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin } from '../auth.js';
import { ACCOUNT_TYPES, TYPE_BY_KEY, isValidType } from '../accountTypes.js';
import { HttpError, ah, emptyToNull, idOrNull, loadOwned } from '../util.js';
import { listQuery } from '../paging.js';

const r = Router();
r.use(requireAuth, requireOrg);

const text = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const required = (v, label) => {
  const s = text(v);
  if (!s) throw new HttpError(400, `${label} is required`);
  return s;
};

// ----- Organization settings -----
r.get('/org', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM organizations WHERE id = $1', [req.orgId]);
  res.json({ ...rows[0], role: req.orgRole });
}));

r.put('/org', requireOrgAdmin, ah(async (req, res) => {
  const b = req.body;
  const fy = Number(b.fiscal_year_start_month || 1);
  if (!(fy >= 1 && fy <= 12)) throw new HttpError(400, 'Fiscal year start month must be 1-12');
  const { rows } = await query(
    `UPDATE organizations SET name=$1, fiscal_year_start_month=$2, address1=$3, address2=$4, city=$5, state=$6, postal=$7,
            phone=$8, email=$9, ein=$10, tuition_enabled=$11 WHERE id=$12 RETURNING *`,
    [required(b.name, 'Name'), fy, text(b.address1), text(b.address2), text(b.city), text(b.state), text(b.postal), text(b.phone), text(b.email), text(b.ein),
      Boolean(b.tuition_enabled), req.orgId],
  );
  res.json(rows[0]);
}));

// ----- Dropdown data for forms -----
r.get('/lookups', ah(async (req, res) => {
  const [accounts, funds, companies, groups] = await Promise.all([
    query(`SELECT id, account_number, name, account_type, default_fund_id, is_undeposited_funds, is_active, account_group_id, check_format_id
             FROM accounts WHERE organization_id = $1 ORDER BY account_number NULLS LAST, name`, [req.orgId]),
    query('SELECT id, name, is_active, is_restricted FROM funds WHERE organization_id = $1 ORDER BY name', [req.orgId]),
    query(`SELECT id, name, default_income_account_id, default_expense_account_id, is_active
             FROM companies WHERE organization_id = $1 ORDER BY name`, [req.orgId]),
    query('SELECT id, name, account_type, sort_order FROM account_groups WHERE organization_id = $1 ORDER BY sort_order, name', [req.orgId]),
  ]);
  res.json({ accounts: accounts.rows, funds: funds.rows, companies: companies.rows, groups: groups.rows, accountTypes: ACCOUNT_TYPES });
}));

// ----- Accounts -----
r.get('/accounts', ah(async (req, res) => {
  const s = text(req.query.search);
  const { rows } = await query(
    `SELECT a.*, g.name AS group_name, f.name AS default_fund_name
       FROM accounts a LEFT JOIN account_groups g ON g.id = a.account_group_id LEFT JOIN funds f ON f.id = a.default_fund_id
      WHERE a.organization_id = $1 AND ($2::text IS NULL OR a.name ILIKE '%' || $2 || '%' OR a.account_number ILIKE '%' || $2 || '%')
      ORDER BY a.account_number NULLS LAST, a.name`,
    [req.orgId, s],
  );
  res.json(rows.map((a) => ({ ...a, account_type_label: TYPE_BY_KEY[a.account_type]?.label })));
}));

r.get('/accounts/:id', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM accounts WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  if (!rows.length) throw new HttpError(404, 'Account not found');
  res.json(rows[0]);
}));

async function accountValues(req, type) {
  const b = req.body;
  const groupId = idOrNull(b.account_group_id);
  const fundId = idOrNull(b.default_fund_id);
  if (groupId) {
    const g = await loadOwned({ query }, 'account_groups', [groupId], req.orgId, 'account group');
    if (g[groupId].account_type !== type) throw new HttpError(400, 'The account group must have the same account type as the account');
  }
  if (fundId) await loadOwned({ query }, 'funds', [fundId], req.orgId, 'fund');
  // Check formats only apply to bank accounts that checks are written from.
  const checkFormatId = type === 'bank' ? idOrNull(b.check_format_id) : null;
  if (checkFormatId) await loadOwned({ query }, 'check_formats', [checkFormatId], req.orgId, 'check format');
  return [text(b.account_number), required(b.name, 'Account Name'), text(b.description), groupId, fundId,
    type === 'bank' && Boolean(b.is_undeposited_funds), b.is_active !== false, checkFormatId];
}

r.post('/accounts', ah(async (req, res) => {
  const type = req.body.account_type;
  if (!isValidType(type)) throw new HttpError(400, 'Select an account type');
  const v = await accountValues(req, type);
  const { rows } = await query(
    `INSERT INTO accounts (organization_id, account_type, account_number, name, description, account_group_id, default_fund_id, is_undeposited_funds, is_active, check_format_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.orgId, type, ...v],
  );
  res.status(201).json(rows[0]);
}));

r.put('/accounts/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await loadOwned({ query }, 'accounts', [id], req.orgId, 'account');
  let type = existing[id].account_type;
  const SWITCHABLE = ['current_liability', 'accounts_payable'];
  if (req.body.account_type && req.body.account_type !== type) {
    if (!SWITCHABLE.includes(type) || !SWITCHABLE.includes(req.body.account_type)) throw new HttpError(400, 'The account type can’t be changed');
    if (type === 'accounts_payable') {
      const { rows: bills } = await query(`SELECT 1 FROM transactions WHERE account_id = $1 AND transaction_type = 'bill' LIMIT 1`, [id]);
      if (bills.length) throw new HttpError(409, 'This account has bills, so it must stay an Accounts Payable account');
    }
    type = req.body.account_type;
  }
  const v = await accountValues(req, type);
  const { rows } = await query(
    `UPDATE accounts SET account_number=$1, name=$2, description=$3, account_group_id=$4, default_fund_id=$5, is_undeposited_funds=$6, is_active=$7,
            check_format_id=$8, account_type=$9
      WHERE id=$10 AND organization_id=$11 RETURNING *`,
    [...v, type, id, req.orgId],
  );
  res.json(rows[0]);
}));

r.delete('/accounts/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await loadOwned({ query }, 'accounts', [id], req.orgId, 'account');
  const { rows } = await query(
    `SELECT EXISTS(SELECT 1 FROM gl_details WHERE account_id = $1) OR EXISTS(SELECT 1 FROM transactions WHERE account_id = $1)
            OR EXISTS(SELECT 1 FROM transaction_details WHERE account_id = $1) AS used`, [id]);
  if (rows[0].used) throw new HttpError(409, 'This account has transactions. Mark it inactive instead of deleting it.');
  await query('DELETE FROM accounts WHERE id = $1 AND organization_id = $2', [id, req.orgId]);
  res.json({ ok: true });
}));

// ----- Funds -----
r.get('/funds', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM funds WHERE organization_id = $1 ORDER BY name', [req.orgId]);
  res.json(rows);
}));
r.post('/funds', ah(async (req, res) => {
  const { rows } = await query(
    'INSERT INTO funds (organization_id, name, description, is_restricted) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.orgId, required(req.body.name, 'Fund Name'), text(req.body.description), Boolean(req.body.is_restricted)],
  );
  res.status(201).json(rows[0]);
}));
r.put('/funds/:id', ah(async (req, res) => {
  const { rows } = await query(
    'UPDATE funds SET name=$1, description=$2, is_restricted=$3, is_active=$4 WHERE id=$5 AND organization_id=$6 RETURNING *',
    [required(req.body.name, 'Fund Name'), text(req.body.description), Boolean(req.body.is_restricted), req.body.is_active !== false, Number(req.params.id), req.orgId],
  );
  if (!rows.length) throw new HttpError(404, 'Fund not found');
  res.json(rows[0]);
}));
r.delete('/funds/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await loadOwned({ query }, 'funds', [id], req.orgId, 'fund');
  const { rows } = await query(
    `SELECT EXISTS(SELECT 1 FROM gl_details WHERE fund_id = $1) OR EXISTS(SELECT 1 FROM transactions WHERE fund_id = $1)
            OR EXISTS(SELECT 1 FROM transaction_details WHERE fund_id = $1) AS used`, [id]);
  if (rows[0].used) throw new HttpError(409, 'This fund has transactions. Mark it inactive instead of deleting it.');
  const { rows: budgets } = await query('SELECT name FROM budgets WHERE fund_id = $1 ORDER BY name', [id]);
  if (budgets.length) throw new HttpError(409, `This fund has a fund budget (${budgets.map((b) => b.name).join(', ')}). Delete the budget or mark the fund inactive instead.`);
  await query('DELETE FROM funds WHERE id = $1 AND organization_id = $2', [id, req.orgId]);
  res.json({ ok: true });
}));

// ----- Account groups -----
r.get('/account-groups', ah(async (req, res) => {
  const { rows } = await query('SELECT * FROM account_groups WHERE organization_id = $1 ORDER BY account_type, sort_order, name', [req.orgId]);
  res.json(rows);
}));
r.post('/account-groups', ah(async (req, res) => {
  if (!isValidType(req.body.account_type)) throw new HttpError(400, 'Select an account type');
  const { rows } = await query(
    'INSERT INTO account_groups (organization_id, name, account_type, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.orgId, required(req.body.name, 'Group Name'), req.body.account_type, Number(req.body.sort_order) || 0],
  );
  res.status(201).json(rows[0]);
}));
r.put('/account-groups/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const g = await loadOwned({ query }, 'account_groups', [id], req.orgId, 'account group');
  const type = req.body.account_type || g[id].account_type;
  if (!isValidType(type)) throw new HttpError(400, 'Select an account type');
  if (type !== g[id].account_type) {
    const used = await query('SELECT 1 FROM accounts WHERE account_group_id = $1 LIMIT 1', [id]);
    if (used.rows.length) throw new HttpError(409, 'Accounts are assigned to this group, so its type cannot be changed');
  }
  const { rows } = await query(
    'UPDATE account_groups SET name=$1, account_type=$2, sort_order=$3 WHERE id=$4 AND organization_id=$5 RETURNING *',
    [required(req.body.name, 'Group Name'), type, Number(req.body.sort_order) || 0, id, req.orgId],
  );
  res.json(rows[0]);
}));
r.delete('/account-groups/:id', ah(async (req, res) => {
  await query('DELETE FROM account_groups WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  res.json({ ok: true });
}));

// ----- Customers, Donors & Vendors -----
r.get('/companies', ah(async (req, res) => {
  const s = text(req.query.search);
  res.json(await listQuery(query, req, {
    sql: `SELECT * FROM companies WHERE organization_id = $1 AND ($2::text IS NULL OR name ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%'
             OR phone1 ILIKE '%'||$2||'%' OR city ILIKE '%'||$2||'%' OR address1 ILIKE '%'||$2||'%')`,
    params: [req.orgId, s], orderBy: 'name, id', cap: 500, idCol: 'id',
    sorts: { name: 'lower(name)', address: "lower(concat_ws(', ', address1, city, state))", email: 'lower(email)', phone: 'phone1' },
  }));
}));
r.get('/companies/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT * FROM companies WHERE id = $1 AND organization_id = $2', [id, req.orgId]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  const { rows: txns } = await query(
    `SELECT id, transaction_type, date, amount, check_number, ref_number, memo FROM transactions
      WHERE organization_id = $1 AND company_id = $2 ORDER BY date DESC, id DESC LIMIT 200`, [req.orgId, id]);
  res.json({ ...rows[0], transactions: txns });
}));

async function companyValues(req) {
  const b = req.body;
  const inc = idOrNull(b.default_income_account_id);
  const exp = idOrNull(b.default_expense_account_id);
  await loadOwned({ query }, 'accounts', [inc, exp], req.orgId, 'account');
  return [required(b.name, 'Name'), text(b.address1), text(b.address2), text(b.city), text(b.state), text(b.postal),
    text(b.phone1), text(b.phone2), text(b.email), emptyToNull(b.notes), inc, exp, b.is_active !== false];
}
r.post('/companies', ah(async (req, res) => {
  const v = await companyValues(req);
  const { rows } = await query(
    `INSERT INTO companies (organization_id, name, address1, address2, city, state, postal, phone1, phone2, email, notes,
                            default_income_account_id, default_expense_account_id, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [req.orgId, ...v],
  );
  res.status(201).json(rows[0]);
}));
r.put('/companies/:id', ah(async (req, res) => {
  const v = await companyValues(req);
  const { rows } = await query(
    `UPDATE companies SET name=$1, address1=$2, address2=$3, city=$4, state=$5, postal=$6, phone1=$7, phone2=$8, email=$9, notes=$10,
            default_income_account_id=$11, default_expense_account_id=$12, is_active=$13
      WHERE id=$14 AND organization_id=$15 RETURNING *`,
    [...v, Number(req.params.id), req.orgId],
  );
  if (!rows.length) throw new HttpError(404, 'Not found');
  res.json(rows[0]);
}));
r.delete('/companies/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const used = await query('SELECT 1 FROM transactions WHERE company_id = $1 LIMIT 1', [id]);
  if (used.rows.length) throw new HttpError(409, 'This name is used on transactions. Mark it inactive instead of deleting it.');
  await query('DELETE FROM companies WHERE id = $1 AND organization_id = $2', [id, req.orgId]);
  res.json({ ok: true });
}));

// ----- Audit info (created / last updated) for a record -----
// scope: how to check the record belongs to the current organization
const AUDIT_TABLES = {
  transactions: 'org', companies: 'org', accounts: 'org', funds: 'org', account_groups: 'org', tuition_records: 'org',
  report_definitions: 'org', check_formats: 'org', budgets: 'org', receipt_templates: 'org', import_batches: 'org', organizations: 'self', users: 'member',
};
r.get('/audit/:table/:id', ah(async (req, res) => {
  const table = req.params.table;
  const scope = AUDIT_TABLES[table];
  if (!scope) throw new HttpError(404, 'Not found');
  const where = scope === 'org' ? 'x.organization_id = $2'
    : scope === 'self' ? 'x.id = $2'
      : 'EXISTS (SELECT 1 FROM user_organizations uo WHERE uo.user_id = x.id AND uo.organization_id = $2)';
  const { rows } = await query(
    `SELECT x.created_at, cu.display_name AS created_by, x.updated_at, uu.display_name AS updated_by
       FROM ${table} x LEFT JOIN users cu ON cu.id = x.created_by_user_id LEFT JOIN users uu ON uu.id = x.updated_by_user_id
      WHERE x.id = $1 AND ${where}`,
    [Number(req.params.id), req.orgId],
  );
  if (!rows.length) throw new HttpError(404, 'Not found');
  res.json(rows[0]);
}));

export default r;
