// Integration tests. Requires a PostgreSQL server; by default uses the dev server from `npm run dev:db`.
// A fresh database (npacct_test) is created for each run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test'); });
after(async () => { await app?.stop(); });

const find = (list, pred) => { const x = list.find(pred); assert.ok(x, 'expected item not found'); return x; };
const line = (report, label) => report.lines.find((l) => l.label === label || l.label?.endsWith(`· ${label}`));
const cents = (n) => Math.round(n * 100);

test('end-to-end accounting flow', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });

  const orgA = await admin.post('/admin/organizations', { name: 'Org A', fiscalYearStartMonth: 1 });
  const orgB = await admin.post('/admin/organizations', { name: 'Org B' });
  await admin.post('/auth/select-org', { organizationId: orgA.id });

  const lk = await admin.get('/lookups');
  const acct = (num) => find(lk.accounts, (a) => a.account_number === num).id;
  const checking = acct('1000');
  const undeposited = acct('1050');
  const contributions = acct('4000');
  const grants = acct('4100');
  const supplies = acct('5100');
  const bankFees = acct('5500');
  const interestInc = acct('4900');
  const general = find(lk.funds, (f) => f.name === 'General Fund').id;
  const youth = (await admin.post('/funds', { name: 'Youth Program', is_restricted: true })).id;
  const donor = (await admin.post('/companies', { name: 'Jane Donor', default_income_account_id: contributions })).id;
  const vendor = (await admin.post('/companies', { name: 'Office Depot', default_expense_account_id: supplies })).id;

  await t.test('income must balance', async () => {
    await assert.rejects(admin.post('/income', {
      date: '2025-02-01', amount: 100, accountId: checking, lines: [{ accountId: contributions, amount: 90 }],
    }), /must be equal/);
  });

  let income1, income2, expense1;
  await t.test('record income and expense with GL', async () => {
    income1 = (await admin.post('/income', {
      date: '2025-02-01', amount: 500, accountId: undeposited, fundId: general, companyId: donor, method: 'check', checkNumber: '101',
      lines: [{ accountId: contributions, amount: 300, fundId: general }, { accountId: grants, amount: 200, fundId: youth }],
    })).id;
    income2 = (await admin.post('/income', {
      date: '2025-02-03', amount: 250, accountId: undeposited, fundId: youth, companyId: donor,
      lines: [{ accountId: contributions, amount: 250, fundId: youth }],
    })).id;
    expense1 = (await admin.post('/expenses', {
      date: '2025-02-10', amount: 120.55, accountId: checking, fundId: youth, companyId: vendor, method: 'check', checkNumber: '5001',
      lines: [{ accountId: supplies, amount: 120.55, fundId: youth }],
    })).id;
    const inc = await admin.get(`/income/${income1}`);
    const dr = inc.gl.reduce((s, g) => s + cents(g.debit), 0);
    const cr = inc.gl.reduce((s, g) => s + cents(g.credit), 0);
    assert.equal(dr, 50000);
    assert.equal(cr, 50000);
    // The bank side is split by the lines' funds: 300 General + 200 Youth, matching the credits.
    assert.deepEqual(inc.gl.filter((g) => cents(g.debit)).map((g) => [cents(g.debit), g.fund_name]), [[30000, 'General Fund'], [20000, 'Youth Program']]);
    assert.equal(inc.gl.length, 4);
  });

  let deposit;
  await t.test('deposit undeposited funds', async () => {
    const und = await admin.get('/undeposited-funds');
    assert.equal(und.length, 2);
    deposit = (await admin.post('/deposits', { date: '2025-02-05', accountId: checking, incomeIds: [income1, income2] })).id;
    const dep = await admin.get(`/deposits/${deposit}`);
    assert.equal(cents(dep.amount), 75000);
    assert.equal((await admin.get('/undeposited-funds')).length, 0);
    await assert.rejects(admin.del(`/income/${income1}`), /deposited/);
    await assert.rejects(admin.put(`/income/${income1}`, {
      date: '2025-02-01', amount: 400, accountId: undeposited, lines: [{ accountId: contributions, amount: 400 }],
    }), /deposited/);
  });

  await t.test('register shows running balance', async () => {
    const reg = await admin.get(`/register?accountId=${checking}`);
    assert.equal(reg.endingBalance, 750 - 120.55);
    const und = await admin.get(`/register?accountId=${undeposited}`);
    assert.equal(und.endingBalance, 0);
  });

  await t.test('reconciliation with service charge and interest', async () => {
    const start = await admin.get(`/reconciliations/start?accountId=${checking}`);
    assert.equal(start.beginningBalance, 0);
    assert.equal(start.transactions.length, 2);
    const body = {
      accountId: checking, statementDate: '2025-02-28', statementEndingBalance: 750 - 120.55 - 5 + 1.25,
      serviceCharge: { amount: 5, date: '2025-02-28', accountId: bankFees, fundId: general },
      interest: { amount: 1.25, date: '2025-02-28', accountId: interestInc, fundId: general },
      clearedIds: [deposit],
    };
    await assert.rejects(admin.post('/reconciliations', { ...body, complete: true }), /Difference/);
    const rec = (await admin.post('/reconciliations', body)).id;
    await admin.put(`/reconciliations/${rec}`, { ...body, clearedIds: [deposit, expense1], complete: true });
    await assert.rejects(admin.del(`/expenses/${expense1}`), /reconciliation/);
    const next = await admin.get(`/reconciliations/start?accountId=${checking}`);
    assert.equal(next.beginningBalance, 625.7);
    assert.equal(next.transactions.length, 0);
  });

  await t.test('profit and loss + balance sheet', async () => {
    const reports = await admin.get('/reports');
    const pnl = await admin.get(`/reports/${find(reports, (r) => r.builtin_key === 'pnl').id}`);
    const res = await admin.post('/reports/run', { definition: pnl.definition, from: '2025-01-01', to: '2025-12-31' });
    assert.equal(cents(line(res, 'Total Income').values[0]) / 100, 75000);
    assert.equal(line(res, 'Total Expenses').values[0], 12055 + 500);
    assert.equal(line(res, 'Change in Net Assets').values[0], 75000 - 12555 + 125);

    const bsDef = (await admin.get(`/reports/${find(reports, (r) => r.builtin_key === 'balance_sheet').id}`)).definition;
    const bs = await admin.post('/reports/run', { definition: bsDef, to: '2025-12-31' });
    assert.equal(line(bs, 'Total Assets').values[0], 62570);
    assert.equal(line(bs, 'Total Liabilities and Net Assets').values[0], 62570);
  });

  await t.test('by-fund reports balance per fund', async () => {
    const reports = await admin.get('/reports');
    const pf = await admin.get(`/reports/${find(reports, (r) => r.builtin_key === 'pnl_by_fund').id}`);
    const res = await admin.post('/reports/run', { definition: pf.definition, from: '2025-01-01', to: '2025-12-31' });
    const cols = res.columns.map((c) => c.label);
    assert.deepEqual(cols, ['General Fund', 'Youth Program', 'Total']);
    const net = line(res, 'Change in Net Assets').values;
    assert.equal(net[0], 30000 - 500 + 125);
    assert.equal(net[1], 20000 + 25000 - 12055);
    assert.equal(net[2], net[0] + net[1]);

    const bf = await admin.get(`/reports/${find(reports, (r) => r.builtin_key === 'balance_sheet_by_fund').id}`);
    const bs = await admin.post('/reports/run', { definition: bf.definition, to: '2025-12-31' });
    const assets = line(bs, 'Total Assets').values;
    const tle = line(bs, 'Total Liabilities and Net Assets').values;
    assert.deepEqual(assets, tle);
  });

  await t.test('custom report with formula, groups and month columns', async () => {
    const def = {
      type: 'pnl', columns: { mode: 'month', includeTotal: true }, options: { percentOf: 'inc' },
      rows: [
        { id: 'inc', kind: 'accounts', label: 'Revenue', filter: { categories: ['income'] }, display: 'by_group', showHeader: true, showTotal: true },
        { id: 'exp', kind: 'accounts', label: 'Spending', filter: { categories: ['expense'] }, display: 'groups', showHeader: true, showTotal: true },
        { id: 'margin', kind: 'formula', label: 'Margin', formula: '(inc - exp) * 1', style: 'grand' },
      ],
    };
    const saved = await admin.post('/reports', { name: 'My Report', definition: def });
    const res = await admin.post('/reports/run', { definition: saved.definition, from: '2025-01-01', to: '2025-03-31' });
    assert.deepEqual(res.columns.map((c) => c.label), ['Jan 2025', 'Feb 2025', 'Mar 2025', 'Total']);
    assert.equal(line(res, 'Margin').values[3], 75125 - 12555);
    assert.equal(line(res, 'Total Revenue').percents[3], 100);
    await assert.rejects(admin.post('/reports', { name: 'Bad', definition: { ...def, rows: [{ id: 'x', kind: 'formula', formula: 'nope + 1' }] } }), /unknown row/);
    await assert.rejects(admin.del(`/reports/${find(await admin.get('/reports'), (r) => r.builtin_key === 'pnl').id}`), /cannot be deleted/);
    const dd = await admin.post('/reports/drilldown', { accountIds: [supplies], from: '2025-01-01', to: '2025-12-31' });
    assert.equal(dd.length, 1);
  });

  await t.test('bank feed import and match', async () => {
    const imp = await admin.post('/bank-feed/import', { accountId: checking, items: [
      { date: '2025-02-11', description: 'CHECK 5001', amount: -120.55 },
      { date: '2025-02-20', description: 'MYSTERY', amount: 42 },
    ] });
    assert.equal(imp.imported, 2);
    const again = await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2025-02-11', description: 'CHECK 5001', amount: -120.55 }] });
    assert.equal(again.skipped, 1);
    const feed = await admin.get(`/bank-feed?accountId=${checking}`);
    const item = find(feed.items, (i) => i.description === 'CHECK 5001');
    assert.equal(item.suggestions[0].id, expense1);
    await admin.post(`/bank-feed/${item.id}/match`, { transactionId: expense1 });
    const other = find(feed.items, (i) => i.description === 'MYSTERY');
    await assert.rejects(admin.post(`/bank-feed/${other.id}/match`, { transactionId: expense1 }), /amount does not match/);
    const created = await admin.post('/income', { date: '2025-02-20', amount: 42, accountId: checking, bankFeedItemId: other.id, lines: [{ accountId: contributions, amount: 42 }] });
    assert.ok(created.id);
    const matched = await admin.get(`/bank-feed?accountId=${checking}&status=matched`);
    assert.equal(matched.items.length, 2);
  });

  await t.test('tenant isolation', async () => {
    await admin.post('/admin/users', { username: 'bob', password: 'bob-password', displayName: 'Bob', role: 'user' });
    const bob = app.client();
    await bob.post('/auth/login', { username: 'bob', password: 'bob-password' });
    const me = await bob.get('/auth/me');
    assert.equal(me.currentOrganization.id, orgA.id); // auto-selected the only org
    await assert.rejects(bob.post('/auth/select-org', { organizationId: orgB.id }), /not assigned/);
    await assert.rejects(bob.get('/admin/users'), /administrator/);

    // Admin switches to org B and tries to use org A's accounts.
    await admin.post('/auth/select-org', { organizationId: orgB.id });
    await assert.rejects(admin.post('/income', { date: '2025-01-01', amount: 1, accountId: checking, lines: [{ accountId: contributions, amount: 1 }] }), /Invalid account/);
    await assert.rejects(admin.get(`/income/${income1}`), /not found/);
    const reg = admin.get(`/register?accountId=${checking}`);
    await assert.rejects(reg, /Invalid account/);
    assert.equal((await admin.get('/income')).length, 0);
  });
});
