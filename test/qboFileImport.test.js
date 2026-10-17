// QuickBooks Online report-export import (made-up CSV exports in QuickBooks' layout).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_qbo_files'); });
after(async () => { await app?.stop(); });

const csv = (rows) => rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n');
const file = (fileName, rows) => ({ fileName, data: Buffer.from(csv(rows)).toString('base64') });
const report = (title, header, body) => [['Sample Co'], [title], ['All Dates'], [], header, ...body, [], ['Thursday, Oct 15, 2026 06:06:25 PM GMT-7 - Accrual Basis']];

const J = ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'];
const journalRows = [
  ['', '01/03/2025', 'Deposit', '', '', 'Opening Balance', 'Checking', '1,000.00', ''], ['', '', '', '', '', '', 'Opening balance equity', '', '1000'], ['', '', '', '', '', '', '', 1000, 1000], [],
  ['', '01/05/2025', 'Deposit', '', 'Janalyn', 'ZELLE JANALYN', 'Checking', 475.5, ''], ['', '', '', '', '', 'Rent', 'Rent Income', '', 150], ['', '', '', '', '', 'Groceries back', 'Reimbursements', '', 325.5], ['', '', '', '', '', '', '', 475.5, 475.5], [],
  ['', '01/06/2025', 'Check', 3844, 'Bob Builder', 'CHECK', 'Checking', '', 1180], ['', '', '', '', '', 'Deck', 'Contract labor', 1180, ''], ['', '', '', '', '', '', '', 1180, 1180], [],
  ['', '01/07/2025', 'Expense', '', 'Sheetz', 'SHEETZ 123', 'Discover', '', 45.2], ['', '', '', '', '', '', 'Auto Expenses:Gas', 45.2, ''], ['', '', '', '', '', '', '', 45.2, 45.2], [],
  ['', '01/07/2025', 'Expense', '', 'Sheetz', 'SHEETZ 123', 'Discover', '', 45.2], ['', '', '', '', '', '', 'Auto Expenses:Gas', 45.2, ''], ['', '', '', '', '', '', '', 45.2, 45.2], [],
  ['', '01/10/2025', 'Credit Card Payment', '', '', 'DISCOVER E-PAYMENT', 'Checking', '', 90.4], ['', '', '', '', '', '', 'Discover', 90.4, ''], ['', '', '', '', '', '', '', 90.4, 90.4], [],
  ['', '01/12/2025', 'Credit Card Credit', '', 'Amazon', 'REFUND', 'Discover', 20, ''], ['', '', '', '', '', '', 'Household Items', '', 20], ['', '', '', '', '', '', '', 20, 20], [],
  ['', '01/15/2025', 'Journal Entry', 'JE1', '', 'Loan split', 'Checking', '', 300], ['', '', '', '', '', '', 'Loan Payable', 250, ''], ['', '', '', '', '', '', 'Interest paid', 50, ''], ['', '', '', '', '', '', '', 300, 300], [],
  ['', '02/01/2025', 'Expense', '', 'Mystery Shop', 'ODD', 'Checking', '', 10], ['', '', '', '', '', '', 'Brand New Account', 10, ''], ['', '', '', '', '', '', '', 10, 10], [],
  ['', '02/02/2025', 'Expense', '', '', 'BROKEN', 'Checking', '', 10], ['', '', '', '', '', '', 'Household Items', 9, ''], ['', '', '', '', '', '', '', 10, 9], [],
  ['', '', '', '', '', '', 'TOTAL', 3226.5, 3225.5],
];
const files = () => [
  file('Journal.csv', report('Journal', J, journalRows)),
  file('Vendors.csv', report('Vendor Contact List', ['', 'Vendor', 'Phone Numbers', 'Email', 'Full Name', 'Address', 'Account #'], [
    ['', 'Bob Builder', 'Phone: (717) 555-0100', 'bob@builder.example', 'Bob Builder', '12 Main St, Lancaster, PA 17601', ''], ['', 'Sheetz', '', '', '', '', ''], ['', 'Unused Vendor', '', '', '', '', '']])),
  file('Customers.csv', report('Customer Contact List', ['', 'Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address', 'Shipping Address'], [['', 'Janalyn', '', '', '', '', '']])),
  file('Balance_sheet.csv', report('Balance Sheet', ['', 'Total'], [
    ['ASSETS'], ['Current Assets'], ['Bank Accounts'], ['Checking', 0], ['Total Bank Accounts', 0], ['Total Current Assets', 0], ['TOTAL ASSETS', 0],
    ['LIABILITIES AND EQUITY'], ['Liabilities'], ['Current Liabilities'], ['Credit Cards'], ['Discover', 0], ['Total Credit Cards', 0], ['Total Current Liabilities', 0],
    ['Long-Term Liabilities'], ['Loan Payable', 0], ['Total Long-Term Liabilities', 0], ['Total Liabilities', 0],
    ['Equity'], ['Opening balance equity', 0], ['Retained Earnings'], ['Net Income', 0], ['Total Equity', 0], ['TOTAL LIABILITIES AND EQUITY', 0]])),
  file('Profit_and_loss.csv', report('Profit and Loss', ['', 'Total'], [
    ['Income'], ['Rent Income', 0], ['Reimbursements', 0], ['Total Income', 0], ['Gross Profit', 0],
    ['Expenses'], ['Auto Expenses', 0], ['Gas', 0], ['Total Auto Expenses', 0], ['Contract labor', 0], ['Household Items', 0], ['Total Expenses', 0],
    ['Net Operating Income', 0], ['Other Expenses'], ['Interest paid', 0], ['Total Other Expenses', 0], ['Net Other Income', 0], ['Net Income', 0]])),
  file('General_ledger.csv', report('General Ledger', ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit', 'Balance'], [
    ['Checking'], ['', '01/03/2025', 'Deposit', '', '', '', 'Checking', 1000, '', 1000], ['', '01/05/2025', 'Deposit', '', '', '', 'Checking', 475.5, '', 1475.5],
    ['', '01/06/2025', 'Check', '', '', '', 'Checking', '', 1180, 295.5], ['', '01/10/2025', 'Credit Card Payment', '', '', '', 'Checking', '', 90.4, 205.1],
    ['', '01/15/2025', 'Journal Entry', '', '', '', 'Checking', '', 300, -94.9], ['', '02/01/2025', 'Expense', '', '', '', 'Checking', '', 10, -104.9],
    ['', '02/02/2025', 'Expense', '', '', '', 'Checking', '', 10, -114.9], ['Total for Checking', '', '', '', '', '', '', 1475.5, 1590.4],
    ['Rent Income'], ['', '01/05/2025', 'Deposit', '', '', '', 'Rent Income', '', 150, 150],
    ['Interest paid'], ['', '01/15/2025', 'Journal Entry', '', '', '', 'Interest paid', 55, '', 55],
  ])),
];

test('QuickBooks export import', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'QBO Files Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other QBO Files Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const existingInsurance = lk.accounts.find((a) => a.name === 'Insurance');

  let plan;
  await t.test('analyze: files, accounts with types, names, transactions and the General Ledger check', async () => {
    plan = await admin.post('/import/qbo-files/analyze', { files: [...files(), file('notes.csv', [['hello']])] });
    assert.deepEqual(plan.files.map((f) => [f.fileName, f.label]), [['Journal.csv', 'Journal'], ['Vendors.csv', 'Vendor list'], ['Customers.csv', 'Customer list'],
      ['Balance_sheet.csv', 'Balance Sheet'], ['Profit_and_loss.csv', 'Profit and Loss'], ['General_ledger.csv', 'General Ledger'], ['notes.csv', 'Not recognized']]);
    const a = Object.fromEntries(plan.accounts.map((x) => [x.name, [x.action, x.type]]));
    assert.deepEqual(a.Checking, ['create', 'bank']);
    assert.deepEqual(a.Discover, ['create', 'credit_card']);
    assert.deepEqual(a['Loan Payable'], ['create', 'long_term_liability']);
    assert.deepEqual(a['Auto Expenses:Gas'], ['create', 'expense'], 'sub-accounts keep QuickBooks’ full name');
    assert.deepEqual(a['Interest paid'], ['create', 'other_expense']);
    assert.deepEqual(a['Opening balance equity'], ['create', 'equity']);
    assert.deepEqual(a['Brand New Account'], ['create', null], 'only in the Journal: the type must be chosen');
    assert.equal(a['Net Income'], undefined, 'report summary lines aren’t accounts');
    assert.equal(plan.ready, false);
    // Opening balance deposit, Janalyn's deposit and the card refund are income; the QuickBooks journal entry stays one
    assert.deepEqual(plan.summary.byType, { income: 3, expense: 4, transfer: 1, journal: 1 });
    assert.deepEqual([plan.summary.total, plan.summary.import, plan.summary.problems, plan.summary.firstDate, plan.summary.lastDate], [10, 9, 1, '2025-01-03', '2025-02-02']);
    assert.match(plan.problems[0].message, /debits \(9\.00\) don’t equal credits \(10\.00\)/);
    assert.deepEqual([plan.names.total, plan.names.create], [6, 6]);
    assert.deepEqual(plan.names.list.map((n) => n.name).sort(), ['Amazon', 'Bob Builder', 'Janalyn', 'Mystery Shop', 'Sheetz', 'Unused Vendor']);
    // The General Ledger above says Interest paid is 55 (the Journal says 50), and leaves out other accounts
    const mm = Object.fromEntries(plan.check.mismatches.map((m) => [m.account, [m.generalLedger, m.journal]]));
    assert.deepEqual(mm['Interest paid'], ['55.00', '50.00']);
    assert.equal(mm.Checking, undefined, 'Checking matches');
    await assert.rejects(admin.post('/import/qbo-files', { files: files() }), /Choose an account type for “Brand New Account”/);
  });

  await t.test('choices: map an account to an existing one or pick a type; limit by date', async () => {
    const p = await admin.post('/import/qbo-files/analyze', { files: files(), accounts: { 'Brand New Account': { accountId: existingInsurance.id }, 'Loan Payable': { type: 'loan' } }, to: '2025-01-31' });
    const a = Object.fromEntries(p.accounts.map((x) => [x.name, [x.action, x.type, x.accountId]]));
    assert.deepEqual(a['Brand New Account'], ['existing', 'expense', existingInsurance.id]);
    assert.deepEqual(a['Loan Payable'], ['create', 'loan', null]);
    assert.deepEqual([p.ready, p.summary.import, p.summary.outside], [true, 8, 1]);
  });

  let result;
  await t.test('import: native transaction types, names with contact details, accounts', async () => {
    result = await admin.post('/import/qbo-files', { files: files(), accounts: { 'Brand New Account': { type: 'other_expense' } } });
    assert.deepEqual([result.imported, result.byType, result.createdCompanies, result.skippedProblems], [9, { income: 3, expense: 4, transfer: 1, journal: 1 }, 6, 1]);
    const lk2 = await admin.get('/lookups');
    const acct = (n) => lk2.accounts.find((x) => x.name === n);
    const company = (n) => lk2.companies.find((x) => x.name === n);
    const bob = await admin.get(`/companies/${company('Bob Builder').id}`);
    assert.deepEqual([bob.address1, bob.city, bob.state, bob.postal, bob.phone1, bob.email], ['12 Main St', 'Lancaster', 'PA', '17601', '(717) 555-0100', 'bob@builder.example']);
    const exp = await admin.get(`/expenses?accountId=${acct('Checking').id}`).catch(() => null);
    // The check: an expense with the check number and vendor
    const { rows: [chk] } = await app.db.query(`SELECT * FROM transactions WHERE organization_id = $1 AND check_number = '3844'`, [org.id]);
    assert.deepEqual([chk.transaction_type, chk.transaction_method, chk.company_id, Number(chk.amount)], ['expense', 'check', company('Bob Builder').id, 1180]);
    const dep = await app.db.query(`SELECT t.id FROM transactions t WHERE t.organization_id = $1 AND t.transaction_type = 'income' AND t.company_id = $2`, [org.id, company('Janalyn').id]);
    const income = await admin.get(`/income/${dep.rows[0].id}`);
    assert.deepEqual(income.lines.map((l) => [l.account_id, Number(l.amount), l.memo]), [[acct('Rent Income').id, 150, 'Rent'], [acct('Reimbursements').id, 325.5, 'Groceries back']]);
    const { rows: types } = await app.db.query(`SELECT transaction_type, COUNT(*)::int AS n FROM transactions WHERE import_batch_id = $1 GROUP BY 1 ORDER BY 1`, [result.batchId]);
    assert.deepEqual(types.map((r) => [r.transaction_type, r.n]), [['expense', 4], ['income', 3], ['journal', 1], ['transfer', 1]]);
    // The card refund is income on the card account, crediting the expense account
    const { rows: [refund] } = await app.db.query(`SELECT * FROM transactions WHERE organization_id = $1 AND company_id = $2`, [org.id, company('Amazon').id]);
    assert.deepEqual([refund.transaction_type, refund.account_id], ['income', acct('Discover').id]);
    // Balances follow the Journal
    const reg = await admin.get(`/register?accountId=${acct('Checking').id}`);
    assert.equal(reg.endingBalance, 1000 + 475.5 - 1180 - 90.4 - 300 - 10);
    assert.equal(acct('Brand New Account').account_type, 'other_expense');
    assert.equal(acct('Auto Expenses:Gas').account_type, 'expense');
    assert.ok(exp === null || exp);
  });

  await t.test('importing the same export again skips what is already there (identical transactions count separately)', async () => {
    const p = await admin.post('/import/qbo-files/analyze', { files: files() });
    assert.deepEqual([p.summary.import, p.summary.already], [0, 9]);
    assert.equal(p.accounts.find((x) => x.name === 'Checking').action, 'existing');
    assert.equal(p.names.create, 0);
    await assert.rejects(admin.post('/import/qbo-files', { files: files() }), /nothing new/);
  });

  await t.test('closed periods are skipped; undo removes the transactions, names and accounts it created', async () => {
    const batches = await admin.get('/import/batches');
    assert.deepEqual([batches[0].kind, batches[0].row_count, batches[0].created_accounts, batches[0].created_companies], ['qbo_files', 9, result.createdAccounts, 6]);
    const undo = await admin.post(`/import/batches/${result.batchId}/undo`);
    assert.deepEqual([undo.deleted, undo.removedCompanies, undo.removedAccounts], [9, 6, result.createdAccounts]);
    const lk3 = await admin.get('/lookups');
    assert.equal(lk3.accounts.find((a) => a.name === 'Checking'), undefined);
    assert.ok(lk3.accounts.find((a) => a.id === existingInsurance.id), 'accounts it didn’t create stay');
    await admin.put('/period-closing', { closingDate: '2025-01-06' });
    const p = await admin.post('/import/qbo-files/analyze', { files: files(), accounts: { 'Brand New Account': { type: 'expense' } } });
    assert.deepEqual([p.summary.closed, p.summary.import, p.summary.closedThrough], [3, 6, '2025-01-06']);
    await admin.put('/period-closing', { closingDate: null });
  });

  await t.test('validation and isolation', async () => {
    await assert.rejects(admin.post('/import/qbo-files/analyze', { files: [] }), /Choose the files/);
    await assert.rejects(admin.post('/import/qbo-files/analyze', { files: [{ fileName: 'old.xls', data: Buffer.from('x').toString('base64') }] }), /\.xls files aren’t supported/);
    const p = await admin.post('/import/qbo-files/analyze', { files: [file('General_ledger.csv', report('General Ledger', ['', 'Date', 'Account', 'Debit', 'Credit'], []))] });
    assert.match(p.warnings.join(' '), /Export Reports → Journal/);
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.post(`/import/batches/${result.batchId}/undo`), /not found/i);
  });
});
