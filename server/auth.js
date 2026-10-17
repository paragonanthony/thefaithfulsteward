import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { HttpError } from './util.js';

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
}

const USER_COLUMNS = 'id, username, display_name, email, is_system_admin, is_active, must_change_password, api_access';
export const API_ACCESS_OFF = 'API and MCP access is turned off for this user. An organization administrator can turn it on under User Setup.';

/**
 * API / MCP sign-in: "Authorization: Bearer <access token>" (see server/oauth.js). The token acts as its user, so the
 * same checks as a web sign-in apply. Returns the token row, or null when the request has no bearer token.
 */
async function bearerToken(req) {
  const h = req.get('authorization');
  if (!h || !/^Bearer\s+/i.test(h)) return null;
  const hash = crypto.createHash('sha256').update(h.replace(/^Bearer\s+/i, '').trim()).digest('hex');
  const { rows: [t] } = await query(
    `SELECT id, user_id, client_id, grant_id, last_used_at FROM oauth_tokens
      WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()`, [hash]);
  if (!t) throw Object.assign(new HttpError(401, 'The access token is invalid or has expired'), { code: 'invalid_token' });
  if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > 60000) {
    query('UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1', [t.id]).catch(() => {});
  }
  return t;
}

export async function requireAuth(req, res, next) {
  try {
    const token = await bearerToken(req);
    if (token) {
      const { rows: [user] } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [token.user_id]);
      if (!user || !user.is_active) throw Object.assign(new HttpError(401, 'This user can no longer sign in'), { code: 'invalid_token' });
      if (!user.api_access) throw Object.assign(new HttpError(403, API_ACCESS_OFF), { code: 'api_access_disabled' });
      if (user.must_change_password) {
        throw Object.assign(new HttpError(403, 'You need to choose a new password in the app before continuing.'), { code: 'password_change_required' });
      }
      req.user = user;
      req.tokenAuth = token;
      return next();
    }
    if (!req.session.userId) throw new HttpError(401, 'Not signed in');
    const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.session.userId]);
    const user = rows[0];
    if (!user || !user.is_active) {
      req.session.destroy(() => {});
      throw new HttpError(401, 'Not signed in');
    }
    // Until a required password change is done, only the sign-in endpoints (who am I, change password, sign out) work.
    if (user.must_change_password && req.baseUrl !== '/api/auth') {
      throw Object.assign(new HttpError(403, 'You need to choose a new password before continuing.'), { code: 'password_change_required' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Requires a selected organization the user is assigned to. Sets req.orgId / req.orgRole. */
export async function requireOrg(req, res, next) {
  try {
    let orgId = req.session.orgId;
    if (req.tokenAuth) {
      // API / MCP: the organization comes with each request (X-Organization-Id), or is the user's only one.
      orgId = await tokenOrg(req);
    }
    if (!orgId) throw new HttpError(409, 'No organization selected');
    const { rows } = await query('SELECT role FROM user_organizations WHERE user_id = $1 AND organization_id = $2', [req.user.id, orgId]);
    if (!rows.length) {
      if (!req.tokenAuth) delete req.session.orgId;
      throw new HttpError(403, 'You do not have access to this organization');
    }
    req.orgId = orgId;
    req.orgRole = rows[0].role;
    next();
  } catch (err) {
    next(err);
  }
}

/** The organization an API / MCP request is for. */
export async function tokenOrg(req) {
  const given = req.get('x-organization-id') ?? req.query.organizationId;
  if (given !== undefined && given !== '') {
    const id = Number(given);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'X-Organization-Id must be an organization id');
    return id;
  }
  const { rows } = await query('SELECT organization_id FROM user_organizations WHERE user_id = $1', [req.user.id]);
  if (rows.length === 1) return rows[0].organization_id;
  throw new HttpError(409, rows.length
    ? 'Choose an organization: send its id in the X-Organization-Id header (GET /api/auth/me lists them)'
    : 'You are not assigned to any organization');
}

export function requireOrgAdmin(req, res, next) {
  if (req.orgRole !== 'admin' && !req.user.is_system_admin) return next(new HttpError(403, 'Organization administrator access required'));
  next();
}

export function requireSystemAdmin(req, res, next) {
  if (!req.user.is_system_admin) return next(new HttpError(403, 'System administrator access required'));
  next();
}
