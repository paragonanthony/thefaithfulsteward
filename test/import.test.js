// Transaction import tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_import'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);
const row = (over) => ({
  date: '2026-05-01', type: 'Income', headerAccount: 'Operating Checking', detailAccount: 'Individual Contributions',
  amount: '100.00', fund: 'General Fund', description: 'Gift', customer: 'Jane Donor', ...over,
});

test('importing transactions', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Import Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  await admin.post('/funds', { name: 'Youth Program' });
  const existingVendor = (await admin.post('/companies', { name: 'Office Depot' })).id;

  const rows = [
    row({}),
    row({ date: '5/2/2026', type: 'expense', headerAccount: 'operating checking', detailAccount: 'Office Supplies', amount: '$1,234.50', fund: 'youth program', description: 'Paper', customer: 'office depot' }),
    row({ date: '2026-05-03', amount: 25, customer: 'jane donor', fund: '' }),
    row({ date: '2026-05-04', type: 'Expense', headerAccount: 'Credit Card', detailAccount: 'Program Supplies', amount: '60', customer: 'Costco' }),
    row({ date: 'May 5', type: 'Transfer', headerAccount: 'Nope', detailAccount: '', amount: '-5', fund: 'Missing Fund' }),
    row({ headerAccount: 'Individual Contributions' }),
    row({ date: '2026-05-06', customer: '', amount: '10' }),
    row({ date: '2026-05-07', headerAccount: '1000', detailAccount: '4100', amount: '15' }),
  ];

  let preview;
  await t.test('preview validates every row and lists new names', async () => {
    preview = await admin.post('/import/transactions/preview', { rows });
    const r = preview.results;
    assert.deepEqual(r.map((x) => x.status), ['ok', 'ok', 'ok', 'ok', 'error', 'error', 'ok', 'ok']);
    assert.deepEqual(r[1].parsed && [r[1].parsed.type, r[1].parsed.amount, r[1].parsed.fund, r[1].parsed.customer, r[1].parsed.createCompany], ['expense', 123450, 'Youth Program', 'Office Depot', false]);
    assert.equal(r[2].parsed.companyId, null, 'same new name in two rows is created once');
    assert.equal(r[2].parsed.fundId, null);
    const bad = r[4].errors.join(' | ');
    for (const msg of ['not a valid date', 'must be Income or Expense', 'greater than zero', 'Header account "Nope" was not found', 'Detail Account is required', 'Fund "Missing Fund" was not found']) {
      assert.ok(bad.includes(msg), `expected "${msg}" in ${bad}`);
    }
    assert.match(r[5].errors[0], /must be a Bank or Credit Card account/);
    assert.equal(r[7].parsed.headerAccount, 'Operating Checking', 'account number accepted as a fallback');
    assert.deepEqual(preview.newCompanies.sort(), ['Costco', 'Jane Donor']);
    assert.deepEqual(preview.summary, { total: 8, ok: 6, duplicates: 0, errors: 2, income: 150, expense: 1294.5 });
    assert.equal((await admin.get('/income')).length, 0, 'preview saves nothing');
  });

  let batchId;
  await t.test('import creates income/expense with GL and missing names', async () => {
    const res = await admin.post('/import/transactions', { rows, fileName: 'may.csv' });
    batchId = res.batchId;
    assert.deepEqual([res.imported, res.skippedErrors, res.createdCompanies], [6, 2, 2]);
    const income = await admin.get('/income');
    const expenses = await admin.get('/expenses');
    assert.equal(income.length, 4);
    assert.equal(expenses.length, 2);
    const paper = expenses.find((e) => e.memo === 'Paper');
    assert.equal(paper.company_name, 'Office Depot');
    const detail = await admin.get(`/expenses/${paper.id}`);
    assert.equal(cents(detail.amount), 123450);
    assert.equal(detail.lines[0].account_name, 'Office Supplies');
    assert.equal(detail.lines[0].fund_name, 'Youth Program');
    assert.equal(detail.fund_name, 'Youth Program');
    assert.deepEqual(detail.gl.map((g) => [g.account_name, cents(g.debit), cents(g.credit)]), [['Operating Checking', 0, 123450], ['Office Supplies', 123450, 0]]);
    const companies = (await admin.get('/companies')).map((c) => c.name);
    assert.deepEqual(companies.filter((n) => ['Jane Donor', 'Costco', 'Office Depot'].includes(n)).sort(), ['Costco', 'Jane Donor', 'Office Depot']);
    assert.equal(companies.filter((n) => n.toLowerCase() === 'jane donor').length, 1);
  });

  await t.test('re-importing flags duplicates and skips them by default', async () => {
    const again = await admin.post('/import/transactions/preview', { rows: rows.slice(0, 2) });
    assert.deepEqual(again.results.map((x) => x.status), ['duplicate', 'duplicate']);
    await assert.rejects(admin.post('/import/transactions', { rows: rows.slice(0, 2) }), /no valid rows/);
    const forced = await admin.post('/import/transactions', { rows: rows.slice(0, 1), skipDuplicates: false });
    assert.equal(forced.imported, 1);
    await admin.post(`/import/batches/${forced.batchId}/undo`);
  });

  await t.test('imports are listed and can be undone', async () => {
    let batches = await admin.get('/import/batches');
    const b = batches.find((x) => x.id === batchId);
    assert.deepEqual([b.file_name, b.row_count, b.remaining, b.created_companies, b.undone_at], ['may.csv', 6, 6, 2, null]);
    const res = await admin.post(`/import/batches/${batchId}/undo`);
    assert.deepEqual(res, { deleted: 6, removedCompanies: 2, removedAccounts: 0 });
    assert.equal((await admin.get('/income')).length, 0);
    const names = (await admin.get('/companies')).map((c) => c.name);
    assert.ok(names.includes('Office Depot') && !names.includes('Jane Donor') && !names.includes('Costco'));
    batches = await admin.get('/import/batches');
    assert.ok(batches.find((x) => x.id === batchId).undone_at);
    await assert.rejects(admin.post(`/import/batches/${batchId}/undo`), /already been undone/);
    assert.ok(existingVendor);
  });

  await t.test('undo is blocked once an imported income has been deposited', async () => {
    const res = await admin.post('/import/transactions', { rows: [row({ headerAccount: 'Undeposited Funds', date: '2026-06-01' })] });
    const inc = (await admin.get('/income'))[0];
    const lk = await admin.get('/lookups');
    await admin.post('/deposits', { date: '2026-06-02', accountId: lk.accounts.find((a) => a.account_number === '1000').id, incomeIds: [inc.id] });
    await assert.rejects(admin.post(`/import/batches/${res.batchId}/undo`), /deposited/);
    assert.equal((await admin.get('/income')).length, 1, 'nothing deleted when undo fails');
  });

  await t.test('limits and isolation', async () => {
    await assert.rejects(admin.post('/import/transactions/preview', { rows: [] }), /no transactions/);
    await assert.rejects(admin.post('/import/transactions/preview', { rows: Array.from({ length: 2001 }, () => row({})) }), /at most 2000/);
    const mine = (await admin.get('/import/batches'))[0].id;
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.equal((await admin.get('/import/batches')).length, 0);
    await assert.rejects(admin.post(`/import/batches/${mine}/undo`), /not found/);
    const p = await admin.post('/import/transactions/preview', { rows: [row({ customer: 'Office Depot' })] });
    assert.equal(p.results[0].parsed.createCompany, true, "another organization's names are not matched");
  });
});
