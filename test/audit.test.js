// Created/updated audit fields.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_audit'); });
after(async () => { await app?.stop(); });

const EXCLUDED = new Set(['session', 'schema_migrations']);
const recent = (ts) => Math.abs(Date.now() - new Date(ts).getTime()) < 60_000;

test('audit fields', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Audit Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  await admin.post('/admin/users', { username: 'pat', password: 'pat-password', displayName: 'Pat Bookkeeper', role: 'admin' });
  const pat = app.client();
  await pat.post('/auth/login', { username: 'pat', password: 'pat-password' });
  const { rows: [{ id: adminId }] } = await app.db.query(`SELECT id FROM users WHERE username = 'admin'`);
  const { rows: [{ id: patId }] } = await app.db.query(`SELECT id FROM users WHERE username = 'pat'`);

  await t.test('every application table has the four fields and the trigger', async () => {
    const { rows: tables } = await app.db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
    const appTables = tables.map((x) => x.table_name).filter((n) => !EXCLUDED.has(n));
    assert.ok(appTables.length >= 20);
    const { rows: cols } = await app.db.query(
      `SELECT table_name, array_agg(column_name::text) AS cols FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name IN ('created_at', 'created_by_user_id', 'updated_at', 'updated_by_user_id')
        GROUP BY table_name`);
    const byTable = Object.fromEntries(cols.map((c) => [c.table_name, c.cols]));
    const { rows: triggers } = await app.db.query(`SELECT DISTINCT event_object_table AS t FROM information_schema.triggers WHERE trigger_name LIKE '%_audit'`);
    const withTrigger = new Set(triggers.map((x) => x.t));
    for (const tbl of appTables) {
      assert.equal(byTable[tbl]?.length, 4, `${tbl} is missing audit columns`);
      assert.ok(withTrigger.has(tbl), `${tbl} has no audit trigger`);
    }
  });

  let companyId;
  await t.test('adding a record sets created and last updated to the current user', async () => {
    companyId = (await admin.post('/companies', { name: 'Audit Donor' })).id;
    const a = await admin.get(`/audit/companies/${companyId}`);
    assert.equal(a.created_by, 'Admin');
    assert.equal(a.updated_by, 'Admin');
    assert.ok(recent(a.created_at));
    assert.equal(a.created_at, a.updated_at);
  });

  await t.test('changing a record updates only "last updated"', async () => {
    const before = await admin.get(`/audit/companies/${companyId}`);
    await new Promise((r) => setTimeout(r, 20));
    await pat.put(`/companies/${companyId}`, { name: 'Audit Donor (renamed)' });
    const a = await pat.get(`/audit/companies/${companyId}`);
    assert.deepEqual([a.created_by, a.created_at], [before.created_by, before.created_at]);
    assert.equal(a.updated_by, 'Pat Bookkeeper');
    assert.ok(new Date(a.updated_at) > new Date(a.created_at));
  });

  await t.test('transactions and their lines and GL rows are stamped too', async () => {
    const lk = await admin.get('/lookups');
    const acct = (n) => lk.accounts.find((x) => x.account_number === n).id;
    const id = (await admin.post('/income', { date: '2026-05-01', amount: 50, accountId: acct('1000'), companyId, lines: [{ accountId: acct('4000'), amount: 50 }] })).id;
    await pat.put(`/income/${id}`, { date: '2026-05-01', amount: 60, accountId: acct('1000'), companyId, lines: [{ accountId: acct('4000'), amount: 60 }] });
    const a = await admin.get(`/audit/transactions/${id}`);
    assert.deepEqual([a.created_by, a.updated_by], ['Admin', 'Pat Bookkeeper']);
    const { rows: details } = await app.db.query('SELECT created_by_user_id, updated_by_user_id FROM transaction_details WHERE transaction_id = $1', [id]);
    assert.deepEqual(details.map((d) => [d.created_by_user_id, d.updated_by_user_id]), [[patId, patId]]);
    const { rows: gl } = await app.db.query(
      'SELECT d.created_by_user_id FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id WHERE h.transaction_id = $1', [id]);
    assert.ok(gl.length && gl.every((g) => g.created_by_user_id === patId));
  });

  await t.test('created fields cannot be overwritten', async () => {
    await app.db.query('UPDATE companies SET created_by_user_id = $1, created_at = $2 WHERE id = $3', [patId, '2000-01-01', companyId]);
    const { rows: [c] } = await app.db.query('SELECT created_by_user_id, created_at FROM companies WHERE id = $1', [companyId]);
    assert.equal(c.created_by_user_id, adminId);
    assert.notEqual(new Date(c.created_at).getUTCFullYear(), 2000);
  });

  await t.test('writes outside a request (background jobs) record no user', async () => {
    const { rows: [f] } = await app.db.query(`INSERT INTO funds (organization_id, name) VALUES ($1, 'System Fund') RETURNING created_by_user_id, created_at`, [org.id]);
    assert.equal(f.created_by_user_id, null);
    assert.ok(recent(f.created_at));
  });

  await t.test('organization, users and settings records', async () => {
    const o = await admin.get('/org');
    await pat.put('/org', { ...o, phone: '555-0100' });
    assert.equal((await admin.get(`/audit/organizations/${org.id}`)).updated_by, 'Pat Bookkeeper');
    assert.equal((await admin.get(`/audit/users/${patId}`)).created_by, 'Admin');
    await assert.rejects(admin.get(`/audit/organizations/${other.id}`), /Not found/);
    await assert.rejects(admin.get(`/audit/session/1`), /Not found/);
  });

  await t.test('audit info is private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/audit/companies/${companyId}`), /Not found/);
    await assert.rejects(admin.get(`/audit/users/${patId}`), /Not found/);
  });
});
