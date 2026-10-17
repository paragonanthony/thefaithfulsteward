// List paging: ?page=N returns 500 rows plus the total and totals over every matching row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_paging'); });
after(async () => { await app?.stop(); });

test('list paging', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Paging Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const checking = lk.accounts.find((a) => a.account_number === '1000').id;

  // 1,203 expenses of $1.00 to $1,203.00 on dates through 2026
  const N = 1203;
  const day = (i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
  await admin.post('/import/transactions', {
    rows: Array.from({ length: N }, (_, i) => ({ date: day(i), type: 'Expense', headerAccount: 'Operating Checking', detailAccount: 'Office Supplies', amount: String(i + 1), customer: `Vendor ${String(i).padStart(4, '0')}`, description: `Item ${i}` })),
    fileName: 'many.csv',
  });
  const sumAll = (N * (N + 1)) / 2;

  await t.test('pages of 500 with the total and the sum over every row', async () => {
    const p1 = await admin.get('/expenses?from=2026-01-01&to=2026-12-31&page=1');
    assert.deepEqual([p1.rows.length, p1.total, p1.page, p1.pageSize, Number(p1.totals.amount)], [500, N, 1, 500, sumAll]);
    const p3 = await admin.get('/expenses?from=2026-01-01&to=2026-12-31&page=3');
    assert.deepEqual([p3.rows.length, p3.total], [203, N]);
    const p2 = await admin.get('/expenses?from=2026-01-01&to=2026-12-31&page=2');
    const ids = new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id));
    assert.equal(ids.size, N, 'every row on exactly one page');
    assert.ok(p1.rows[0].date >= p2.rows[0].date && p2.rows[0].date >= p3.rows[0].date, 'newest first across pages');
    const beyond = await admin.get('/expenses?from=2026-01-01&to=2026-12-31&page=9');
    assert.deepEqual([beyond.rows.length, beyond.total], [0, N]);
    // Filters apply before paging
    const one = await admin.get('/expenses?from=2026-01-01&to=2026-12-31&search=Vendor%200007&page=1');
    assert.deepEqual([one.total, one.rows.length, one.totals.amount], [1, 1, '8.00']);
    // Without ?page, the usual plain array (newest 1,000)
    const legacy = await admin.get('/expenses?from=2026-01-01&to=2026-12-31');
    assert.ok(Array.isArray(legacy));
    assert.equal(legacy.length, 1000);
  });

  await t.test('sorting by a column applies across all pages', async () => {
    const base = '/expenses?from=2026-01-01&to=2026-12-31';
    const up = await admin.get(`${base}&sort=amount&dir=asc&page=1`);
    const down = await admin.get(`${base}&sort=amount&dir=desc&page=1`);
    const last = await admin.get(`${base}&sort=amount&dir=asc&page=3`);
    assert.deepEqual([Number(up.rows[0].amount), Number(down.rows[0].amount), Number(last.rows.at(-1).amount)], [1, N, N]);
    assert.equal(up.total, N);
    const byName = await admin.get(`${base}&sort=company&dir=desc&page=1`);
    assert.equal(byName.rows[0].company_name, 'Vendor 1202');
    // Unknown sort keys fall back to the usual order (newest first) rather than reaching the SQL
    const odd = await admin.get(`${base}&sort=amount;DROP TABLE x&dir=asc&page=1`);
    assert.ok(odd.rows[0].date >= odd.rows.at(-1).date);
    const names = await admin.get('/companies?sort=name&dir=desc&page=1');
    assert.equal(names.rows[0].name, 'Vendor 1202');
  });

  await t.test('customers / vendors page by name', async () => {
    const p1 = await admin.get('/companies?page=1');
    const p3 = await admin.get('/companies?page=3');
    assert.deepEqual([p1.rows.length, p1.total, p3.rows.length], [500, N, 203]);
    assert.equal(p1.rows[0].name, 'Vendor 0000');
    assert.equal(p3.rows.at(-1).name, 'Vendor 1202');
    assert.equal((await admin.get('/companies')).length, 500, 'unpaged list stays capped');
  });

  await t.test('bills and deposits carry their totals', async () => {
    const vendor = lk.companies?.[0]?.id || (await admin.post('/companies', { name: 'Billing Co' })).id;
    const ap = lk.accounts.find((a) => a.account_number === '2100').id;
    const office = lk.accounts.find((a) => a.account_number === '5300').id;
    await admin.post('/bills', { date: '2026-01-10', dueDate: '2026-02-01', companyId: vendor, accountId: ap, amount: 100, lines: [{ accountId: office, amount: 100 }] });
    await admin.post('/bills', { date: '2026-01-11', dueDate: '2099-01-01', companyId: vendor, accountId: ap, amount: 50, lines: [{ accountId: office, amount: 50 }] });
    const b = await admin.get('/bills?status=open&page=1');
    assert.deepEqual([b.total, b.totals.balance, b.totals.overdue, b.totals.overdueCount], [2, '150.00', '100.00', '1']);
    const d = await admin.get('/deposits?from=2026-01-01&to=2026-12-31&page=1');
    assert.deepEqual([d.total, d.totals.amount], [0, '0.00']);
  });

  await t.test('bank feed lines page within a tab', async () => {
    await admin.post('/bank-feed/import', { accountId: checking, items: Array.from({ length: 620 }, (_, i) => ({ date: day(i), description: `LINE ${i}`, amount: -(i + 1) })) });
    const p1 = await admin.get(`/bank-feed?accountId=${checking}&status=unmatched&page=1`);
    const p2 = await admin.get(`/bank-feed?accountId=${checking}&status=unmatched&page=2`);
    assert.deepEqual([p1.items.length, p2.items.length, p1.total, p1.counts.unmatched], [500, 120, 620, 620]);
    assert.ok(p1.items[0].suggestions, 'suggested matches for the lines on the page');
    const small = await admin.get(`/bank-feed?accountId=${checking}&status=unmatched&page=2&pageSize=50`);
    assert.deepEqual([small.items.length, small.pageSize, small.total], [50, 50, 620], 'the Bank Feed screen asks for 50 a page');
    assert.equal(small.unassigned, 620, 'unassigned counts every Not Matched line, not just the page');
    const big = await admin.get(`/bank-feed?accountId=${checking}&status=unmatched&page=1&sort=amount&dir=asc`);
    assert.equal(Number(big.items[0].amount), -620, 'most money out first');
    assert.equal((await admin.get(`/bank-feed?accountId=${checking}&status=unmatched`)).items.length, 620, 'unpaged: newest 1,000');
  });
});
