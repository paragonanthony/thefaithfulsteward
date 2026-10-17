// Deleting an organization removes all of its data (even closed-period and reconciled transactions) and nothing else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_delete_org'); });
after(async () => { await app?.stop(); });

/** Row counts for one organization in every table that has an organization_id, plus the child tables. */
async function footprint(db, orgId) {
  const { rows: tables } = await db.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organization_id' ORDER BY 1`);
  const out = {};
  for (const { table_name: t } of tables) {
    const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE organization_id = $1`, [orgId]);
    if (r.n) out[t] = r.n;
  }
  const child = async (name, sql) => { const { rows: [r] } = await db.query(sql, [orgId]); if (r.n) out[name] = r.n; };
  await child('transaction_details', 'SELECT COUNT(*)::int AS n FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id WHERE t.organization_id = $1');
  await child('gl_details', 'SELECT COUNT(*)::int AS n FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id WHERE h.organization_id = $1');
  await child('reconciliations', 'SELECT COUNT(*)::int AS n FROM reconciliations r JOIN transactions t ON t.id = r.transaction_id WHERE t.organization_id = $1');
  await child('budget_lines', 'SELECT COUNT(*)::int AS n FROM budget_lines l JOIN budgets b ON b.id = l.budget_id WHERE b.organization_id = $1');
  return out;
}

async function fill(admin, orgId, { closeBooks = false } = {}) {
  await admin.post('/auth/select-org', { organizationId: orgId });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, savings, undeposited, contributions, office, rent, ap] = ['1000', '1010', '1050', '4000', '5300', '5200', '2100'].map(a);
  const vendor = (await admin.post('/companies', { name: 'Vendor' })).id;
  const donor = (await admin.post('/companies', { name: 'Donor' })).id;
  const fund = (await admin.post('/funds', { name: 'Youth' })).id;
  const inc = (await admin.post('/income', { date: '2026-03-01', amount: 100, accountId: checking, companyId: donor, lines: [{ accountId: contributions, amount: 100, fundId: fund }] })).id;
  const exp = (await admin.post('/expenses', { date: '2026-03-02', amount: 40, accountId: checking, companyId: vendor, lines: [{ accountId: office, amount: 40 }] })).id;
  const u1 = (await admin.post('/income', { date: '2026-03-03', amount: 30, accountId: undeposited, lines: [{ accountId: contributions, amount: 30 }] })).id;
  const dep = (await admin.post('/deposits', { date: '2026-03-04', accountId: checking, incomeIds: [u1] })).id;
  const je = (await admin.post('/journal-entries', { date: '2026-03-05', memo: 'JE', lines: [{ accountId: checking, debit: 10 }, { accountId: contributions, credit: 10 }] })).id;
  const tr = (await admin.post('/transfers', { date: '2026-03-06', fromAccountId: checking, toAccountId: savings, amount: 5 })).id;
  const bill = (await admin.post('/bills', { date: '2026-03-01', companyId: vendor, accountId: ap, amount: 50, lines: [{ accountId: rent, amount: 50 }] })).id;
  const pay = (await admin.post('/bill-payments', { companyId: vendor, date: '2026-03-07', accountId: checking, payments: [{ billId: bill, amount: 50 }] })).id;
  await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-03-31', statementEndingBalance: 45, clearedIds: [inc, exp, dep, je, tr, pay], complete: true });
  await admin.post('/attachments', { fileName: 'r.pdf', data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), transactionId: exp });
  await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2026-04-02', description: 'COFFEE', amount: -4 }] });
  await admin.post('/bank-feed-rules', { matchText: 'coffee', accountId: office });
  await admin.post('/budgets', { name: 'B', startDate: '2026-01-01', endDate: '2026-12-31', scope: 'overall', lines: [{ accountId: office, months: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] }] }).catch(() => {});
  if (closeBooks) await admin.put('/period-closing', { closingDate: '2026-03-31' });
}

test('deleting an organization', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const doomed = await admin.post('/admin/organizations', { name: 'Doomed Org' });
  const kept = await admin.post('/admin/organizations', { name: 'Kept Org' });
  await fill(admin, doomed.id, { closeBooks: true });
  await fill(admin, kept.id, { closeBooks: true });
  // Users: one only in the doomed org, one in both, one only in the kept org
  await admin.post('/auth/select-org', { organizationId: doomed.id });
  await admin.post('/admin/users', { username: 'only', password: 'only-password', displayName: 'Only Here', role: 'user' });
  await admin.post('/admin/users', { username: 'shared', password: 'shared-password', role: 'user' });
  await admin.post('/auth/select-org', { organizationId: kept.id });
  await admin.post('/admin/users', { username: 'shared', password: 'x', role: 'user' }); // already exists: just joins
  const keptBefore = await footprint(app.db, kept.id);
  const doomedBefore = await footprint(app.db, doomed.id);
  assert.ok(doomedBefore.transactions >= 9 && doomedBefore.gl_details > 10 && doomedBefore.reconciliations === 1 && doomedBefore.attachments === 1, JSON.stringify(doomedBefore));

  await t.test('the preview shows what will be removed', async () => {
    const p = await admin.get(`/admin/organizations/${doomed.id}/delete-preview`);
    assert.equal(p.name, 'Doomed Org');
    assert.equal(p.counts.transactions, doomedBefore.transactions);
    assert.deepEqual(p.usersOnlyHere.map((u) => u.username), ['only']);
  });

  await t.test('only system administrators, and only with the name typed', async () => {
    const shared = app.client();
    await shared.post('/auth/login', { username: 'shared', password: 'shared-password' });
    await assert.rejects(shared.req('DELETE', `/admin/organizations/${doomed.id}`, { confirmName: 'Doomed Org' }), /System administrator/);
    await assert.rejects(admin.req('DELETE', `/admin/organizations/${doomed.id}`, { confirmName: 'Doomed' }), /Type the organization's name/);
    await assert.rejects(admin.req('DELETE', `/admin/organizations/${doomed.id}`, {}), /Type the organization's name/);
    assert.deepEqual(await footprint(app.db, doomed.id), doomedBefore, 'nothing was deleted');
  });

  await t.test('everything in the organization is deleted, even closed and reconciled transactions', async () => {
    const r = await admin.req('DELETE', `/admin/organizations/${doomed.id}`, { confirmName: '  doomed org ' });
    assert.deepEqual([r.deleted, r.deletedUsers, r.deactivatedUsers], ['Doomed Org', 1, 0]);
    assert.deepEqual(await footprint(app.db, doomed.id), {}, 'no rows left for it anywhere');
    assert.equal((await app.db.query('SELECT 1 FROM organizations WHERE id = $1', [doomed.id])).rows.length, 0);
    const users = (await app.db.query(`SELECT username FROM users ORDER BY username`)).rows.map((u) => u.username);
    assert.deepEqual(users, ['admin', 'shared'], 'the user only in it is deleted; the shared user stays');
  });

  await t.test('other organizations and their locks are untouched', async () => {
    assert.deepEqual(await footprint(app.db, kept.id), keptBefore);
    await admin.post('/auth/select-org', { organizationId: kept.id });
    const lk = await admin.get('/lookups');
    const office = lk.accounts.find((x) => x.account_number === '5300').id;
    const checking = lk.accounts.find((x) => x.account_number === '1000').id;
    // The kept organization's closed period still protects it
    await assert.rejects(admin.post('/expenses', { date: '2026-03-15', amount: 1, accountId: checking, lines: [{ accountId: office, amount: 1 }] }), /closed/);
    const list = await admin.get('/expenses?page=1&from=2026-01-01&to=2026-12-31');
    await assert.rejects(admin.del(`/expenses/${list.rows[0].id}`), /closed|reconciliation/);
    // The database checks still apply to everyone else outside the delete
    const { rows: [tx] } = await app.db.query(`SELECT id FROM transactions WHERE organization_id = $1 AND transaction_type = 'expense' LIMIT 1`, [kept.id]);
    await assert.rejects(app.db.query('DELETE FROM transactions WHERE id = $1', [tx.id]), /closed/);
  });

  await t.test('a user still named on records elsewhere is deactivated instead of deleted', async () => {
    const org3 = await admin.post('/admin/organizations', { name: 'Third Org' });
    await admin.post('/auth/select-org', { organizationId: org3.id });
    await admin.post('/admin/users', { username: 'mover', password: 'mover-password', role: 'user' });
    const moverId = (await app.db.query(`SELECT id FROM users WHERE username = 'mover'`)).rows[0].id;
    // An earlier record in the kept organization created by this user
    const { rows: [tx] } = await app.db.query(`SELECT id FROM transactions WHERE organization_id = $1 LIMIT 1`, [kept.id]);
    await app.db.query(`ALTER TABLE transactions DISABLE TRIGGER USER`);
    await app.db.query('UPDATE transactions SET created_by_user_id = $1 WHERE id = $2', [moverId, tx.id]);
    await app.db.query(`ALTER TABLE transactions ENABLE TRIGGER USER`);
    const r = await admin.req('DELETE', `/admin/organizations/${org3.id}`, { confirmName: 'Third Org' });
    assert.deepEqual([r.deletedUsers, r.deactivatedUsers], [0, 1]);
    const { rows: [u] } = await app.db.query('SELECT is_active FROM users WHERE id = $1', [moverId]);
    assert.equal(u.is_active, false);
    // Keeping user accounts is also an option
    const org4 = await admin.post('/admin/organizations', { name: 'Fourth Org' });
    await admin.post('/auth/select-org', { organizationId: org4.id });
    await admin.post('/admin/users', { username: 'stay', password: 'stay-password', role: 'user' });
    const r4 = await admin.req('DELETE', `/admin/organizations/${org4.id}`, { confirmName: 'Fourth Org', keepUsers: true });
    assert.equal(r4.deletedUsers, 0);
    assert.equal((await app.db.query(`SELECT 1 FROM users WHERE username = 'stay'`)).rows.length, 1);
  });

  await t.test('a user who had it selected is asked to choose another organization', async () => {
    const shared = app.client();
    await shared.post('/auth/login', { username: 'shared', password: 'shared-password' });
    const me = await shared.get('/auth/me');
    assert.deepEqual(me.organizations.map((o) => o.name), ['Kept Org']);
    await assert.rejects(admin.get(`/admin/organizations/${doomed.id}/delete-preview`), /not found/);
  });
});
