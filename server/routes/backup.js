import { Router } from 'express';
import { pool, query, withTransaction } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin, requireSystemAdmin } from '../auth.js';
import { HttpError, ah } from '../util.js';
import { createBackup, inspectBackup, restoreBackup } from '../services/backup.js';

const r = Router();
r.use(requireAuth);

const fileData = (body) => {
  const data = typeof body?.data === 'string' ? Buffer.from(body.data, 'base64') : null;
  if (!data?.length) throw new HttpError(400, 'Choose a backup file');
  return data;
};
const who = (req) => req.user.display_name || req.user.username;

/** Download the current organization's backup: an Excel workbook, or a .zip with its attachments too (?attachments=1). */
r.get('/', requireOrg, requireOrgAdmin, ah(async (req, res) => {
  const client = await pool.connect();
  let file;
  try {
    // One consistent snapshot of every sheet, even while others keep working.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    file = await createBackup(client, req.orgId, { withFiles: req.query.attachments === '1', userName: who(req) });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log(`Backup of organization ${req.orgId} downloaded by user ${req.user.id} (${file.data.length} bytes)`);
  res.set('Content-Type', file.contentType);
  res.set('Content-Disposition', `attachment; filename="${file.fileName.replace(/"/g, '')}"`);
  res.send(file.data);
}));

/** What a backup file holds, before restoring it (system administrators, or an organization administrator). */
r.post('/inspect', ah(async (req, res, next) => {
  if (!req.user.is_system_admin) {
    const { rows } = await query('SELECT role FROM user_organizations WHERE user_id = $1 AND organization_id = $2', [req.user.id, req.session.orgId ?? 0]);
    if (rows[0]?.role !== 'admin') throw new HttpError(403, 'Organization administrator access required');
  }
  res.json(await inspectBackup({ query }, fileData(req.body)));
}));

/** Restore a backup as a new organization (system administrators). */
r.post('/restore-new', requireSystemAdmin, ah(async (req, res) => {
  const data = fileData(req.body);
  const result = await withTransaction((db) => restoreBackup(db, data, { mode: 'new', name: String(req.body.name || '').trim() || null, userId: req.user.id }));
  console.log(`Backup restored as new organization ${result.organizationId} by user ${req.user.id}`);
  res.status(201).json(result);
}));

/** Replace everything in the current organization with a backup (organization administrators, name typed to confirm). */
r.post('/restore', requireOrg, requireOrgAdmin, ah(async (req, res) => {
  const data = fileData(req.body);
  const result = await withTransaction(async (db) => {
    const { rows: [org] } = await db.query('SELECT name FROM organizations WHERE id = $1', [req.orgId]);
    if (String(req.body.confirmName ?? '').trim().toLowerCase() !== org.name.trim().toLowerCase()) {
      throw new HttpError(400, `Type the organization's name (${org.name}) to confirm`);
    }
    return restoreBackup(db, data, { mode: 'replace', orgId: req.orgId, userId: req.user.id });
  });
  console.log(`Backup restored over organization ${req.orgId} by user ${req.user.id}`);
  res.json(result);
}));

export default r;
