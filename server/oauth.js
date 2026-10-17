// Sign-in for the API and the MCP server: OAuth 2.1 (authorization code + PKCE, refresh tokens) with the user's
// normal user name and password. A token acts as its user, with the same organizations, roles and permissions as
// their web sign-in (requireAuth / requireOrg check it on every request). Scripts can also exchange a user name and
// password for tokens directly (grant_type=password). Codes and tokens are stored only as SHA-256 hashes.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { query } from './db.js';
import { API_ACCESS_OFF, checkPassword, requireAuth } from './auth.js';
import { HttpError, ah } from './util.js';

export const ACCESS_TTL = 60 * 60; // 1 hour
export const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL = 10 * 60;
const APP_NAME = 'The Faithful Steward';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** The app's public address (PUBLIC_URL, else the address the request came in on). */
export const publicBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

class OAuthError extends Error {
  constructor(status, error, description) { super(description); this.status = status; this.error = error; }
}
const oauthErrors = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof OAuthError) return res.status(err.status).json({ error: err.error, error_description: err.message });
    if (err instanceof HttpError) return res.status(err.status).json({ error: 'invalid_request', error_description: err.message });
    console.error('OAuth error:', err);
    return res.status(500).json({ error: 'server_error', error_description: 'Something went wrong' });
  }
};

// Redirect URIs: https anywhere, http only on this computer (native apps), or an app's own scheme.
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:']);
function validRedirectUri(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return !BLOCKED_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

async function loadClient(clientId) {
  const { rows } = await query('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1', [String(clientId || '')]);
  return rows[0] || null;
}

/** Validate an authorization request's app and redirect address (never redirect to an unregistered address). */
async function checkAuthorizeRequest(p) {
  const client = await loadClient(p.client_id);
  if (!client || client.client_id === 'api') throw new HttpError(400, 'Unknown app (client_id). Ask the app to connect again.');
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) throw new HttpError(400, 'This app’s return address (redirect_uri) isn’t registered.');
  return client;
}
function redirectWith(uri, params) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  return url.toString();
}

/** Issue an access token and a refresh token for a grant. */
async function issueTokens(clientId, userId, grantId = random(16)) {
  const access = random(32);
  const refresh = random(32);
  await query(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, user_id, expires_at) VALUES
       ($1, 'access', $3, $4, $5, now() + make_interval(secs => $6)), ($2, 'refresh', $3, $4, $5, now() + make_interval(secs => $7))`,
    [sha256(access), sha256(refresh), grantId, clientId, userId, ACCESS_TTL, REFRESH_TTL]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'all' };
}

/** End a user's API / MCP access (all apps, or one app, optionally keeping one grant). */
export async function revokeUserTokens(userId, { clientId = null, exceptGrant = null } = {}) {
  await query(
    `UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL
       AND ($2::text IS NULL OR client_id = $2) AND ($3::text IS NULL OR grant_id <> $3)`, [userId, clientId, exceptGrant]);
}

// Failed password sign-ins through the token endpoint, per user name + address (like the web sign-in).
const failures = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;

async function activeUser(id) {
  const { rows: [u] } = await query('SELECT id, is_active, must_change_password, api_access FROM users WHERE id = $1', [id]);
  if (!u || !u.is_active) throw new OAuthError(400, 'invalid_grant', 'This user can no longer sign in');
  if (!u.api_access) throw new OAuthError(400, 'access_denied', API_ACCESS_OFF);
  if (u.must_change_password) throw new OAuthError(400, 'invalid_grant', 'This user must choose a new password in the app before signing in');
  return u;
}

// ---------------------------------------------------------------------------
// Public endpoints (no session): discovery, registration, authorize, token, revoke
// ---------------------------------------------------------------------------
export const oauthRoutes = Router();

// Token-based endpoints may be called from other sites (they use tokens, never cookies).
oauthRoutes.use(['/.well-known', '/oauth/register', '/oauth/token', '/oauth/revoke'], (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const resourceMetadata = (req) => ({
  resource: `${publicBase(req)}/mcp`,
  authorization_servers: [publicBase(req)],
  bearer_methods_supported: ['header'],
  resource_name: APP_NAME,
});
oauthRoutes.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => res.json(resourceMetadata(req)));

const serverMetadata = (req) => {
  const base = publicBase(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'password'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['all'],
    service_documentation: `${base}/account`,
  };
};
oauthRoutes.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => res.json(serverMetadata(req)));

/** Dynamic client registration (RFC 7591): MCP clients register their name and return addresses. */
oauthRoutes.post('/oauth/register', express.json({ limit: '20kb' }), oauthErrors(async (req, res) => {
  const b = req.body || {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    throw new OAuthError(400, 'invalid_redirect_uri', 'Give 1 to 10 redirect_uris: https, http on localhost, or an app scheme');
  }
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') {
    throw new OAuthError(400, 'invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none", with PKCE)');
  }
  const name = String(b.client_name || 'MCP client').trim().slice(0, 100) || 'MCP client';
  const clientId = random(18);
  await query('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)', [clientId, name, uris]);
  res.status(201).json({
    client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
}));

/** Authorization: checks the request, then shows the app's sign-in / approval screen. */
oauthRoutes.get('/oauth/authorize', ah(async (req, res) => {
  const p = req.query;
  let client;
  try { client = await checkAuthorizeRequest(p); } catch (err) {
    return res.status(400).type('text').send(`${APP_NAME}: ${err.message}`);
  }
  const fail = (error, description) => res.redirect(redirectWith(p.redirect_uri, { error, error_description: description, state: p.state }));
  if (p.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
  if (!p.code_challenge || (p.code_challenge_method || 'plain') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  const qs = new URLSearchParams({ client_id: client.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, state: p.state || '', resource: p.resource || '' });
  res.redirect(`/connect-app?${qs}`);
}));

/** Token endpoint: authorization_code, refresh_token, password. */
oauthRoutes.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), oauthErrors(async (req, res) => {
  const b = req.body || {};
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  if (b.grant_type === 'authorization_code') {
    const { rows: [code] } = await query('SELECT * FROM oauth_codes WHERE code_hash = $1', [sha256(b.code || '')]);
    if (!code || code.used_at || new Date(code.expires_at) < new Date()) throw new OAuthError(400, 'invalid_grant', 'The authorization code is invalid or expired');
    await query('UPDATE oauth_codes SET used_at = now() WHERE id = $1', [code.id]);
    if (b.client_id && b.client_id !== code.client_id) throw new OAuthError(400, 'invalid_grant', 'The code was issued to another app');
    if (b.redirect_uri !== code.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri doesn’t match the authorization request');
    const verifier = String(b.code_verifier || '');
    if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== code.code_challenge) {
      throw new OAuthError(400, 'invalid_grant', 'The PKCE code_verifier doesn’t match');
    }
    await activeUser(code.user_id);
    return res.json(await issueTokens(code.client_id, code.user_id));
  }
  if (b.grant_type === 'refresh_token') {
    const { rows: [t] } = await query(`SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`, [sha256(b.refresh_token || '')]);
    if (!t) throw new OAuthError(400, 'invalid_grant', 'The refresh token is invalid');
    if (b.client_id && b.client_id !== t.client_id) throw new OAuthError(400, 'invalid_grant', 'The refresh token was issued to another app');
    if (t.revoked_at) {
      // A refresh token used twice may have been stolen: end the whole sign-in.
      await query('UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL', [t.grant_id]);
      throw new OAuthError(400, 'invalid_grant', 'The refresh token was already used; sign in again');
    }
    if (new Date(t.expires_at) < new Date()) throw new OAuthError(400, 'invalid_grant', 'The refresh token has expired; sign in again');
    await activeUser(t.user_id);
    // Replace it: the old refresh token (and the access tokens issued with it) stop working.
    await query(`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL`, [t.grant_id]);
    return res.json(await issueTokens(t.client_id, t.user_id, t.grant_id));
  }
  if (b.grant_type === 'password') {
    const username = String(b.username || '').trim();
    const key = `${username.toLowerCase()}|${req.ip}`;
    const f = failures.get(key);
    if (f && f.count >= LOCK_AFTER && Date.now() - f.at < LOCK_MS) throw new OAuthError(429, 'invalid_grant', 'Too many failed attempts. Try again in a few minutes.');
    const { rows: [u] } = await query('SELECT id, password_hash, is_active FROM users WHERE lower(username) = lower($1)', [username]);
    if (!u || !u.is_active || !(await checkPassword(String(b.password || ''), u.password_hash))) {
      failures.set(key, { count: (f && Date.now() - f.at < LOCK_MS ? f.count : 0) + 1, at: Date.now() });
      throw new OAuthError(400, 'invalid_grant', 'Invalid user name or password');
    }
    failures.delete(key);
    await activeUser(u.id);
    return res.json(await issueTokens('api', u.id));
  }
  throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code, refresh_token or password');
}));

/** Revocation (RFC 7009): ends the sign-in the token belongs to. Always succeeds. */
oauthRoutes.post('/oauth/revoke', express.urlencoded({ extended: false }), express.json(), oauthErrors(async (req, res) => {
  const { rows: [t] } = await query('SELECT grant_id FROM oauth_tokens WHERE token_hash = $1', [sha256(req.body?.token || '')]);
  if (t) await query('UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL', [t.grant_id]);
  res.status(200).json({});
}));

// ---------------------------------------------------------------------------
// Signed-in endpoints (the approval screen and Connected apps)
// ---------------------------------------------------------------------------
export const oauthAccountRoutes = Router();
oauthAccountRoutes.use(requireAuth);
// Approving an app needs the web sign-in, not a token.
const webOnly = (req, res, next) => {
  if (req.tokenAuth) return next(new HttpError(403, 'Approve apps from the web app'));
  if (!req.user.api_access) return next(new HttpError(403, API_ACCESS_OFF));
  next();
};

oauthAccountRoutes.get('/authorize-info', webOnly, ah(async (req, res) => {
  const client = await checkAuthorizeRequest(req.query);
  const { rows: orgs } = await query(
    `SELECT o.name, uo.role FROM user_organizations uo JOIN organizations o ON o.id = uo.organization_id WHERE uo.user_id = $1 ORDER BY o.name`, [req.user.id]);
  let host = '';
  try { host = new URL(req.query.redirect_uri).host || req.query.redirect_uri; } catch { /* ignore */ }
  res.json({ clientName: client.client_name, returnsTo: host, user: req.user.display_name || req.user.username, organizations: orgs });
}));

oauthAccountRoutes.post('/approve', webOnly, ah(async (req, res) => {
  const p = req.body || {};
  const client = await checkAuthorizeRequest(p);
  if (!p.code_challenge) throw new HttpError(400, 'Missing code_challenge');
  const code = random(32);
  await query(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [sha256(code), client.client_id, req.user.id, p.redirect_uri, String(p.code_challenge), p.resource || null, CODE_TTL]);
  res.json({ redirect: redirectWith(p.redirect_uri, { code, state: p.state }) });
}));

oauthAccountRoutes.post('/deny', webOnly, ah(async (req, res) => {
  const p = req.body || {};
  await checkAuthorizeRequest(p);
  res.json({ redirect: redirectWith(p.redirect_uri, { error: 'access_denied', error_description: 'The user declined', state: p.state }) });
}));

/** Apps the user has connected (with an unexpired sign-in). */
oauthAccountRoutes.get('/connections', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT c.client_id, c.client_name, MIN(t.created_at) AS connected_at, MAX(t.last_used_at) AS last_used_at
       FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.user_id = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > now()
      GROUP BY c.client_id, c.client_name ORDER BY MIN(t.created_at) DESC`, [req.user.id]);
  const { rows: used } = await query(
    `SELECT client_id, MAX(last_used_at) AS last_used_at FROM oauth_tokens WHERE user_id = $1 AND kind = 'access' GROUP BY client_id`, [req.user.id]);
  const lastUsed = Object.fromEntries(used.map((u) => [u.client_id, u.last_used_at]));
  res.json(rows.map((r) => ({ ...r, last_used_at: lastUsed[r.client_id] || r.last_used_at })));
}));

oauthAccountRoutes.delete('/connections/:clientId', ah(async (req, res) => {
  await revokeUserTokens(req.user.id, { clientId: String(req.params.clientId) });
  res.json({ ok: true });
}));
