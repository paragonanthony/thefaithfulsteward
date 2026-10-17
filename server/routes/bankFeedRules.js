import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { HttpError, ah } from '../util.js';
import { applyRules, cleanRule } from '../services/bankFeedRules.js';

// Bank feed rules (Bank Feed Setup). Saving, deleting or reordering rules re-applies them to unmatched lines that
// weren't assigned by hand.
const r = Router();
r.use(requireAuth, requireOrg);

r.get('/', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.name AS company_name, a.name AS account_name, a.account_number, ba.name AS bank_account_name
       FROM bank_feed_rules r LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN accounts ba ON ba.id = r.bank_account_id
      WHERE r.organization_id = $1 ORDER BY r.sort_order, r.id`, [req.orgId]);
  res.json(rows);
}));

async function loadRule(db, orgId, id) {
  const { rows } = await db.query('SELECT * FROM bank_feed_rules WHERE id = $1 AND organization_id = $2', [id, orgId]);
  if (!rows.length) throw new HttpError(404, 'Rule not found');
  return rows[0];
}

const fields = (x) => [x.name, x.matchText, x.direction, x.minAmount, x.maxAmount, x.bankAccountId, x.companyId, x.accountId, x.isActive];

r.post('/', ah(async (req, res) => {
  const out = await withTransaction(async (db) => {
    const x = await cleanRule(db, req.orgId, req.body);
    const { rows: [row] } = await db.query(
      `INSERT INTO bank_feed_rules (organization_id, name, match_text, direction, min_amount, max_amount, bank_account_id, company_id, account_id, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM bank_feed_rules WHERE organization_id = $1)) RETURNING id`,
      [req.orgId, ...fields(x)]);
    return { id: row.id, assigned: await applyRules(db, req.orgId) };
  });
  res.status(201).json(out);
}));

/** Set the order rules are tried in: { ids: [ruleId, ...] } first to last. */
r.put('/order', ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const out = await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT id FROM bank_feed_rules WHERE organization_id = $1', [req.orgId]);
    const have = new Set(rows.map((x) => x.id));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) throw new HttpError(400, 'List every rule once to reorder them');
    for (const [i, id] of ids.entries()) await db.query('UPDATE bank_feed_rules SET sort_order = $1 WHERE id = $2', [i + 1, id]);
    return { assigned: await applyRules(db, req.orgId) };
  });
  res.json(out);
}));

r.put('/:id', ah(async (req, res) => {
  const out = await withTransaction(async (db) => {
    const rule = await loadRule(db, req.orgId, Number(req.params.id));
    const x = await cleanRule(db, req.orgId, req.body);
    await db.query(
      `UPDATE bank_feed_rules SET name=$1, match_text=$2, direction=$3, min_amount=$4, max_amount=$5, bank_account_id=$6, company_id=$7, account_id=$8, is_active=$9
        WHERE id = $10`, [...fields(x), rule.id]);
    return { id: rule.id, assigned: await applyRules(db, req.orgId) };
  });
  res.json(out);
}));

r.delete('/:id', ah(async (req, res) => {
  const out = await withTransaction(async (db) => {
    const rule = await loadRule(db, req.orgId, Number(req.params.id));
    await db.query('DELETE FROM bank_feed_rules WHERE id = $1', [rule.id]);
    return { assigned: await applyRules(db, req.orgId) };
  });
  res.json(out);
}));

/** Apply the rules again now (e.g. after changing a customer / vendor's default account). */
r.post('/apply', ah(async (req, res) => {
  res.json({ assigned: await withTransaction((db) => applyRules(db, req.orgId)) });
}));

export default r;
