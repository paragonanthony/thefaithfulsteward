import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin } from '../auth.js';
import { HttpError, ah, isDate } from '../util.js';
import { todayStr } from '../services/dates.js';

const r = Router();
r.use(requireAuth, requireOrg);

r.get('/', ah(async (req, res) => {
  const { rows: [org] } = await query('SELECT period_closing_date FROM organizations WHERE id = $1', [req.orgId]);
  const { rows: history } = await query(
    `SELECT l.previous_date, l.closing_date, l.note, l.created_at, u.display_name AS changed_by
       FROM period_closing_log l LEFT JOIN users u ON u.id = l.created_by_user_id
      WHERE l.organization_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 50`,
    [req.orgId],
  );
  res.json({ closingDate: org.period_closing_date, history });
}));

/** Set (or with closingDate null, remove) the closing date. Organization administrators only. */
r.put('/', requireOrgAdmin, ah(async (req, res) => {
  const closingDate = req.body.closingDate || null;
  if (closingDate && !isDate(closingDate)) throw new HttpError(400, 'Enter a valid closing date');
  if (closingDate && closingDate > todayStr()) throw new HttpError(400, 'The closing date can’t be in the future');
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  const result = await withTransaction(async (db) => {
    const { rows: [org] } = await db.query('SELECT period_closing_date FROM organizations WHERE id = $1 FOR UPDATE', [req.orgId]);
    if ((org.period_closing_date || null) === closingDate) return { closingDate, changed: false };
    await db.query('UPDATE organizations SET period_closing_date = $1 WHERE id = $2', [closingDate, req.orgId]);
    await db.query('INSERT INTO period_closing_log (organization_id, previous_date, closing_date, note) VALUES ($1, $2, $3, $4)',
      [req.orgId, org.period_closing_date, closingDate, note]);
    return { closingDate, changed: true };
  });
  res.json(result);
}));

export default r;
