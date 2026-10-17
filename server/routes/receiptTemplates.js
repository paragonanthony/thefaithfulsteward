import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin } from '../auth.js';
import { HttpError, ah } from '../util.js';
import { DATE_FORMATS, DEFAULT_TEMPLATE, FONTS, MERGE_FIELDS, imageProblem, normalizeTemplate } from '../services/receiptTemplates.js';

const r = Router();
r.use(requireAuth, requireOrg);

/** Every organization starts with one standard receipt, created the first time templates are listed. */
async function ensureDefault(orgId) {
  await query(
    `INSERT INTO receipt_templates (organization_id, name, template, is_default)
     SELECT $1, 'Standard receipt', $2, true
      WHERE NOT EXISTS (SELECT 1 FROM receipt_templates WHERE organization_id = $1)
     ON CONFLICT DO NOTHING`,
    [orgId, JSON.stringify(DEFAULT_TEMPLATE)],
  );
}

async function loadTemplate(orgId, id) {
  const { rows } = await query('SELECT * FROM receipt_templates WHERE id = $1 AND organization_id = $2', [id, orgId]);
  if (!rows.length) throw new HttpError(404, 'Receipt template not found');
  return { ...rows[0], template: normalizeTemplate(rows[0].template) };
}

function validated(body) {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Template name is required');
  for (const key of ['logo', 'signatureImage']) {
    const problem = imageProblem(body.template?.[key]);
    if (problem) throw new HttpError(400, problem);
  }
  return { name, template: JSON.stringify(normalizeTemplate(body.template)) };
}

r.get('/', ah(async (req, res) => {
  await ensureDefault(req.orgId);
  const { rows } = await query(
    'SELECT id, name, is_default, template, updated_at FROM receipt_templates WHERE organization_id = $1 ORDER BY is_default DESC, name',
    [req.orgId],
  );
  res.json(rows.map((t) => ({ ...t, template: normalizeTemplate(t.template) })));
}));

r.get('/meta', (req, res) => res.json({ defaultTemplate: DEFAULT_TEMPLATE, mergeFields: MERGE_FIELDS, fonts: FONTS, dateFormats: DATE_FORMATS }));

r.get('/:id', ah(async (req, res) => res.json(await loadTemplate(req.orgId, Number(req.params.id)))));

r.post('/', requireOrgAdmin, ah(async (req, res) => {
  const v = validated(req.body);
  const { rows } = await query('INSERT INTO receipt_templates (organization_id, name, template) VALUES ($1,$2,$3) RETURNING *', [req.orgId, v.name, v.template]);
  res.status(201).json(rows[0]);
}));

r.put('/:id', requireOrgAdmin, ah(async (req, res) => {
  const t = await loadTemplate(req.orgId, Number(req.params.id));
  const v = validated(req.body);
  const { rows } = await query('UPDATE receipt_templates SET name=$1, template=$2, updated_at=now() WHERE id=$3 RETURNING *', [v.name, v.template, t.id]);
  res.json({ ...rows[0], template: normalizeTemplate(rows[0].template) });
}));

r.post('/:id/default', requireOrgAdmin, ah(async (req, res) => {
  const t = await loadTemplate(req.orgId, Number(req.params.id));
  await withTransaction(async (db) => {
    await db.query('UPDATE receipt_templates SET is_default = false WHERE organization_id = $1 AND is_default', [req.orgId]);
    await db.query('UPDATE receipt_templates SET is_default = true WHERE id = $1', [t.id]);
  });
  res.json({ ok: true });
}));

r.delete('/:id', requireOrgAdmin, ah(async (req, res) => {
  const t = await loadTemplate(req.orgId, Number(req.params.id));
  if (t.is_default) throw new HttpError(400, 'Make another template the default before deleting this one');
  await query('DELETE FROM receipt_templates WHERE id = $1 AND organization_id = $2', [t.id, req.orgId]);
  res.json({ ok: true });
}));

export default r;
