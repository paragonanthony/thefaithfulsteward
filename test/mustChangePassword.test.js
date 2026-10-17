// Requiring a user to change their password at their next sign-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_must_change_pw'); });
after(async () => { await app?.stop(); });

const status = (p) => p.then(() => 200, (e) => e.status);

test('must change password', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Password Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const { id: userId } = await admin.post('/admin/users', { username: 'pat', displayName: 'Pat', password: 'temporary-1', role: 'user', mustChangePassword: true });

  let pat;
  await t.test('a new user with the option set must change the password first', async () => {
    assert.equal((await admin.get('/admin/users')).find((u) => u.id === userId).must_change_password, true);
    pat = app.client();
    const login = await pat.post('/auth/login', { username: 'pat', password: 'temporary-1' });
    assert.equal(login.mustChangePassword, true);
    const me = await pat.get('/auth/me');
    assert.equal(me.user.must_change_password, true);
    // Everything else is refused until the password is changed
    const res = await fetch(`${app.base}/lookups`, { headers: { Cookie: pat.cookie } });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'You need to choose a new password before continuing.', code: 'password_change_required' });
    assert.equal(await status(pat.get('/income')), 403);
  });

  await t.test('changing it clears the requirement', async () => {
    await assert.rejects(pat.post('/auth/change-password', { currentPassword: 'wrong', newPassword: 'brand-new-pw' }), /Current password is incorrect/);
    await assert.rejects(pat.post('/auth/change-password', { currentPassword: 'temporary-1', newPassword: 'temporary-1' }), /different from the current one/);
    await assert.rejects(pat.post('/auth/change-password', { currentPassword: 'temporary-1', newPassword: 'short' }), /at least 8/);
    await pat.post('/auth/change-password', { currentPassword: 'temporary-1', newPassword: 'brand-new-pw' });
    assert.equal((await pat.get('/auth/me')).user.must_change_password, false);
    assert.ok(Array.isArray((await pat.get('/lookups')).accounts));
    const u = (await admin.get('/admin/users')).find((x) => x.id === userId);
    assert.deepEqual([u.must_change_password, Boolean(u.password_changed_at)], [false, true]);
  });

  await t.test('an administrator can require it for an existing user; it applies to sessions already signed in', async () => {
    await admin.put(`/admin/users/${userId}`, { mustChangePassword: true });
    assert.equal(await status(pat.get('/lookups')), 403);
    // A second sign-in elsewhere is signed out when the password is changed from the first
    const other = app.client();
    await other.post('/auth/login', { username: 'pat', password: 'brand-new-pw' });
    await pat.post('/auth/change-password', { currentPassword: 'brand-new-pw', newPassword: 'another-new-pw' });
    assert.equal(await status(pat.get('/lookups')), 200);
    assert.equal(await status(other.get('/auth/me')), 401);
  });

  await t.test('resetting a password can require a change, or not', async () => {
    await admin.post(`/admin/users/${userId}/reset-password`, { password: 'reset-pass-1', mustChangePassword: true });
    const p2 = app.client();
    assert.equal((await p2.post('/auth/login', { username: 'pat', password: 'reset-pass-1' })).mustChangePassword, true);
    await admin.post(`/admin/users/${userId}/reset-password`, { password: 'reset-pass-2', mustChangePassword: false });
    const p3 = app.client();
    assert.equal((await p3.post('/auth/login', { username: 'pat', password: 'reset-pass-2' })).mustChangePassword, false);
    assert.equal(await status(p3.get('/lookups')), 200);
    await admin.put(`/admin/users/${userId}`, { mustChangePassword: false });
  });

  await t.test('only administrators can set it', async () => {
    const p4 = app.client();
    await p4.post('/auth/login', { username: 'pat', password: 'reset-pass-2' });
    assert.equal(await status(p4.put(`/admin/users/${userId}`, { mustChangePassword: true })), 403);
    // Users created without the option sign in normally
    const { id: lee } = await admin.post('/admin/users', { username: 'lee', password: 'lee-password', role: 'user' });
    const leeClient = app.client();
    assert.equal((await leeClient.post('/auth/login', { username: 'lee', password: 'lee-password' })).mustChangePassword, false);
    assert.ok(lee);
  });
});
