import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { HttpError, ah } from '../util.js';
import { actualsForBudget, copyBudget, loadBudget, saveBudget } from '../services/budgets.js';

const r = Router();
r.use(requireAuth, requireOrg);

const ctx = (req) => ({ orgId: req.orgId, userId: req.user.id });

/** Budgets with their budgeted income, expenses and net (income − expenses). */
r.get('/', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.name, b.description, b.start_date, b.end_date, b.fund_id, f.name AS fund_name, b.updated_at,
            COALESCE(SUM(l.amount) FILTER (WHERE a.account_type IN ('income', 'other_income')), 0)::numeric(14,2) AS income,
            COALESCE(SUM(l.amount) FILTER (WHERE a.account_type IN ('expense', 'other_expense')), 0)::numeric(14,2) AS expense
       FROM budgets b
       LEFT JOIN funds f ON f.id = b.fund_id
       LEFT JOIN budget_lines l ON l.budget_id = b.id
       LEFT JOIN accounts a ON a.id = l.account_id
      WHERE b.organization_id = $1
      GROUP BY b.id, f.name
      ORDER BY b.start_date DESC, b.name`,
    [req.orgId],
  );
  res.json(rows.map((b) => ({ ...b, net: (Number(b.income) - Number(b.expense)).toFixed(2) })));
}));

/** Last year's actual activity laid out on a budget's months (doesn't save anything). */
r.get('/actuals', ah(async (req, res) => {
  res.json(await actualsForBudget({ query }, req.orgId, req.query));
}));

r.get('/:id', ah(async (req, res) => {
  const b = await loadBudget({ query }, req.orgId, req.params.id);
  res.json({ ...b, lines: b.lines.map(({ cents, ...l }) => l) });
}));

r.post('/', ah(async (req, res) => {
  const id = await withTransaction((db) => saveBudget(db, ctx(req), req.body));
  res.status(201).json({ id });
}));

r.put('/:id', ah(async (req, res) => {
  const id = await withTransaction((db) => saveBudget(db, ctx(req), req.body, Number(req.params.id)));
  res.json({ id });
}));

r.post('/:id/copy', ah(async (req, res) => {
  const id = await withTransaction((db) => copyBudget(db, ctx(req), Number(req.params.id), req.body || {}));
  res.status(201).json({ id });
}));

r.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await query('DELETE FROM budgets WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  if (!rowCount) throw new HttpError(404, 'Budget not found');
  res.json({ ok: true });
}));

export default r;
