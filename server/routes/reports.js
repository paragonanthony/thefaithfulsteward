import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { HttpError, ah, isDate } from '../util.js';
import { BUILTIN_BY_KEY, BUILTIN_REPORTS, TUITION_BUILTIN, blankDefinition } from '../services/builtinReports.js';
import { cleanDefinition, drilldown, runReport } from '../services/reports.js';
import { seedBuiltinReports } from '../services/orgSetup.js';
import { resolvePeriod } from '../services/dates.js';

const r = Router();
r.use(requireAuth, requireOrg);

const PERIODS = [
  ['this_fiscal_year', 'This Fiscal Year'], ['fiscal_ytd', 'Fiscal Year to Date'], ['last_fiscal_year', 'Last Fiscal Year'],
  ['this_quarter', 'This Quarter'], ['last_quarter', 'Last Quarter'], ['this_month', 'This Month'], ['last_month', 'Last Month'],
  ['today', 'Today'], ['all', 'All Dates'],
];

async function fiscalStart(orgId) {
  const { rows } = await query('SELECT fiscal_year_start_month FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.fiscal_year_start_month || 1;
}

async function loadReport(req) {
  const { rows } = await query('SELECT * FROM report_definitions WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  if (!rows.length) throw new HttpError(404, 'Report not found');
  return rows[0];
}

/** Named date ranges resolved for this organization's fiscal year. */
r.get('/periods', ah(async (req, res) => {
  const fy = await fiscalStart(req.orgId);
  res.json(PERIODS.map(([key, label]) => ({ key, label, ...resolvePeriod(key, fy) })));
}));

async function tuitionEnabled(orgId) {
  const { rows } = await query('SELECT tuition_enabled FROM organizations WHERE id = $1', [orgId]);
  return Boolean(rows[0]?.tuition_enabled);
}

r.get('/', ah(async (req, res) => {
  await seedBuiltinReports({ query }, req.orgId);
  const tuition = await tuitionEnabled(req.orgId);
  if (tuition) {
    // The standard Tuition Balances report is added the first time reports are listed with tuition turned on.
    await query(
      `INSERT INTO report_definitions (organization_id, name, description, builtin_key, definition)
       SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM report_definitions WHERE organization_id = $1 AND builtin_key = $4)`,
      [req.orgId, TUITION_BUILTIN.name, TUITION_BUILTIN.description, TUITION_BUILTIN.key, JSON.stringify(cleanDefinition(TUITION_BUILTIN.definition))],
    );
  }
  const { rows } = await query(
    `SELECT r.id, r.name, r.description, r.builtin_key, r.definition->>'type' AS type, r.definition->'columns'->>'mode' AS column_mode,
            r.definition->>'groupBy' AS group_by, r.updated_at, u.display_name AS created_by
       FROM report_definitions r LEFT JOIN users u ON u.id = r.created_by_user_id
      WHERE r.organization_id = $1 AND ($2 OR r.definition->>'type' IS DISTINCT FROM 'tuition')
      ORDER BY (r.builtin_key IS NULL), r.id`,
    [req.orgId, tuition],
  );
  // Standard reports in their defined order (whenever they were added), then custom reports oldest first.
  const order = Object.fromEntries([...BUILTIN_REPORTS, TUITION_BUILTIN].map((b, i) => [b.key, i]));
  rows.sort((a, b) => (order[a.builtin_key] ?? 1000 + a.id) - (order[b.builtin_key] ?? 1000 + b.id));
  res.json(rows);
}));

r.get('/blank', (req, res) => {
  const type = ['balance_sheet', 'tuition'].includes(req.query.type) ? req.query.type : 'pnl';
  res.json(cleanDefinition(blankDefinition(type)));
});

r.get('/:id', ah(async (req, res) => {
  const rep = await loadReport(req);
  res.json({ ...rep, definition: cleanDefinition(rep.definition) });
}));

r.post('/', ah(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Report name is required');
  const def = cleanDefinition(req.body.definition);
  const { rows } = await query(
    `INSERT INTO report_definitions (organization_id, name, description, definition, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.orgId, name, req.body.description || null, JSON.stringify(def), req.user.id],
  );
  res.status(201).json(rows[0]);
}));

r.put('/:id', ah(async (req, res) => {
  await loadReport(req);
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Report name is required');
  const def = cleanDefinition(req.body.definition);
  const { rows } = await query(
    `UPDATE report_definitions SET name=$1, description=$2, definition=$3, updated_at=now() WHERE id=$4 AND organization_id=$5 RETURNING *`,
    [name, req.body.description || null, JSON.stringify(def), Number(req.params.id), req.orgId],
  );
  res.json(rows[0]);
}));

r.post('/:id/copy', ah(async (req, res) => {
  const src = await loadReport(req);
  const { rows } = await query(
    `INSERT INTO report_definitions (organization_id, name, description, definition, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.orgId, String(req.body.name || `${src.name} (Copy)`), src.description, JSON.stringify(src.definition), req.user.id],
  );
  res.status(201).json(rows[0]);
}));

r.post('/:id/reset', ah(async (req, res) => {
  const rep = await loadReport(req);
  const builtin = BUILTIN_BY_KEY[rep.builtin_key];
  if (!builtin) throw new HttpError(400, 'Only standard reports can be reset');
  const { rows } = await query(
    'UPDATE report_definitions SET name=$1, description=$2, definition=$3, updated_at=now() WHERE id=$4 RETURNING *',
    [builtin.name, builtin.description, JSON.stringify(cleanDefinition(builtin.definition)), rep.id],
  );
  res.json(rows[0]);
}));

r.delete('/:id', ah(async (req, res) => {
  const rep = await loadReport(req);
  if (rep.builtin_key) throw new HttpError(400, 'Standard reports cannot be deleted (use Reset to restore the original layout)');
  await query('DELETE FROM report_definitions WHERE id = $1 AND organization_id = $2', [rep.id, req.orgId]);
  res.json({ ok: true });
}));

/** Run a report definition (saved or unsaved, e.g. a designer preview) for a date range. */
r.post('/run', ah(async (req, res) => {
  const { definition, from, to, budgetId } = req.body;
  if (!isDate(to) || (from && !isDate(from))) throw new HttpError(400, 'Select a valid date range');
  res.json(await runReport({ query }, req.orgId, definition, { from, to, budgetId }));
}));

r.post('/drilldown', ah(async (req, res) => {
  res.json(await drilldown({ query }, req.orgId, req.body));
}));

export default r;
