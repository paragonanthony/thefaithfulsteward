import { Router } from 'express';
import { revokeUserTokens } from '../oauth.js';
import { query, withTransaction } from '../db.js';
import { hashPassword, requireAuth, requireOrg, requireOrgAdmin, requireSystemAdmin, validatePassword } from '../auth.js';
import { HttpError, ah } from '../util.js';
import { setupOrganization } from '../services/orgSetup.js';

const r = Router();
r.use(requireAuth);

// ----- Organizations (system administrators) -----
r.get('/organizations', requireSystemAdmin, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, (SELECT COUNT(*)::int FROM user_organizations uo WHERE uo.organization_id = o.id) AS user_count
       FROM organizations o ORDER BY o.name`,
  );
  res.json(rows);
}));

r.post('/organizations', requireSystemAdmin, ah(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Organization name is required');
  const fy = Number(req.body.fiscalYearStartMonth || 1);
  if (!(fy >= 1 && fy <= 12)) throw new HttpError(400, 'Fiscal year start month must be 1-12');
  const org = await withTransaction(async (db) => {
    const { rows } = await db.query('INSERT INTO organizations (name, fiscal_year_start_month) VALUES ($1,$2) RETURNING *', [name, fy]);
    await db.query(`INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1,$2,'admin')`, [req.user.id, rows[0].id]);
    await setupOrganization(db, rows[0].id, { defaultChart: req.body.defaultChart !== false, userId: req.user.id });
    return rows[0];
  });
  res.status(201).json(org);
}));

/** What deleting an organization would remove (for the confirmation). */
async function orgFootprint(db, orgId) {
  const { rows: [org] } = await db.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
  if (!org) throw new HttpError(404, 'Organization not found');
  const count = async (sql) => (await db.query(sql, [orgId])).rows[0].n;
  const { rows: onlyHere } = await db.query(
    `SELECT u.id, u.username, u.display_name FROM users u JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = $1
      WHERE NOT u.is_system_admin AND NOT EXISTS (SELECT 1 FROM user_organizations o WHERE o.user_id = u.id AND o.organization_id <> $1)
      ORDER BY u.display_name`, [orgId]);
  return {
    id: org.id, name: org.name,
    counts: {
      transactions: await count('SELECT COUNT(*)::int AS n FROM transactions WHERE organization_id = $1'),
      accounts: await count('SELECT COUNT(*)::int AS n FROM accounts WHERE organization_id = $1'),
      companies: await count('SELECT COUNT(*)::int AS n FROM companies WHERE organization_id = $1'),
      attachments: await count('SELECT COUNT(*)::int AS n FROM attachments WHERE organization_id = $1'),
      bankFeedLines: await count('SELECT COUNT(*)::int AS n FROM bank_feed_items WHERE organization_id = $1'),
      users: await count('SELECT COUNT(*)::int AS n FROM user_organizations WHERE organization_id = $1'),
    },
    usersOnlyHere: onlyHere,
  };
}

r.get('/organizations/:id/delete-preview', requireSystemAdmin, ah(async (req, res) => {
  res.json(await orgFootprint({ query }, Number(req.params.id)));
}));

/**
 * Delete an organization and everything in it (transactions, general ledger, accounts, names, attachments, bank
 * feeds and connections, settings, reports...), in one transaction. The name must be typed to confirm. User accounts
 * that belonged only to this organization are deleted too unless keepUsers is set (one that's still referenced
 * elsewhere is deactivated instead). Users in other organizations keep their accounts.
 */
r.delete('/organizations/:id', requireSystemAdmin, ah(async (req, res) => {
  const orgId = Number(req.params.id);
  const result = await withTransaction(async (db) => {
    const fp = await orgFootprint(db, orgId);
    if (String(req.body?.confirmName ?? '').trim().toLowerCase() !== fp.name.trim().toLowerCase()) {
      throw new HttpError(400, `Type the organization's name (${fp.name}) to confirm`);
    }
    // Lets the period-closing and reconciliation checks stand aside for this organization only (see migration 031).
    await db.query(`SELECT set_config('app.deleting_organization', $1, true)`, [String(orgId)]);
    // Records that point at each other (ledger lines -> accounts, lines -> transactions, transactions -> names...) go
    // first, in order; everything else cascades from the organization.
    await db.query('DELETE FROM bank_feed_items WHERE organization_id = $1', [orgId]);
    await db.query('DELETE FROM gl_headers WHERE organization_id = $1', [orgId]); // and their lines
    await db.query('DELETE FROM transaction_details d USING transactions t WHERE t.id = d.transaction_id AND t.organization_id = $1', [orgId]);
    await db.query('UPDATE transactions SET reconciliation_id = NULL WHERE organization_id = $1 AND reconciliation_id IS NOT NULL', [orgId]);
    await db.query('DELETE FROM transactions WHERE organization_id = $1', [orgId]); // and reconciliations, attachments on them
    await db.query('DELETE FROM tuition_records WHERE organization_id = $1', [orgId]);
    await db.query('DELETE FROM budgets WHERE organization_id = $1', [orgId]);
    await db.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    let deletedUsers = 0;
    let deactivatedUsers = 0;
    if (!req.body?.keepUsers) {
      for (const u of fp.usersOnlyHere) {
        if (u.id === req.user.id) continue;
        await db.query('SAVEPOINT del_user');
        try {
          await db.query('DELETE FROM users WHERE id = $1', [u.id]);
          await db.query('RELEASE SAVEPOINT del_user');
          deletedUsers += 1;
        } catch {
          // Still named on records elsewhere (e.g. as who created something): keep the account but switch it off.
          await db.query('ROLLBACK TO SAVEPOINT del_user');
          await db.query('UPDATE users SET is_active = false WHERE id = $1', [u.id]);
          deactivatedUsers += 1;
        }
      }
    }
    return { deleted: fp.name, counts: fp.counts, deletedUsers, deactivatedUsers };
  });
  // Anyone who had it open is asked to choose another organization on their next request.
  res.json(result);
}));

r.put('/organizations/:id', requireSystemAdmin, ah(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Organization name is required');
  const { rows } = await query('UPDATE organizations SET name = $1 WHERE id = $2 RETURNING *', [name, Number(req.params.id)]);
  if (!rows.length) throw new HttpError(404, 'Organization not found');
  res.json(rows[0]);
}));

// ----- Users in the current organization (organization administrators) -----
r.use('/users', requireOrg, requireOrgAdmin);

r.get('/users', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.email, u.is_active, u.is_system_admin, u.must_change_password, u.api_access, u.password_changed_at, uo.role
       FROM users u JOIN user_organizations uo ON uo.user_id = u.id
      WHERE uo.organization_id = $1 ORDER BY u.display_name`,
    [req.orgId],
  );
  res.json(rows);
}));

/**
 * An org admin may only change credentials/status for users whose every organization is one the
 * admin also administers; otherwise they could take over an account used by another tenant.
 */
async function assertCanManageAccount(req, userId) {
  if (req.user.is_system_admin) return;
  const { rows } = await query(
    `SELECT uo.organization_id FROM user_organizations uo
      WHERE uo.user_id = $1 AND NOT EXISTS (
        SELECT 1 FROM user_organizations mine
         WHERE mine.user_id = $2 AND mine.organization_id = uo.organization_id AND mine.role = 'admin')`,
    [userId, req.user.id],
  );
  const { rows: target } = await query('SELECT is_system_admin FROM users WHERE id = $1', [userId]);
  if (rows.length || target[0]?.is_system_admin) throw new HttpError(403, 'This user also belongs to other organizations; ask a system administrator to change their account.');
}

r.post('/users', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!username) throw new HttpError(400, 'User name is required');
  const user = await withTransaction(async (db) => {
    const { rows: existing } = await db.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    let userId = existing[0]?.id;
    if (!userId) {
      const displayName = String(req.body.displayName || '').trim() || username;
      validatePassword(req.body.password);
      const { rows } = await db.query(
        'INSERT INTO users (username, password_hash, display_name, email, is_system_admin, must_change_password, api_access) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [username, await hashPassword(req.body.password), displayName, req.body.email || null, Boolean(req.user.is_system_admin && req.body.isSystemAdmin), Boolean(req.body.mustChangePassword), req.body.apiAccess === true],
      );
      userId = rows[0].id;
    }
    await db.query(
      `INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, req.orgId, role],
    );
    return { id: userId, existing: Boolean(existing.length) };
  });
  res.status(201).json(user);
}));

r.put('/users/:id', ah(async (req, res) => {
  const userId = Number(req.params.id);
  const { rows: member } = await query('SELECT 1 FROM user_organizations WHERE user_id = $1 AND organization_id = $2', [userId, req.orgId]);
  if (!member.length) throw new HttpError(404, 'User not found in this organization');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (userId === req.user.id && role !== 'admin' && !req.user.is_system_admin) throw new HttpError(400, 'You cannot remove your own administrator role');
  await query('UPDATE user_organizations SET role = $1 WHERE user_id = $2 AND organization_id = $3', [role, userId, req.orgId]);
  const { rows: current } = await query('SELECT display_name, email, is_active, is_system_admin, must_change_password, api_access FROM users WHERE id = $1', [userId]);
  const c = current[0];
  const displayName = String(req.body.displayName ?? c.display_name).trim() || c.display_name;
  const email = req.body.email ?? c.email;
  const isActive = req.body.isActive === undefined ? c.is_active : Boolean(req.body.isActive);
  const isSysAdmin = req.user.is_system_admin && req.body.isSystemAdmin !== undefined ? Boolean(req.body.isSystemAdmin) : c.is_system_admin;
  const mustChange = req.body.mustChangePassword === undefined ? c.must_change_password : Boolean(req.body.mustChangePassword);
  const apiAccess = req.body.apiAccess === undefined ? c.api_access : Boolean(req.body.apiAccess);
  if (displayName !== c.display_name || email !== c.email || isActive !== c.is_active || isSysAdmin !== c.is_system_admin || mustChange !== c.must_change_password || apiAccess !== c.api_access) {
    await assertCanManageAccount(req, userId);
    if (userId === req.user.id && !isActive) throw new HttpError(400, 'You cannot deactivate your own account');
    await query('UPDATE users SET display_name=$1, email=$2, is_active=$3, is_system_admin=$4, must_change_password=$5, api_access=$6 WHERE id=$7', [displayName, email || null, isActive, isSysAdmin, mustChange, apiAccess, userId]);
    // Turning API / MCP access off ends the user's existing API and MCP sign-ins straight away.
    if (c.api_access && !apiAccess) await revokeUserTokens(userId);
  }
  res.json({ ok: true });
}));

r.post('/users/:id/reset-password', ah(async (req, res) => {
  const userId = Number(req.params.id);
  const { rows: member } = await query('SELECT 1 FROM user_organizations WHERE user_id = $1 AND organization_id = $2', [userId, req.orgId]);
  if (!member.length) throw new HttpError(404, 'User not found in this organization');
  await assertCanManageAccount(req, userId);
  validatePassword(req.body.password);
  await query('UPDATE users SET password_hash = $1, must_change_password = $2 WHERE id = $3', [await hashPassword(req.body.password), Boolean(req.body.mustChangePassword), userId]);
  await query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1`, [userId]);
  await revokeUserTokens(userId); // and their API / MCP sign-ins
  res.json({ ok: true });
}));

r.delete('/users/:id', ah(async (req, res) => {
  const userId = Number(req.params.id);
  if (userId === req.user.id) throw new HttpError(400, 'You cannot remove yourself from the organization');
  await query('DELETE FROM user_organizations WHERE user_id = $1 AND organization_id = $2', [userId, req.orgId]);
  res.json({ ok: true });
}));

export default r;
