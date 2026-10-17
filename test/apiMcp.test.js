// API and MCP access with the user's own sign-in (OAuth + PKCE, password grant), with the same permissions as the web.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer } from './helpers.js';

let app;
let root;
before(async () => { app = await startTestServer('npacct_test_api_mcp'); root = app.base.replace(/\/api$/, ''); });
after(async () => { await app?.stop(); });

const form = (path, params) => fetch(`${root}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const bearer = (token, path, { method = 'GET', body, org } = {}) => fetch(`${app.base}${path}`, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(org ? { 'X-Organization-Id': String(org) } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let rpcId = 0;
const mcp = (token, method, params = {}) => fetch(`${root}/mcp`, {
  method: 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
}).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const tool = async (token, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const c = r.body.result;
  return { isError: Boolean(c.isError), data: c.isError ? c.content[0].text : JSON.parse(c.content[0].text) };
};

test('API and MCP', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const orgA = await admin.post('/admin/organizations', { name: 'Org A' });
  const orgB = await admin.post('/admin/organizations', { name: 'Org B' });
  await admin.post('/auth/select-org', { organizationId: orgA.id });
  await admin.post('/admin/users', { username: 'pat', password: 'pat-password', displayName: 'Pat Bookkeeper', role: 'user', apiAccess: true });
  const pat = app.client();
  await pat.post('/auth/login', { username: 'pat', password: 'pat-password' });

  let client;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'https://client.example/callback';

  await t.test('discovery documents point MCP clients at the sign-in', async () => {
    const pr = await fetch(`${root}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
    assert.equal(pr.resource, `${root}/mcp`);
    assert.deepEqual(pr.authorization_servers, [root]);
    const as = await fetch(`${root}/.well-known/oauth-authorization-server`).then((r) => r.json());
    assert.deepEqual([as.authorization_endpoint, as.token_endpoint, as.registration_endpoint, as.code_challenge_methods_supported], [`${root}/oauth/authorize`, `${root}/oauth/token`, `${root}/oauth/register`, ['S256']]);
    const noToken = await mcp(null, 'tools/list');
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  await t.test('apps register, and only registered https / localhost return addresses are accepted', async () => {
    const bad = await fetch(`${root}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }) });
    assert.equal(bad.status, 400);
    const r = await fetch(`${root}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Assistant', redirect_uris: [redirect, 'http://localhost:7777/cb'] }) });
    assert.equal(r.status, 201);
    client = await r.json();
    assert.equal(client.token_endpoint_auth_method, 'none');
    const unknown = await fetch(`${root}/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`, { redirect: 'manual' });
    assert.equal(unknown.status, 400);
    const wrongUri = await fetch(`${root}/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: 'manual' });
    assert.equal(wrongUri.status, 400, 'never redirects to an unregistered address');
    const noPkce = await fetch(`${root}/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&state=s1`, { redirect: 'manual' });
    assert.match(noPkce.headers.get('location'), /^https:\/\/client\.example\/callback\?error=invalid_request.*state=s1/);
    const okR = await fetch(`${root}/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`, { redirect: 'manual' });
    assert.equal(okR.status, 302);
    assert.match(okR.headers.get('location'), /^\/connect-app\?client_id=/);
  });

  let tokens;
  await t.test('the user signs in to the web app and approves; the code is exchanged with PKCE', async () => {
    await assert.rejects(app.client().get(`/oauth/authorize-info?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}`), /Not signed in/);
    const info = await pat.get(`/oauth/authorize-info?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}`);
    assert.deepEqual([info.clientName, info.returnsTo, info.user, info.organizations.map((o) => o.name)], ['Test Assistant', 'client.example', 'Pat Bookkeeper', ['Org A']]);
    const denied = await pat.post('/oauth/deny', { client_id: client.client_id, redirect_uri: redirect, state: 'xyz' });
    assert.match(denied.redirect, /error=access_denied.*state=xyz/);
    const ap = await pat.post('/oauth/approve', { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, state: 'xyz' });
    const url = new URL(ap.redirect);
    assert.equal(url.searchParams.get('state'), 'xyz');
    const code = url.searchParams.get('code');
    const wrong = await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' });
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'invalid_grant']);
    const ap2 = await pat.post('/oauth/approve', { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, state: 'xyz' });
    const code2 = new URL(ap2.redirect).searchParams.get('code');
    const good = await form('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier });
    assert.equal(good.status, 200);
    tokens = good.body;
    assert.deepEqual([tokens.token_type, tokens.expires_in, typeof tokens.refresh_token], ['Bearer', 3600, 'string']);
    const again = await form('/oauth/token', { grant_type: 'authorization_code', code: code2, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier });
    assert.equal(again.body.error, 'invalid_grant', 'a code works once');
  });

  await t.test('the token acts as the user: same data, same permissions', async () => {
    const me = await bearer(tokens.access_token, '/auth/me');
    assert.deepEqual([me.body.user.username, me.body.organizations.map((o) => o.name), me.body.currentOrganization?.name], ['pat', ['Org A'], 'Org A']);
    const lk = await bearer(tokens.access_token, '/lookups');
    assert.equal(lk.status, 200);
    assert.ok(lk.body.accounts.length > 10);
    assert.equal((await bearer(tokens.access_token, '/admin/users')).status, 403, 'pat is not an organization administrator');
    assert.equal((await bearer(tokens.access_token, '/lookups', { org: orgB.id })).status, 403, 'pat has no access to Org B');
    assert.equal((await bearer('not-a-token', '/lookups')).status, 401);
    // Approving another app needs the web sign-in, not a token
    assert.equal((await bearer(tokens.access_token, '/oauth/approve', { method: 'POST', body: { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge } })).status, 403);
  });

  await t.test('MCP tools work as the user', async () => {
    const init = await mcp(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.body.result.serverInfo.name, 'the-faithful-steward');
    const list = await mcp(tokens.access_token, 'tools/list');
    const names = list.body.result.tools.map((x) => x.name);
    for (const n of ['list_organizations', 'get_chart_of_accounts', 'find_customers_vendors', 'create_income', 'create_expense', 'create_journal_entry', 'run_report', 'list_bank_feed', 'quick_add_bank_feed_line']) assert.ok(names.includes(n), n);
    assert.equal(list.body.result.tools.find((x) => x.name === 'run_report').annotations.readOnlyHint, true);

    const orgs = await tool(tokens.access_token, 'list_organizations');
    assert.deepEqual(orgs.data.organizations.map((o) => [o.name, o.role]), [['Org A', 'user']]);
    await tool(tokens.access_token, 'create_customer_vendor', { name: 'Office Depot', default_expense_account: 'Office Supplies' });
    const exp = await tool(tokens.access_token, 'create_expense', {
      date: '2026-04-02', bank_account: 'Operating Checking', customer_vendor: 'office depot',
      lines: [{ account: '5300', amount: 40.5, memo: 'Paper' }, { account: 'Office Supplies', amount: 9.5 }], check_number: '1001',
    });
    assert.equal(exp.isError, false, exp.data);
    assert.equal(exp.data.amount, '50.00');
    const e = await admin.get(`/expenses/${exp.data.id}`);
    assert.deepEqual([Number(e.amount), e.check_number, e.transaction_method, e.company_name, e.lines.length], [50, '1001', 'check', 'Office Depot', 2]);
    assert.equal((await app.db.query('SELECT created_by_user_id FROM transactions WHERE id = $1', [exp.data.id])).rows[0].created_by_user_id,
      (await app.db.query(`SELECT id FROM users WHERE username = 'pat'`)).rows[0].id, 'recorded as created by the user');
    const listed = await tool(tokens.access_token, 'list_transactions', { type: 'expense', from: '2026-01-01', to: '2026-12-31' });
    assert.deepEqual([listed.data.total, listed.data.totals.amount], [1, '50.00']);
    const report = await tool(tokens.access_token, 'run_report', { report: 'Profit and Loss', from: '2026-01-01', to: '2026-12-31' });
    assert.equal(report.isError, false, report.data);
    assert.ok(report.data.lines.some((l) => /Office Supplies/.test(l.label || '')));
    const notFound = await tool(tokens.access_token, 'create_income', { date: '2026-04-03', bank_account: 'Operating Checking', lines: [{ account: 'No Such Account', amount: 5 }] });
    assert.equal(notFound.isError, true);
    assert.match(notFound.data, /Account "No Such Account" was not found/);
    // The app's own rules still apply: a closed period refuses the change
    await admin.put('/period-closing', { closingDate: '2026-04-30' });
    const closed = await tool(tokens.access_token, 'create_income', { date: '2026-04-03', bank_account: 'Operating Checking', lines: [{ account: '4000', amount: 5 }] });
    assert.equal(closed.isError, true);
    assert.match(closed.data, /closed/i);
    await admin.put('/period-closing', { closingDate: null });
    // Another organization the user doesn't belong to
    const other = await tool(tokens.access_token, 'get_chart_of_accounts', { organization_id: orgB.id });
    assert.match(other.data, /do not have access/);
  });

  await t.test('refresh tokens rotate; a reused one ends the sign-in', async () => {
    const r1 = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(r1.status, 200);
    assert.equal((await bearer(tokens.access_token, '/auth/me')).status, 401, 'the old access token stops working');
    assert.equal((await bearer(r1.body.access_token, '/auth/me')).status, 200);
    const reused = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(reused.body.error, 'invalid_grant');
    assert.equal((await bearer(r1.body.access_token, '/auth/me')).status, 401, 'reuse revokes the whole sign-in');
  });

  let pw;
  await t.test('scripts can sign in with a user name and password', async () => {
    const bad = await form('/oauth/token', { grant_type: 'password', username: 'pat', password: 'wrong' });
    assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_grant']);
    const good = await form('/oauth/token', { grant_type: 'password', username: 'PAT', password: 'pat-password' });
    assert.equal(good.status, 200);
    pw = good.body;
    assert.equal((await bearer(pw.access_token, '/expenses?page=1')).body.total, 1);
  });

  await t.test('connected apps can be listed and disconnected; password resets and removal end access', async () => {
    // Pat signs in through the app again so there's a connection to see
    const ap = await pat.post('/oauth/approve', { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge });
    const code = new URL(ap.redirect).searchParams.get('code');
    const tk = (await form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier })).body;
    const conns = await pat.get('/oauth/connections');
    assert.deepEqual(conns.map((c) => c.client_name).sort(), ['API (password sign-in)', 'Test Assistant']);
    await pat.del(`/oauth/connections/${client.client_id}`);
    assert.equal((await bearer(tk.access_token, '/auth/me')).status, 401);
    assert.equal((await bearer(pw.access_token, '/auth/me')).status, 200, 'other apps keep working');
    // An administrator resets Pat's password: every API / MCP sign-in ends
    const patId = (await app.db.query(`SELECT id FROM users WHERE username = 'pat'`)).rows[0].id;
    await admin.post(`/admin/users/${patId}/reset-password`, { password: 'new-pat-password', mustChangePassword: false });
    assert.equal((await bearer(pw.access_token, '/auth/me')).status, 401);
    // Removed from the organization: a new token no longer reaches it
    const fresh = (await form('/oauth/token', { grant_type: 'password', username: 'pat', password: 'new-pat-password' })).body;
    await admin.del(`/admin/users/${patId}`);
    assert.notEqual((await bearer(fresh.access_token, '/lookups', { org: orgA.id })).status, 200);
    // Must change password: tokens are refused until it's changed
    await admin.post('/admin/users', { username: 'lee', password: 'lee-password', role: 'user', apiAccess: true });
    const lee = (await form('/oauth/token', { grant_type: 'password', username: 'lee', password: 'lee-password' })).body;
    const leeId = (await app.db.query(`SELECT id FROM users WHERE username = 'lee'`)).rows[0].id;
    await app.db.query('UPDATE users SET must_change_password = true WHERE id = $1', [leeId]);
    assert.equal((await bearer(lee.access_token, '/lookups')).status, 403);
    const blocked = await form('/oauth/token', { grant_type: 'password', username: 'lee', password: 'lee-password' });
    assert.match(blocked.body.error_description, /choose a new password/);
  });

  await t.test('API and MCP access is off until an administrator turns it on, and can be turned off again', async () => {
    await admin.post('/admin/users', { username: 'sam', password: 'sam-password', role: 'user' });
    const samId = (await app.db.query(`SELECT id FROM users WHERE username = 'sam'`)).rows[0].id;
    assert.equal((await admin.get('/admin/users')).find((u) => u.id === samId).api_access, false, 'off by default');
    const off = await form('/oauth/token', { grant_type: 'password', username: 'sam', password: 'sam-password' });
    assert.equal(off.body.error, 'access_denied');
    await admin.put(`/admin/users/${samId}`, { role: 'user', apiAccess: true });
    const sam = (await form('/oauth/token', { grant_type: 'password', username: 'sam', password: 'sam-password' })).body;
    assert.equal((await bearer(sam.access_token, '/lookups')).status, 200);
    const samWeb = app.client();
    await samWeb.post('/auth/login', { username: 'sam', password: 'sam-password' });

    await admin.put(`/admin/users/${samId}`, { role: 'user', apiAccess: false });
    assert.equal((await admin.get('/admin/users')).find((u) => u.id === samId).api_access, false);
    const cut = await bearer(sam.access_token, '/lookups');
    assert.equal(cut.status, 401, 'existing tokens end immediately');
    const refused = await form('/oauth/token', { grant_type: 'password', username: 'sam', password: 'sam-password' });
    assert.deepEqual([refused.body.error, /turned off/.test(refused.body.error_description)], ['access_denied', true]);
    const refreshed = await form('/oauth/token', { grant_type: 'refresh_token', refresh_token: sam.refresh_token });
    assert.equal(refreshed.body.error, 'invalid_grant');
    await assert.rejects(samWeb.get(`/oauth/authorize-info?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect)}`), /turned off/);
    await assert.rejects(samWeb.post('/oauth/approve', { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge }), /turned off/);
    assert.equal((await samWeb.get('/lookups')).accounts.length > 0, true, 'the web sign-in still works');
    assert.equal((await samWeb.get('/auth/me')).user.api_access, false);

    await admin.put(`/admin/users/${samId}`, { role: 'user', apiAccess: true });
    const back = (await form('/oauth/token', { grant_type: 'password', username: 'sam', password: 'sam-password' })).body;
    assert.equal((await bearer(back.access_token, '/lookups')).status, 200);
    // New users can be given access when they're added
    await admin.post('/admin/users', { username: 'kim', password: 'kim-password', role: 'user', apiAccess: true });
    const kim = await form('/oauth/token', { grant_type: 'password', username: 'kim', password: 'kim-password' });
    assert.equal(kim.status, 200);
  });
});
