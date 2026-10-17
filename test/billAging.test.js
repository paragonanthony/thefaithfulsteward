// Unpaid Bills Aging standard report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_bill_aging'); });
after(async () => { await app?.stop(); });

test('unpaid bills aging', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Aging Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, ap, office] = ['1000', '2100', '5300'].map(acct);
  const general = lk.funds[0].id;
  const youth = (await admin.post('/funds', { name: 'Youth' })).id;
  const acme = (await admin.post('/companies', { name: 'Acme' })).id;
  const bolt = (await admin.post('/companies', { name: 'Bolt Co' })).id;
  const bill = async (companyId, date, dueDate, amount, ref, fundId = general) => (await admin.post('/bills', {
    date, dueDate, companyId, accountId: ap, fundId, refNumber: ref, amount, lines: [{ accountId: office, amount, fundId }],
  })).id;

  // As of 2026-06-30
  await bill(acme, '2026-06-20', '2026-07-20', 100, 'A1');            // current (not yet due)
  await bill(acme, '2026-05-01', '2026-06-15', 200, 'A2');            // 15 days past due
  const a3 = await bill(acme, '2026-03-01', '2026-03-31', 300, 'A3'); // 91 days past due
  await bill(bolt, '2026-04-01', null, 400, 'B1', youth);             // no due date: due on the bill date, 90 days
  await bill(bolt, '2026-07-05', '2026-08-05', 999, 'B2');            // after the report date: not included
  // A3 partly paid before the date, the rest after it
  await admin.post('/bill-payments', { companyId: acme, date: '2026-06-01', accountId: checking, payments: [{ billId: a3, amount: 50 }] });
  await admin.post('/bill-payments', { companyId: acme, date: '2026-07-10', accountId: checking, payments: [{ billId: a3, amount: 250 }] });

  const list = await admin.get('/reports');
  const rep = list.find((r) => r.builtin_key === 'bill_aging');
  const def = (await admin.get(`/reports/${rep.id}`)).definition;
  const run = (d, to = '2026-06-30') => admin.post('/reports/run', { definition: d, to });
  const line = (r, label) => r.lines.find((l) => l.label === label || l.label?.includes(label));
  const dollars = (l) => l.values.map((v) => v / 100);

  await t.test('is a standard report', () => {
    assert.equal(rep.name, 'Unpaid Bills Aging');
    assert.equal(def.type, 'bill_aging');
    assert.equal(list.filter((r) => r.builtin_key).at(-1).builtin_key, 'trial_balance');
  });

  await t.test('ages by days past due', async () => {
    const r = await run(def);
    assert.deepEqual(r.columns.map((c) => c.label), ['Current', '1–30', '31–60', '61–90', 'Over 90', 'Total']);
    assert.deepEqual(dollars(line(r, 'Bill A1')), [100, 0, 0, 0, 0, 100]);
    assert.deepEqual(dollars(line(r, 'Bill A2')), [0, 200, 0, 0, 0, 200]);
    assert.deepEqual(dollars(line(r, 'Bill A3')), [0, 0, 0, 0, 250, 250], 'balance as of the date');
    assert.deepEqual(dollars(line(r, 'Bill B1')), [0, 0, 0, 400, 0, 400]);
    assert.equal(line(r, 'Bill B2'), undefined);
    assert.deepEqual(dollars(line(r, 'Total Acme')), [100, 200, 0, 0, 250, 550]);
    assert.deepEqual(dollars(line(r, 'Total Unpaid Bills')), [100, 200, 0, 400, 250, 950]);
    assert.equal(line(r, 'Bill A1').link.startsWith('/bills/'), true);
    assert.equal(line(r, 'Acme').type, 'subheader');
  });

  await t.test('options: summary by vendor, bill-date aging, interval, funds', async () => {
    const summary = await run({ ...def, options: { ...def.options, showBills: false } });
    assert.deepEqual(summary.lines.filter((l) => l.type === 'account').map((l) => [l.label, l.values.at(-1) / 100]), [['Acme', 550], ['Bolt Co', 400]]);
    const byBill = await run({ ...def, options: { ...def.options, agingBasis: 'bill_date' } });
    assert.deepEqual(byBill.columns.map((c) => c.label), ['0–30', '31–60', '61–90', 'Over 90', 'Total']);
    assert.deepEqual(dollars(line(byBill, 'Bill A2')), [0, 200, 0, 0, 200], '60 days since the bill');
    const weekly = await run({ ...def, options: { ...def.options, interval: 7, periods: 2 } });
    assert.deepEqual(weekly.columns.map((c) => c.label), ['Current', '1–7', '8–14', 'Over 14', 'Total']);
    const youthOnly = await run({ ...def, fundFilter: [String(youth)] });
    assert.deepEqual(dollars(line(youthOnly, 'Total Unpaid Bills')), [0, 0, 0, 400, 0, 400]);
    // After the July payment A3 is paid in full
    const later = await run(def, '2026-07-31');
    assert.equal(line(later, 'Bill A3'), undefined);
  });

  await t.test('saves options', async () => {
    const saved = await admin.put(`/reports/${rep.id}`, { name: rep.name, definition: { ...def, options: { ...def.options, interval: 45, periods: 99, agingBasis: 'nope' } } });
    assert.deepEqual(saved.definition.options, { showBills: true, agingBasis: 'due_date', interval: 45, periods: 3 });
    await admin.post(`/reports/${rep.id}/reset`);
  });
});
