import { Router } from 'express';
import { query } from '../db.js';
import { checkPassword, hashPassword, requireAuth, tokenOrg, validatePassword } from '../auth.js';
import { revokeUserTokens } from '../oauth.js';
import { HttpError, ah } from '../util.js';

const r = Router();

// Simple in-memory throttle for failed logins (per username + IP).
const failures = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;

async function userOrgs(userId) {
  const { rows } = await query(
    `SELECT o.id, o.name, uo.role, o.fiscal_year_start_month, o.tuition_enabled, o.period_closing_date
       FROM user_organizations uo JOIN organizations o ON o.id = uo.organization_id
      WHERE uo.user_id = $1 ORDER BY o.name`,
    [userId],
  );
  return rows;
}

r.post('/login', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const key = `${username.toLowerCase()}|${req.ip}`;
  const f = failures.get(key);
  if (f && f.count >= LOCK_AFTER && Date.now() - f.at < LOCK_MS) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const user = rows[0];
  if (!user || !user.is_active || !(await checkPassword(password, user.password_hash))) {
    failures.set(key, { count: (f && Date.now() - f.at < LOCK_MS ? f.count : 0) + 1, at: Date.now() });
    throw new HttpError(401, 'Invalid user name or password');
  }
  failures.delete(key);
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  const orgs = await userOrgs(user.id);
  if (orgs.length === 1) req.session.orgId = orgs[0].id; // auto-select the only organization
  res.json({ ok: true, mustChangePassword: user.must_change_password });
}));

r.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('npacct.sid');
    res.json({ ok: true });
  });
});

r.get('/me', requireAuth, ah(async (req, res) => {
  const orgs = await userOrgs(req.user.id);
  let current;
  if (req.tokenAuth) {
    const id = await tokenOrg(req).catch(() => null);
    current = orgs.find((o) => o.id === id) || null;
  } else {
    current = orgs.find((o) => o.id === req.session.orgId) || null;
    if (!current && req.session.orgId) delete req.session.orgId;
  }
  res.json({ user: req.user, organizations: orgs, currentOrganization: current });
}));

r.post('/select-org', requireAuth, ah(async (req, res) => {
  const orgId = Number(req.body.organizationId);
  const orgs = await userOrgs(req.user.id);
  const org = orgs.find((o) => o.id === orgId);
  if (!org) throw new HttpError(403, 'You are not assigned to that organization');
  req.session.orgId = org.id;
  res.json({ currentOrganization: org });
}));

r.post('/change-password', requireAuth, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await checkPassword(String(currentPassword || ''), rows[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
  validatePassword(newPassword);
  if (await checkPassword(String(newPassword), rows[0].password_hash)) throw new HttpError(400, 'Choose a new password that is different from the current one');
  await query('UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = now() WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
  // Sign out the user's other sessions (other browsers / devices) and apps; this one stays signed in.
  await query(`DELETE FROM "session" WHERE (sess->>'userId')::int = $1 AND sid <> $2`, [req.user.id, req.sessionID]);
  await revokeUserTokens(req.user.id, { exceptGrant: req.tokenAuth?.grant_id ?? null });
  res.json({ ok: true });
}));

export default r;
