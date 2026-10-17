import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin } from '../auth.js';
import { HttpError, ah } from '../util.js';
import {
  BLANK_STOCK_PRESET, CHECK_FIELDS, CHECK_POSITIONS, DATE_FORMATS, DEFAULT_LAYOUT, FONTS, normalizeLayout,
} from '../services/checkFormats.js';

const r = Router();
r.use(requireAuth, requireOrg);

/** Every organization starts with one standard format, created the first time formats are listed. */
async function ensureDefault(orgId) {
  await query(
    `INSERT INTO check_formats (organization_id, name, layout, is_default)
     SELECT $1, 'Standard voucher check', $2, true
      WHERE NOT EXISTS (SELECT 1 FROM check_formats WHERE organization_id = $1)
     ON CONFLICT DO NOTHING`,
    [orgId, JSON.stringify(DEFAULT_LAYOUT)],
  );
}

async function loadFormat(orgId, id) {
  const { rows } = await query('SELECT * FROM check_formats WHERE id = $1 AND organization_id = $2', [id, orgId]);
  if (!rows.length) throw new HttpError(404, 'Check format not found');
  return { ...rows[0], layout: normalizeLayout(rows[0].layout) };
}

r.get('/', ah(async (req, res) => {
  await ensureDefault(req.orgId);
  const { rows } = await query(
    `SELECT f.id, f.name, f.is_default, f.layout, f.updated_at,
            COALESCE((SELECT json_agg(a.name ORDER BY a.name) FROM accounts a WHERE a.check_format_id = f.id), '[]') AS accounts
       FROM check_formats f WHERE f.organization_id = $1 ORDER BY f.is_default DESC, f.name`,
    [req.orgId],
  );
  res.json(rows.map((f) => ({ ...f, layout: normalizeLayout(f.layout) })));
}));

/** Field catalog, defaults and option lists for the editor. */
r.get('/meta', (req, res) => {
  res.json({ fields: CHECK_FIELDS, defaultLayout: DEFAULT_LAYOUT, blankStockPreset: BLANK_STOCK_PRESET, dateFormats: DATE_FORMATS, fonts: FONTS, positions: CHECK_POSITIONS });
});

r.get('/:id', ah(async (req, res) => res.json(await loadFormat(req.orgId, Number(req.params.id)))));

const cleanName = (n) => {
  const name = String(n || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'Format name is required');
  return name;
};

r.post('/', requireOrgAdmin, ah(async (req, res) => {
  const { rows } = await query(
    'INSERT INTO check_formats (organization_id, name, layout) VALUES ($1,$2,$3) RETURNING *',
    [req.orgId, cleanName(req.body.name), JSON.stringify(normalizeLayout(req.body.layout))],
  );
  res.status(201).json(rows[0]);
}));

r.put('/:id', requireOrgAdmin, ah(async (req, res) => {
  const f = await loadFormat(req.orgId, Number(req.params.id));
  const { rows } = await query(
    'UPDATE check_formats SET name=$1, layout=$2, updated_at=now() WHERE id=$3 RETURNING *',
    [cleanName(req.body.name), JSON.stringify(normalizeLayout(req.body.layout)), f.id],
  );
  res.json({ ...rows[0], layout: normalizeLayout(rows[0].layout) });
}));

r.post('/:id/default', requireOrgAdmin, ah(async (req, res) => {
  const f = await loadFormat(req.orgId, Number(req.params.id));
  await withTransaction(async (db) => {
    await db.query('UPDATE check_formats SET is_default = false WHERE organization_id = $1 AND is_default', [req.orgId]);
    await db.query('UPDATE check_formats SET is_default = true WHERE id = $1', [f.id]);
  });
  res.json({ ok: true });
}));

r.delete('/:id', requireOrgAdmin, ah(async (req, res) => {
  const f = await loadFormat(req.orgId, Number(req.params.id));
  if (f.is_default) throw new HttpError(400, 'Make another format the default before deleting this one');
  await query('DELETE FROM check_formats WHERE id = $1 AND organization_id = $2', [f.id, req.orgId]);
  res.json({ ok: true });
}));

export default r;
