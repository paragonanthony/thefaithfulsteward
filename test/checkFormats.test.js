// Check format API tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_checks'); });
after(async () => { await app?.stop(); });

test('check formats', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Check Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const checking = (await admin.get('/lookups')).accounts.find((a) => a.account_number === '1000');

  let standard;
  let custom;
  await t.test('a standard default format is created automatically', async () => {
    const list = await admin.get('/check-formats');
    assert.equal(list.length, 1);
    standard = list[0];
    assert.equal(standard.is_default, true);
    assert.equal(standard.layout.checkPosition, 'top');
    assert.equal((await admin.get('/check-formats')).length, 1, 'listing again does not create another');
  });

  await t.test('layouts are validated and clamped', async () => {
    custom = await admin.post('/check-formats', {
      name: 'Bottom check',
      layout: { checkPosition: 'bottom', fontSize: 99, fontFamily: 'Comic Sans', stubs: 7, offsetX: 5, fields: { amount: { x: 100, y: -3, show: false } } },
    });
    const f = await admin.get(`/check-formats/${custom.id}`);
    assert.equal(f.layout.checkPosition, 'bottom');
    assert.equal(f.layout.fontSize, 16);
    assert.equal(f.layout.fontFamily, 'Courier New');
    assert.equal(f.layout.stubs, 2);
    assert.equal(f.layout.offsetX, 1);
    assert.equal(f.layout.fields.amount.x, 8.25);
    assert.equal(f.layout.fields.amount.y, 0);
    assert.equal(f.layout.fields.amount.show, false);
    assert.equal(f.layout.fields.payee.show, true, 'missing fields get defaults');
    await assert.rejects(admin.post('/check-formats', { name: ' ', layout: {} }), /name is required/);
  });

  await t.test('default can be changed; the default cannot be deleted', async () => {
    await assert.rejects(admin.del(`/check-formats/${standard.id}`), /another format the default/);
    await admin.post(`/check-formats/${custom.id}/default`);
    const list = await admin.get('/check-formats');
    assert.deepEqual(list.filter((f) => f.is_default).map((f) => f.id), [custom.id]);
    await admin.post(`/check-formats/${standard.id}/default`);
  });

  await t.test('a bank account can be assigned a format', async () => {
    await admin.put(`/accounts/${checking.id}`, { ...checking, check_format_id: custom.id });
    assert.equal((await admin.get('/lookups')).accounts.find((a) => a.id === checking.id).check_format_id, custom.id);
    assert.deepEqual((await admin.get('/check-formats')).find((f) => f.id === custom.id).accounts, [checking.name]);
    await admin.del(`/check-formats/${custom.id}`);
    assert.equal((await admin.get('/lookups')).accounts.find((a) => a.id === checking.id).check_format_id, null, 'deleting a format unassigns it');
  });

  await t.test('formats are private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    const otherChecking = (await admin.get('/lookups')).accounts.find((a) => a.account_number === '1000');
    await assert.rejects(admin.get(`/check-formats/${standard.id}`), /not found/);
    await assert.rejects(admin.put(`/check-formats/${standard.id}`, { name: 'x', layout: {} }), /not found/);
    await assert.rejects(admin.put(`/accounts/${otherChecking.id}`, { ...otherChecking, check_format_id: standard.id }), /Invalid check format/);
  });

  await t.test('only organization admins can change formats', async () => {
    await admin.post('/auth/select-org', { organizationId: org.id });
    await admin.post('/admin/users', { username: 'clerk', password: 'clerk-password', role: 'user' });
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    assert.equal((await clerk.get('/check-formats')).length, 1);
    await assert.rejects(clerk.put(`/check-formats/${standard.id}`, { name: 'x', layout: {} }), /administrator/);
  });
});
