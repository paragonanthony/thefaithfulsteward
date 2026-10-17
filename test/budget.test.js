// Budget and Budget to Actual report tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_budget'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);
const months = (from, n) => Array.from({ length: n }, (_, i) => {
  const [y, m] = from.split('-').map(Number);
  const t = y * 12 + (m - 1) + i;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
});

test('budgets', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Budget Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Budget Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const byNum = (n) => lk.accounts.find((a) => a.account_number === n);
  const [checking, savings, contributions, rent] = ['1000', '1010', '4000', '5200'].map((n) => byNum(n).id);
  const name = (id) => lk.accounts.find((a) => a.id === id).name;
  const general = lk.funds[0].id;
  const youth = (await admin.post('/funds', { name: 'Youth Program' })).id;

  // Actuals: last year +1000; this year +1500 (general), +800 (youth), rent 450.
  const income = (date, amount, fundId = general) => admin.post('/income', { date, amount, accountId: checking, fundId, lines: [{ accountId: contributions, amount, fundId }] });
  await income('2025-06-01', 1000);
  await income('2026-01-15', 1500);
  await income('2026-02-10', 800, youth);
  await admin.post('/expenses', { date: '2026-01-05', amount: 450, accountId: checking, fundId: general, lines: [{ accountId: rent, amount: 450, fundId: general }] });

  const fyLines = [
    ...months('2026-01', 12).map((month) => ({ accountId: contributions, month, amount: 1000 })),
    ...months('2026-01', 12).map((month) => ({ accountId: rent, month, amount: 400 })),
    ...months('2026-01', 12).map((month) => ({ accountId: savings, month, amount: 100 })),
  ];
  let fy;
  await t.test('creates an overall budget with monthly amounts', async () => {
    fy = (await admin.post('/budgets', { name: 'FY 2026', startDate: '2026-01-01', endDate: '2026-12-31', lines: fyLines })).id;
    const b = await admin.get(`/budgets/${fy}`);
    assert.deepEqual([b.name, b.start_date, b.end_date, b.fund_id, b.lines.length], ['FY 2026', '2026-01-01', '2026-12-31', null, 36]);
    const list = await admin.get('/budgets');
    assert.deepEqual([cents(list[0].income), cents(list[0].expense), cents(list[0].net)], [1200000, 480000, 720000]);
  });

  await t.test('validation', async () => {
    const b = { name: 'X', startDate: '2026-01-01', endDate: '2026-12-31' };
    await assert.rejects(admin.post('/budgets', { ...b, name: ' ' }), /name is required/);
    await assert.rejects(admin.post('/budgets', { ...b, endDate: '2025-12-31' }), /on or after the start/);
    await assert.rejects(admin.post('/budgets', { ...b, endDate: '2031-12-31' }), /at most 60 months/);
    await assert.rejects(admin.post('/budgets', { ...b, lines: [{ accountId: rent, month: '2027-01', amount: 5 }] }), /outside the budget dates/);
    await assert.rejects(admin.post('/budgets', { ...b, lines: [{ accountId: rent, month: '2026-01', amount: 5 }, { accountId: rent, month: '2026-01-01', amount: 6 }] }), /Duplicate/);
    await assert.rejects(admin.post('/budgets', { ...b, name: 'fy 2026' }), /already exists/);
  });

  let youthBudget;
  await t.test('fund budgets', async () => {
    youthBudget = (await admin.post('/budgets', {
      name: 'Youth H1', startDate: '2026-01-01', endDate: '2026-06-30', fundId: youth,
      lines: months('2026-01', 6).map((month) => ({ accountId: contributions, month: month.slice(0, 7), amount: 500 })),
    })).id;
    const b = await admin.get(`/budgets/${youthBudget}`);
    assert.deepEqual([b.fund_id, b.fund_name, b.lines.length], [youth, 'Youth Program', 6]);
    const unused = (await admin.post('/funds', { name: 'Capital Campaign' })).id;
    const cap = (await admin.post('/budgets', { name: 'Campaign', startDate: '2026-01-01', endDate: '2026-12-31', fundId: unused })).id;
    await assert.rejects(admin.del(`/funds/${unused}`), /fund budget \(Campaign\)/);
    await admin.del(`/budgets/${cap}`);
    await admin.del(`/funds/${unused}`);
  });

  const list = await admin.get('/reports');
  const pnlId = list.find((r) => r.builtin_key === 'pnl_budget').id;
  const bsId = list.find((r) => r.builtin_key === 'balance_sheet_budget').id;
  const pnlDef = (await admin.get(`/reports/${pnlId}`)).definition;
  const bsDef = (await admin.get(`/reports/${bsId}`)).definition;
  const run = (definition, from, to, budgetId) => admin.post('/reports/run', { definition, from, to, budgetId });
  const row = (r, label) => r.lines.find((l) => l.label === label || l.label?.endsWith(`· ${label}`));
  const vals = (l) => l.values.map((v, i) => (i < 3 ? v : v === null ? null : Math.round(v * 100) / 100));

  await t.test('standard Budget to Actual reports', async () => {
    assert.equal(pnlDef.columns.mode, 'budget');
    assert.equal(bsDef.type, 'balance_sheet');
    assert.equal(list.filter((r) => r.builtin_key).at(-1).builtin_key, 'trial_balance');
  });

  await t.test('Profit and Loss budget to actual', async () => {
    const r = await run(pnlDef, '2026-01-01', '2026-02-28', fy);
    assert.deepEqual(r.columns.map((c) => c.label), ['Actual', 'Budget', '$ Over / (Under) Budget', '% of Budget']);
    assert.deepEqual(r.columns.map((c) => c.budget || false), [false, true, false, false]);
    assert.equal(r.budget.name, 'FY 2026');
    assert.deepEqual(vals(row(r, name(contributions))), [230000, 200000, 30000, 115]);
    assert.deepEqual(vals(row(r, name(rent))), [45000, 80000, -35000, 56.25]);
    assert.deepEqual(vals(row(r, 'Change in Net Assets')).slice(0, 3), [185000, 120000, 65000]);
  });

  await t.test('partial months are prorated by day', async () => {
    const r = await run(pnlDef, '2026-01-01', '2026-01-15', fy);
    assert.equal(row(r, name(contributions)).values[1], Math.round(100000 * 15 / 31));
    // Outside the budget dates the budget is zero.
    const before = await run(pnlDef, '2025-06-01', '2025-06-30', fy);
    assert.deepEqual(row(before, name(contributions)).values.slice(0, 2), [100000, 0]);
  });

  await t.test('a fund budget compares to that fund only', async () => {
    const r = await run(pnlDef, '2026-01-01', '2026-02-28', youthBudget);
    assert.deepEqual(r.budget.fund_name, 'Youth Program');
    assert.deepEqual(vals(row(r, name(contributions))), [80000, 100000, -20000, 80]);
    assert.equal(row(r, name(rent)), undefined, 'no youth rent');
  });

  await t.test('picks a budget covering the report date when none is chosen', async () => {
    assert.equal((await run(pnlDef, '2026-01-01', '2026-02-28')).budget.id, fy);
    assert.equal((await run({ ...pnlDef, columns: { ...pnlDef.columns, budgetId: youthBudget } }, '2026-01-01', '2026-02-28')).budget.id, youthBudget);
  });

  await t.test('Balance Sheet budget to actual', async () => {
    const r = await run(bsDef, null, '2026-02-28', fy);
    // Checking: actual 1000 + 1500 + 800 - 450; budget = actual balance before the budget start (no planned change)
    assert.deepEqual(row(r, name(checking)).values.slice(0, 3), [285000, 100000, 185000]);
    assert.deepEqual(row(r, name(savings)).values.slice(0, 2), [0, 20000]);
    assert.deepEqual(row(r, 'Accumulated Change in Net Assets (Prior Years)').values.slice(0, 2), [100000, 100000]);
    assert.deepEqual(row(r, 'Change in Net Assets (Current Year)').values.slice(0, 2), [185000, 120000]);
    assert.equal(r.subtitle, 'As of Feb 28, 2026');
  });

  await t.test('copy to a new year and start from last year\'s actuals', async () => {
    const copy = (await admin.post(`/budgets/${fy}/copy`, { name: 'FY 2027', startDate: '2027-01-01' })).id;
    const b = await admin.get(`/budgets/${copy}`);
    assert.deepEqual([b.start_date, b.end_date, b.lines.length, b.lines[0].month], ['2027-01-01', '2027-12-31', 36, '2027-01-01']);
    const act = await admin.get('/budgets/actuals?startDate=2027-01-01&endDate=2027-12-31');
    const contrib = act.filter((l) => l.accountId === contributions).map((l) => [l.month, cents(l.amount)]).sort();
    assert.deepEqual(contrib, [['2027-01-01', 150000], ['2027-02-01', 80000]]);
    assert.deepEqual(act.find((l) => l.accountId === rent).amount, '450.00');
    const youthAct = await admin.get(`/budgets/actuals?startDate=2027-01-01&endDate=2027-12-31&fundId=${youth}`);
    assert.deepEqual(youthAct.filter((l) => l.accountId === contributions).map((l) => l.month), ['2027-02-01']);
  });

  await t.test('shortening a budget drops months outside its dates', async () => {
    await admin.put(`/budgets/${fy}`, { name: 'FY 2026', startDate: '2026-01-01', endDate: '2026-06-30' });
    assert.equal((await admin.get(`/budgets/${fy}`)).lines.length, 18);
  });

  await t.test('private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/budgets/${fy}`), /not found/);
    await assert.rejects(admin.post('/reports/run', { definition: pnlDef, from: '2026-01-01', to: '2026-02-28', budgetId: fy }), /not found/);
    await assert.rejects(admin.post('/reports/run', { definition: pnlDef, from: '2026-01-01', to: '2026-02-28' }), /no budgets yet/);
    await assert.rejects(admin.post('/budgets', { name: 'Y', startDate: '2026-01-01', endDate: '2026-12-31', fundId: youth }), /Invalid fund/);
    await assert.rejects(admin.post('/budgets', { name: 'Y', startDate: '2026-01-01', endDate: '2026-12-31', lines: [{ accountId: rent, month: '2026-01', amount: 1 }] }), /Invalid account/);
    assert.deepEqual(await admin.get('/budgets'), []);
    await assert.rejects(admin.del(`/budgets/${fy}`), /not found/);
    await admin.post('/auth/select-org', { organizationId: org.id });
  });

  await t.test('delete', async () => {
    await admin.del(`/budgets/${youthBudget}`);
    assert.deepEqual((await admin.get('/budgets')).map((b) => b.name).sort(), ['FY 2026', 'FY 2027']);
  });
});
