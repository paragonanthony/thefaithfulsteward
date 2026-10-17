// Importing customers / vendors and the chart of accounts from a file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseAccountType } from '../server/services/listImport.js';

let app;
before(async () => { app = await startTestServer('npacct_test_list_import'); });
after(async () => { await app?.stop(); });

test('account type names from other systems', () => {
  assert.deepEqual(['Bank', 'Other Current Asset', 'Accounts Receivable', 'Fixed Asset', 'Accounts Payable', 'Credit Card', 'Other Current Liability',
    'Long Term Liabilities', 'Equity', 'Net Assets', 'Income', 'Revenue', 'Other Income', 'Expenses', 'Cost of Goods Sold', 'Other Expense', 'other_expense', 'Nope'].map(parseAccountType),
  ['bank', 'current_asset', 'current_asset', 'fixed_asset', 'accounts_payable', 'credit_card', 'current_liability',
    'long_term_liability', 'equity', 'equity', 'income', 'income', 'other_income', 'expense', 'expense', 'other_expense', 'other_expense', null]);
});

test('list imports', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'List Import Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other List Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const general = (await admin.get('/lookups')).funds[0];
  const youth = await admin.post('/funds', { name: 'Youth Program' });
  const preview = (kind, rows, o = {}) => admin.post(`/import/lists/${kind}/preview`, { rows, ...o });
  const run = (kind, rows, o = {}) => admin.post(`/import/lists/${kind}`, { rows, ...o });
  const accounts = async () => (await admin.get('/accounts'));

  const chart = [
    { number: '1020', name: 'Payroll Checking', type: 'Bank', description: 'Second bank account', group: '', fund: '', active: '' },
    { number: '1300', name: 'Prepaid Expenses', type: 'Other Current Asset', group: 'Prepaids' },
    { number: '4150', name: 'Foundation Grants', type: 'Revenue', group: 'Grants', fund: 'Youth Program' },
    { number: '4160', name: 'Government Grants', type: 'Income', group: 'grants' },
    { number: '6100', name: 'Fuel', type: 'Expenses', group: 'Vehicle' },
    { number: '6110', name: 'Old Vehicle Lease', type: 'Expense', active: 'No' },
    { number: '5300', name: 'Office Supplies & Postage', type: 'Expense', description: 'Renamed' }, // existing number
    { number: '', name: 'Grants', type: 'Income' }, // existing name (4100)
    { number: '9999', name: 'Mystery', type: 'Assets?' },
    { number: '1500', name: 'Fuel', type: 'Expense' },
    { number: '4300', name: 'Events', type: 'Expense' }, // existing 4300 is Income
    { number: '1600', name: 'Petty Cash', type: 'Bank', undeposited: 'maybe', fund: 'Nowhere' },
  ];

  await t.test('chart of accounts: the check shows what will be created, updated or skipped, and why rows fail', async () => {
    const p = await preview('accounts', chart);
    assert.deepEqual(p.summary, { total: 12, create: 6, update: 0, skip: 2, errors: 4 });
    const st = p.results.map((r) => r.status);
    assert.deepEqual(st, ['create', 'create', 'create', 'create', 'create', 'create', 'skip', 'skip', 'error', 'error', 'error', 'error']);
    const err = (i) => p.results[i].errors.join(' | ');
    assert.match(err(8), /Account Type "Assets\?" isn’t one of/);
    assert.match(err(9), /"Fuel" is also on row 5 of the file/);
    assert.match(err(10), /already a Income account; its type can’t be changed to Expense/);
    assert.match(err(11), /Undeposited Funds "maybe" must be Yes or No/);
    assert.match(err(11), /Default Fund "Nowhere" was not found/);
    assert.match(p.results[6].warnings[0], /Already exists/);
    assert.deepEqual([p.results[2].parsed.typeLabel, p.results[2].parsed.fund], ['Income', 'Youth Program']);
    assert.equal((await accounts()).length, 24, 'nothing saved yet');
  });

  await t.test('importing creates accounts and their groups; existing ones are left alone', async () => {
    const r = await run('accounts', chart);
    assert.deepEqual(r, { created: 6, updated: 0, skipped: 2, errors: 4 });
    const all = await accounts();
    const by = (n) => all.find((a) => a.account_number === n);
    assert.deepEqual([by('4150').name, by('4150').account_type, by('4150').group_name, by('4150').default_fund_name], ['Foundation Grants', 'income', 'Grants', 'Youth Program']);
    assert.equal(by('4160').group_name, 'Grants', 'one group per name and type, ignoring case');
    assert.deepEqual([by('6110').is_active, by('1300').account_type, by('1020').account_type], [false, 'current_asset', 'bank']);
    assert.equal(by('5300').name, 'Office Supplies', 'existing account not changed without "update existing"');
    const groups = await admin.get('/account-groups').catch(() => null);
    if (groups) assert.equal(groups.filter((g) => g.name.toLowerCase() === 'grants').length, 1);
  });

  await t.test('"update existing" changes only the cells that have a value', async () => {
    const p = await preview('accounts', [
      { number: '5300', name: 'Office Supplies & Postage', type: '', description: 'Paper, ink and stamps', fund: 'General Fund' },
      { number: '6110', name: 'Old Vehicle Lease', type: 'Expense', active: 'yes' },
    ], { updateExisting: true });
    assert.deepEqual(p.summary, { total: 2, create: 0, update: 2, skip: 0, errors: 0 });
    await run('accounts', p.results.map((_, i) => [
      { number: '5300', name: 'Office Supplies & Postage', type: '', description: 'Paper, ink and stamps', fund: 'General Fund' },
      { number: '6110', name: 'Old Vehicle Lease', type: 'Expense', active: 'yes' },
    ][i]), { updateExisting: true });
    const all = await accounts();
    const a = all.find((x) => x.account_number === '5300');
    assert.deepEqual([a.name, a.description, a.default_fund_id, a.account_type], ['Office Supplies & Postage', 'Paper, ink and stamps', general.id, 'expense']);
    assert.equal(all.find((x) => x.account_number === '6110').is_active, true);
  });

  const names = [
    { name: 'Caseys General Store', city: 'Ames', state: 'IA', defaultExpenseAccount: 'Fuel', email: 'store@caseys.example' },
    { name: 'Jane Donor', address1: '12 Elm St', city: 'Ames', state: 'IA', postal: '50010', phone: '515-555-0101', defaultIncomeAccount: '4000' },
    { name: 'Smith Foundation', defaultIncomeAccount: 'Foundation Grants', notes: 'Annual grant, due in March' },
    { name: 'Old Vendor', active: 'inactive' },
    { name: 'caseys general store' },
    { name: '' },
    { name: 'Bad Default', defaultIncomeAccount: 'Fuel', email: 'not-an-email' },
    { name: 'Unknown Account', defaultExpenseAccount: 'Nope' },
  ];

  await t.test('customers / vendors: check and import', async () => {
    const p = await preview('companies', names);
    assert.deepEqual(p.summary, { total: 8, create: 4, update: 0, skip: 0, errors: 4 });
    const err = (i) => p.results[i].errors.join(' | ');
    assert.match(err(4), /also on row 1 of the file/);
    assert.match(err(5), /Name is required/);
    assert.match(err(6), /Default Income Account "Fuel" must be an Income or Other Income account/);
    assert.match(p.results[6].warnings.join(' '), /doesn’t look like an email address/);
    assert.match(err(7), /Account "Nope" was not found/);
    assert.equal(p.results[1].parsed.defaultIncomeAccount, 'Individual Contributions', 'accounts can be given by number');

    assert.deepEqual(await run('companies', names), { created: 4, updated: 0, skipped: 0, errors: 4 });
    const lk = await admin.get('/lookups');
    const c = (n) => lk.companies.find((x) => x.name === n);
    const fuel = lk.accounts.find((a) => a.account_number === '6100').id;
    assert.equal(c('Caseys General Store').default_expense_account_id, fuel);
    assert.equal(c('Old Vendor').is_active, false);
    const jane = await admin.get(`/companies/${c('Jane Donor').id}`);
    assert.deepEqual([jane.address1, jane.postal, jane.phone1, jane.city], ['12 Elm St', '50010', '515-555-0101', 'Ames']);
    assert.equal((await admin.get(`/companies/${c('Smith Foundation').id}`)).notes, 'Annual grant, due in March');
  });

  await t.test('names already there are skipped, or updated (blank cells left alone)', async () => {
    const rows = [{ name: 'JANE DONOR', phone: '515-555-0199', email: 'jane@example.org' }, { name: 'New Person' }];
    const skip = await preview('companies', rows);
    assert.deepEqual(skip.summary, { total: 2, create: 1, update: 0, skip: 1, errors: 0 });
    assert.deepEqual(await run('companies', rows, { updateExisting: true }), { created: 1, updated: 1, skipped: 0, errors: 0 });
    const lk = await admin.get('/lookups');
    const jane = await admin.get(`/companies/${lk.companies.find((x) => x.name === 'Jane Donor').id}`);
    assert.deepEqual([jane.phone1, jane.email, jane.address1, jane.default_income_account_id], ['515-555-0199', 'jane@example.org', '12 Elm St', lk.accounts.find((a) => a.account_number === '4000').id]);
  });

  await t.test('limits and isolation', async () => {
    await assert.rejects(preview('companies', []), /no rows/);
    await assert.rejects(preview('people', [{ name: 'x' }]), /Unknown import/);
    await assert.rejects(preview('companies', Array.from({ length: 5001 }, (_, i) => ({ name: `N${i}` }))), /at most 5,000/);
    await admin.post('/auth/select-org', { organizationId: other.id });
    // Another organization doesn't see this one's accounts or names
    const p = await preview('companies', [{ name: 'Jane Donor', defaultIncomeAccount: 'Foundation Grants' }]);
    assert.deepEqual([p.results[0].status, p.results[0].errors[0]], ['error', 'Default Income Account: Account "Foundation Grants" was not found']);
    assert.equal(youth.name, 'Youth Program');
  });
});
