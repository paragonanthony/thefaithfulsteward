// Tuition report tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_treports'); });
after(async () => { await app?.stop(); });

const run = (c, definition, to, from) => c.post('/reports/run', { definition, to, from });
const allRows = (result) => result.groups.flatMap((g) => g.rows);

test('tuition reports', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Academy' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const checking = lk.accounts.find((a) => a.account_number === '1000').id;
  const fees = lk.accounts.find((a) => a.account_number === '4200').id;
  const general = lk.funds[0].id;
  const scholarship = (await admin.post('/funds', { name: 'Scholarship Fund' })).id;
  const fam = {};
  for (const n of ['Adams', 'Baker', 'Chen']) fam[n] = (await admin.post('/companies', { name: `${n} Family`, email: `${n.toLowerCase()}@example.com` })).id;

  await t.test('standard Tuition Balances report appears only when tuition is on', async () => {
    assert.ok(!(await admin.get('/reports')).some((r) => r.builtin_key === 'tuition_balances'));
    const o = await admin.get('/org');
    await admin.put('/org', { ...o, tuition_enabled: true });
    const list = await admin.get('/reports');
    assert.equal(list.filter((r) => r.builtin_key === 'tuition_balances').length, 1);
    await admin.get('/reports');
    assert.equal((await admin.get('/reports')).filter((r) => r.builtin_key === 'tuition_balances').length, 1, 'seeded once');
  });

  // Data: Adams 4000 (paid 1000 in Sept, 500 in Nov), Baker 3000 paid in full, Chen 2000 (scholarship fund) unpaid, Chen spring 1000
  const rec = async (company, date, amount, description, fundId = general) => (await admin.post('/tuition', { companyId: company, date, amount, description, incomeAccountId: fees, fundId })).id;
  const pay = (company, date, lines) => admin.post('/income', { date, amount: lines.reduce((s, l) => s + l.amount, 0), accountId: checking, companyId: company, lines: lines.map((l) => ({ accountId: fees, ...l })) });
  const adams = await rec(fam.Adams, '2026-08-01', 4000, 'Fall 2026');
  const baker = await rec(fam.Baker, '2026-08-01', 3000, 'Fall 2026');
  await rec(fam.Chen, '2026-08-01', 2000, 'Fall 2026', scholarship);
  await rec(fam.Chen, '2027-01-05', 1000, 'Spring 2027', scholarship);
  await pay(fam.Adams, '2026-09-01', [{ amount: 1000, tuitionId: adams }]);
  await pay(fam.Adams, '2026-11-15', [{ amount: 500, tuitionId: adams }]);
  await pay(fam.Baker, '2026-08-20', [{ amount: 3000, tuitionId: baker }]);

  let std;
  await t.test('Tuition Balances lists unpaid records grouped by customer', async () => {
    const id = (await admin.get('/reports')).find((r) => r.builtin_key === 'tuition_balances').id;
    std = (await admin.get(`/reports/${id}`)).definition;
    assert.equal(std.type, 'tuition');
    const r = await run(admin, std, '2027-02-01');
    assert.deepEqual(r.groups.map((g) => g.label), ['Adams Family', 'Chen Family']);
    assert.equal(r.count, 3);
    assert.deepEqual(r.totals, { amount: 7000, paid: 1500, balance: 5500 });
    assert.deepEqual(r.groups[1].subtotal, { amount: 3000, paid: 0, balance: 3000 });
    const adamsRow = r.groups[0].rows[0];
    assert.equal(adamsRow.days_outstanding, 184);
    assert.deepEqual(r.columns.map((c) => c.key), ['date', 'customer', 'description', 'amount', 'paid', 'balance', 'days_outstanding']);
  });

  await t.test('as-of date ignores later payments and later tuition', async () => {
    const r = await run(admin, std, '2026-10-01');
    const rows = allRows(r);
    assert.equal(rows.length, 2, 'Chen spring (2027) not yet billed; Baker paid in August');
    assert.equal(rows.find((x) => x.customer === 'Adams Family').balance, 3000, 'November payment not counted yet');
  });

  await t.test('custom report: columns, aging, grouping, filters, sorting', async () => {
    const def = {
      ...std, status: 'all', groupBy: 'fund', sortBy: 'balance', sortDir: 'desc',
      columns: ['customer', 'description', 'amount', 'paid', 'balance', 'percent_paid', 'last_payment', 'payments', 'age_current', 'age_31_60', 'age_61_90', 'age_over_90', 'email'],
    };
    const r = await run(admin, def, '2027-01-20');
    assert.deepEqual(r.groups.map((g) => g.label), ['General Fund', 'Scholarship Fund']);
    const general = r.groups[0].rows;
    assert.deepEqual(general.map((x) => x.customer), ['Adams Family', 'Baker Family'], 'sorted by balance descending');
    assert.equal(general[0].percent_paid, 37.5);
    assert.equal(general[0].last_payment, '2026-11-15');
    assert.equal(general[0].payments, 2);
    assert.equal(general[1].balance, 0);
    assert.equal(general[0].age_over_90, 2500, 'Fall tuition is 172 days old');
    const chenSpring = r.groups[1].rows.find((x) => x.description === 'Spring 2027');
    assert.equal(chenSpring.age_current, 1000);
    assert.equal(r.totals.age_over_90, 4500);
    assert.equal(general[0].email, 'adams@example.com');

    const filtered = await run(admin, { ...def, groupBy: 'none', customers: [fam.Chen], descriptionContains: 'fall', funds: [scholarship] }, '2027-01-20');
    assert.deepEqual(allRows(filtered).map((x) => [x.customer, x.description]), [['Chen Family', 'Fall 2026']]);
    const min = await run(admin, { ...def, groupBy: 'none', minBalance: 2100 }, '2027-01-20');
    assert.deepEqual(allRows(min).map((x) => x.balance), [2500]);
    const paidOnly = await run(admin, { ...def, groupBy: 'none', status: 'paid' }, '2027-01-20');
    assert.deepEqual(allRows(paidOnly).map((x) => x.customer), ['Baker Family']);
  });

  await t.test('period mode selects tuition dated within the range', async () => {
    const r = await run(admin, { ...std, dateMode: 'period', status: 'all', groupBy: 'month' }, '2027-06-30', '2027-01-01');
    assert.deepEqual(allRows(r).map((x) => x.description), ['Spring 2027']);
    assert.deepEqual(r.groups.map((g) => g.label), ['January 2027']);
    await assert.rejects(run(admin, { ...std, dateMode: 'period' }, '2027-06-30'), /date range/);
  });

  await t.test('save, copy and reset tuition reports', async () => {
    await assert.rejects(admin.post('/reports', { name: 'Bad', definition: { ...std, columns: [] } }), /at least one column/);
    const saved = await admin.post('/reports', { name: 'Aging by fund', definition: { ...std, groupBy: 'fund', columns: ['customer', 'balance', 'age_over_90'], bogus: 1 } });
    const loaded = (await admin.get(`/reports/${saved.id}`)).definition;
    assert.deepEqual(loaded.columns, ['customer', 'balance', 'age_over_90']);
    assert.equal(loaded.bogus, undefined);
    const blank = await admin.get('/reports/blank?type=tuition');
    assert.equal(blank.type, 'tuition');
    const builtin = (await admin.get('/reports')).find((r) => r.builtin_key === 'tuition_balances');
    await admin.put(`/reports/${builtin.id}`, { name: 'Balances!', definition: { ...std, groupBy: 'none' } });
    const reset = await admin.post(`/reports/${builtin.id}/reset`);
    assert.equal(reset.name, 'Tuition Balances');
    assert.equal(reset.definition.groupBy, 'customer');
  });

  await t.test('turning tuition off hides and blocks tuition reports', async () => {
    const o = await admin.get('/org');
    await admin.put('/org', { ...o, tuition_enabled: false });
    assert.ok(!(await admin.get('/reports')).some((r) => r.type === 'tuition'));
    await assert.rejects(run(admin, std, '2027-01-01'), (e) => e.status === 403);
  });
});
