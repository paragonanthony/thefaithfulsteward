// Funds come from the detail lines (no header fund): the bank / A/P side, deposits and bill payments follow them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_fund_lines'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);

test('funds follow the detail lines', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Fund Lines Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, undeposited, ap, contributions, grants, rent, office] = ['1000', '1050', '2100', '4000', '4100', '5200', '5300'].map(a);
  const general = lk.funds[0].id;
  const youth = (await admin.post('/funds', { name: 'Youth' })).id;
  const vendor = (await admin.post('/companies', { name: 'Vendor' })).id;
  const glBy = (gl, accountName) => gl.filter((g) => g.account_name === accountName).map((g) => [cents(g.debit) - cents(g.credit), g.fund_name]);

  let inc;
  await t.test('income without a header fund: the bank side is split by the lines', async () => {
    inc = (await admin.post('/income', { date: '2026-05-01', amount: 500, accountId: undeposited, lines: [{ accountId: contributions, amount: 300, fundId: general }, { accountId: grants, amount: 200, fundId: youth }] })).id;
    const r = await admin.get(`/income/${inc}`);
    assert.equal(r.fund_id, null, 'mixed funds: no single fund');
    assert.deepEqual(glBy(r.gl, 'Undeposited Funds'), [[30000, 'General Fund'], [20000, 'Youth']]);
    const one = (await admin.post('/expenses', { date: '2026-05-02', amount: 40, accountId: checking, lines: [{ accountId: office, amount: 40, fundId: youth }] })).id;
    assert.equal((await admin.get(`/expenses/${one}`)).fund_id, youth, 'one fund: the transaction takes it');
  });

  await t.test('a deposit moves each fund’s part to the bank', async () => {
    const dep = (await admin.post('/deposits', { date: '2026-05-03', accountId: checking, incomeIds: [inc] })).id;
    const r = await admin.get(`/deposits/${dep}`);
    assert.deepEqual(glBy(r.gl, 'Operating Checking'), [[30000, 'General Fund'], [20000, 'Youth']]);
    assert.deepEqual(glBy(r.gl, 'Undeposited Funds'), [[-30000, 'General Fund'], [-20000, 'Youth']]);
  });

  await t.test('a header fund (imports, API) is still the default for lines without one', async () => {
    const id = (await admin.post('/expenses', { date: '2026-05-04', amount: 25, accountId: checking, fundId: youth, lines: [{ accountId: office, amount: 25 }] })).id;
    const r = await admin.get(`/expenses/${id}`);
    assert.deepEqual([r.lines[0].fund_id, r.fund_id], [youth, youth]);
  });

  await t.test('a payment on a bill with two funds pays down each fund in proportion', async () => {
    const bill = (await admin.post('/bills', { date: '2026-05-05', companyId: vendor, accountId: ap, amount: 300, lines: [{ accountId: rent, amount: 200, fundId: general }, { accountId: office, amount: 100, fundId: youth }] })).id;
    assert.deepEqual(glBy((await admin.get(`/bills/${bill}`)).gl, 'Accounts Payable'), [[-20000, 'General Fund'], [-10000, 'Youth']]);
    const pay = (await admin.post('/bill-payments', { companyId: vendor, date: '2026-05-06', accountId: checking, payments: [{ billId: bill, amount: 100 }] })).id;
    const p = await admin.get(`/expenses/${pay}`);
    assert.deepEqual(p.lines.map((l) => [l.bill_id, cents(l.amount), l.fund_id]), [[bill, 6667, general], [bill, 3333, youth]]);
    assert.deepEqual(glBy(p.gl, 'Operating Checking'), [[-6667, 'General Fund'], [-3333, 'Youth']]);
    assert.equal((await admin.get(`/bills/${bill}`)).balance, '200.00');
    // Paying the rest clears both funds' payables
    await admin.post('/bill-payments', { companyId: vendor, date: '2026-05-07', accountId: checking, payments: [{ billId: bill, amount: 200 }] });
    const bs = await admin.post('/reports/run', { definition: { type: 'trial_balance' }, to: '2026-05-31' });
    assert.equal(bs.lines.find((l) => /Accounts Payable/.test(l.label)), undefined, 'A/P is zero');
  });

  await t.test('every fund stays in balance (no interfund line on the Balance Sheet by Fund)', async () => {
    const reps = await admin.get('/reports');
    const def = (await admin.get(`/reports/${reps.find((r) => r.builtin_key === 'balance_sheet_by_fund').id}`)).definition;
    const r = await admin.post('/reports/run', { definition: def, to: '2026-05-31' });
    assert.equal(r.lines.find((l) => /Interfund/.test(l.label || '')), undefined);
  });

  await t.test('the Fund Balances report shows each fund’s balance by balance sheet account', async () => {
    const reps = await admin.get('/reports');
    const def = (await admin.get(`/reports/${reps.find((r) => r.builtin_key === 'fund_balances').id}`)).definition;
    const r = await admin.post('/reports/run', { definition: def, to: '2026-05-31' });
    const labels = r.columns.map((c) => c.label);
    const row = (re) => r.lines.find((l) => re.test(l.label || ''));
    const val = (line, col) => Math.round(line.values[labels.indexOf(col)]); // report values are in cents
    const cash = row(/Operating Checking/);
    // Checking: +500 deposit, -40 and -25 expenses (Youth), -100 and -200 bill payments split 2:1
    assert.deepEqual([val(cash, 'General Fund'), val(cash, 'Youth')], [30000 - 6667 - 13333, 20000 - 4000 - 2500 - 3333 - 6667]);
    // The bills are paid, so there are no liabilities: each fund's balance is its share of the assets.
    assert.equal(row(/^Total Liabilities$/), undefined);
    assert.deepEqual(row(/^Fund Balance$/).values, row(/^Total Assets$/).values);
    assert.equal(row(/Net Assets Accounts/), undefined);
  });
});
