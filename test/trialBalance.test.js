// Trial balance report tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_tb'); });
after(async () => { await app?.stop(); });

const line = (r, label) => r.lines.find((l) => l.label === label || l.label?.endsWith(`· ${label}`));

test('trial balance', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'TB Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, card, contributions, rent, office] = ['1000', '2000', '4000', '5200', '5300'].map(acct);
  const general = lk.funds[0].id;
  const youth = (await admin.post('/funds', { name: 'Youth Program' })).id;
  const income = (date, amount, fundId = general) => admin.post('/income', { date, amount, accountId: checking, fundId, lines: [{ accountId: contributions, amount, fundId }] });
  // Last fiscal year (calendar): +1000 income, -300 rent  => prior years net +700
  await income('2025-06-01', 1000);
  await admin.post('/expenses', { date: '2025-07-01', amount: 300, accountId: checking, fundId: general, lines: [{ accountId: rent, amount: 300, fundId: general }] });
  // This year: +500 (youth), 80 office supplies on the credit card
  await income('2026-02-01', 500, youth);
  await admin.post('/expenses', { date: '2026-03-01', amount: 80, accountId: card, fundId: general, lines: [{ accountId: office, amount: 80, fundId: general }] });

  let def;
  await t.test('added as a standard report (also for existing organizations)', async () => {
    await app.db.query(`DELETE FROM report_definitions WHERE organization_id = $1 AND builtin_key = 'trial_balance'`, [org.id]);
    const list = await admin.get('/reports');
    const tb = list.find((r) => r.builtin_key === 'trial_balance');
    assert.ok(tb, 're-added when reports are listed');
    assert.equal(list.filter((r) => r.builtin_key).at(-1).builtin_key, 'trial_balance', 'listed after the other standard reports');
    def = (await admin.get(`/reports/${tb.id}`)).definition;
    assert.equal(def.type, 'trial_balance');
  });

  await t.test('debits equal credits, with prior years rolled into net assets', async () => {
    const r = await admin.post('/reports/run', { definition: def, to: '2026-12-31' });
    assert.deepEqual(r.columns.map((c) => c.label), ['Debit', 'Credit']);
    assert.deepEqual(line(r, 'Operating Checking').values, [120000, 0]);       // 1000 - 300 + 500
    assert.deepEqual(line(r, 'Credit Card').values, [0, 8000]);
    assert.deepEqual(line(r, 'Individual Contributions').values, [0, 50000], 'income shows the current year only');
    assert.deepEqual(line(r, 'Office Supplies').values, [8000, 0]);
    assert.equal(line(r, 'Rent & Occupancy'), undefined, 'last year’s expense is not listed');
    assert.deepEqual(line(r, "Net Assets – Prior Years' Activity").values, [0, 70000]);
    const total = line(r, 'Total');
    assert.deepEqual(total.values, [128000, 128000]);
    assert.equal(line(r, 'Out of balance'), undefined);
    assert.equal(line(r, 'Individual Contributions').drillFrom, '2026-01-01');
  });

  await t.test('as of an earlier date', async () => {
    const r = await admin.post('/reports/run', { definition: def, to: '2025-12-31' });
    assert.deepEqual(line(r, 'Individual Contributions').values, [0, 100000]);
    assert.deepEqual(line(r, 'Rent & Occupancy').values, [30000, 0]);
    assert.equal(line(r, "Net Assets – Prior Years' Activity"), undefined);
    assert.deepEqual(line(r, 'Total').values, [100000, 100000]);
  });

  await t.test('options: group by type, zero balances, fund filter', async () => {
    const grouped = await admin.post('/reports/run', { definition: { ...def, options: { ...def.options, groupByType: true } }, to: '2026-12-31' });
    assert.ok(grouped.lines.some((l) => l.type === 'subheader' && l.label === 'Bank'));
    assert.deepEqual(line(grouped, 'Total Bank').values, [120000, 0]);
    assert.deepEqual(line(grouped, 'Total').values, [128000, 128000]);
    const zeros = await admin.post('/reports/run', { definition: { ...def, options: { ...def.options, showZeroRows: true } }, to: '2026-12-31' });
    assert.ok(line(zeros, 'Savings'), 'zero-balance accounts shown when asked');
    const youthOnly = await admin.post('/reports/run', { definition: { ...def, fundFilter: [youth] }, to: '2026-12-31' });
    assert.deepEqual(line(youthOnly, 'Operating Checking').values, [50000, 0]);
    assert.deepEqual(line(youthOnly, 'Total').values, [50000, 50000]);
  });

  await t.test('drill-down uses the current fiscal year for income and expense lines', async () => {
    const r = await admin.post('/reports/drilldown', { accountIds: [contributions], from: '2026-01-01', to: '2026-12-31' });
    assert.equal(r.length, 1);
  });

  await t.test('can be customized, saved as a copy and reset', async () => {
    const tb = (await admin.get('/reports')).find((r) => r.builtin_key === 'trial_balance');
    await admin.put(`/reports/${tb.id}`, { name: 'TB', definition: { ...def, options: { ...def.options, groupByType: true }, bogus: 1 } });
    const saved = (await admin.get(`/reports/${tb.id}`)).definition;
    assert.equal(saved.options.groupByType, true);
    assert.equal(saved.bogus, undefined);
    const copy = await admin.post(`/reports/${tb.id}/copy`, { name: 'TB by type' });
    assert.equal((await admin.get(`/reports/${copy.id}`)).definition.type, 'trial_balance');
    const reset = await admin.post(`/reports/${tb.id}/reset`);
    assert.deepEqual([reset.name, reset.definition.options.groupByType], ['Trial Balance', false]);
  });
});
