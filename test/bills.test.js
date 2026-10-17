// Bills (Accounts Payable) and Pay Bills tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_bills'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);

test('bills and bill payments', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Bills Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Bills Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const byNum = (n) => lk.accounts.find((a) => a.account_number === n);
  const [checking, card, ap, payroll, office, rent] = ['1000', '2000', '2100', '2200', '5300', '5200'].map((n) => byNum(n).id);
  const general = lk.funds[0].id;
  const youth = (await admin.post('/funds', { name: 'Youth' })).id;
  const acme = (await admin.post('/companies', { name: 'Acme Supply' })).id;
  const zed = (await admin.post('/companies', { name: 'Zed Services' })).id;

  const bill = (over = {}) => admin.post('/bills', {
    date: '2026-04-01', dueDate: '2026-05-01', companyId: acme, accountId: ap, fundId: general, refNumber: 'INV-1', amount: 300,
    lines: [{ accountId: office, amount: 300, fundId: general }], ...over,
  });

  let b1;
  let b2;
  await t.test('Accounts Payable is an account type', async () => {
    assert.equal(byNum('2100').account_type, 'accounts_payable');
    assert.ok(lk.accountTypes.some((x) => x.key === 'accounts_payable' && x.label === 'Accounts Payable'));
  });

  await t.test('enter bills (Dr expense, Cr Accounts Payable)', async () => {
    b1 = (await bill()).id;
    const b = await admin.get(`/bills/${b1}`);
    assert.deepEqual([b.transaction_type, b.due_date, b.company_name, b.paid, b.balance], ['bill', '2026-05-01', 'Acme Supply', '0.00', '300.00']);
    assert.deepEqual(b.gl.map((g) => [g.account_name, cents(g.debit), cents(g.credit)]), [['Accounts Payable', 0, 30000], ['Office Supplies', 30000, 0]]);
    b2 = (await bill({ refNumber: 'INV-2', date: '2026-04-10', dueDate: '2026-04-20', amount: 200, fundId: youth, lines: [{ accountId: rent, amount: 200, fundId: youth }] })).id;
    const open = await admin.get('/bills');
    assert.deepEqual(open.map((x) => [x.id, cents(x.balance)]), [[b2, 20000], [b1, 30000]], 'open bills, earliest due first');
    // A/P balance
    const reg = await admin.get(`/register?accountId=${ap}`);
    assert.equal(reg.endingBalance, 500);
  });

  await t.test('bill validation', async () => {
    await assert.rejects(bill({ companyId: null }), /Vendor is required/);
    await assert.rejects(bill({ accountId: checking }), /Accounts Payable account/);
    await assert.rejects(bill({ accountId: payroll }), /Accounts Payable account/);
    await assert.rejects(bill({ lines: [{ accountId: checking, amount: 300 }] }), /bank or credit card/);
    await assert.rejects(bill({ dueDate: 'soon' }), /Due date/);
    await assert.rejects(bill({ amount: 250 }), /must be equal/);
  });

  let pay1;
  await t.test('pay one bill in full and another in part with one check', async () => {
    pay1 = (await admin.post('/bill-payments', {
      companyId: acme, date: '2026-04-15', accountId: checking, method: 'check', checkNumber: '1001', memo: 'April bills',
      payments: [{ billId: b1, amount: 300 }, { billId: b2, amount: 50 }],
    })).id;
    const p = await admin.get(`/expenses/${pay1}`);
    assert.deepEqual([cents(p.amount), p.check_number, p.transaction_method, p.company_id, p.fund_id], [35000, '1001', 'check', acme, null]);
    assert.deepEqual(p.lines.map((l) => [l.account_id, cents(l.amount), l.bill_id, l.fund_id, l.bill_ref_number]), [[ap, 30000, b1, general, 'INV-1'], [ap, 5000, b2, youth, 'INV-2']]);
    assert.deepEqual(p.gl.map((g) => [g.account_name, cents(g.debit), cents(g.credit), g.fund_name]),
      [['Operating Checking', 0, 30000, 'General Fund'], ['Operating Checking', 0, 5000, 'Youth'], ['Accounts Payable', 30000, 0, 'General Fund'], ['Accounts Payable', 5000, 0, 'Youth']]);
    const [x1, x2] = [await admin.get(`/bills/${b1}`), await admin.get(`/bills/${b2}`)];
    assert.deepEqual([x1.balance, x2.paid, x2.balance], ['0.00', '50.00', '150.00']);
    assert.deepEqual(x2.payments.map((q) => [q.transaction_id, q.check_number, cents(q.amount)]), [[pay1, '1001', 5000]]);
    assert.deepEqual((await admin.get('/bills')).map((x) => x.id), [b2], 'paid bill leaves the open list');
    assert.deepEqual((await admin.get('/bills?status=paid')).map((x) => x.id), [b1]);
    assert.equal((await admin.get(`/register?accountId=${ap}`)).endingBalance, 150);
    const chk = await admin.get(`/register?accountId=${checking}`);
    assert.deepEqual([chk.entries.at(-1).type, chk.entries.at(-1).number, chk.entries.at(-1).amount], ['expense', '1001', -350]);
  });

  await t.test('payment validation', async () => {
    const pay = (over) => admin.post('/bill-payments', { companyId: acme, date: '2026-04-20', accountId: checking, method: 'electronic', payments: [{ billId: b2, amount: 10 }], ...over });
    await assert.rejects(pay({ payments: [{ billId: b2, amount: 151 }] }), /more than its open balance of 150.00/);
    await assert.rejects(pay({ payments: [] }), /at least one bill/);
    await assert.rejects(pay({ companyId: zed }), /different vendor/);
    await assert.rejects(pay({ accountId: ap }), /Bank or Credit Card/);
    await assert.rejects(pay({ payments: [{ billId: pay1, amount: 5 }] }), /Bill not found/);
    await assert.rejects(pay({ payments: [{ billId: b2, amount: -5 }] }), /more than zero/);
    // Directly on an expense: the line must use the bill's A/P account; income can't pay bills
    await assert.rejects(admin.post('/expenses', { date: '2026-04-20', companyId: acme, accountId: checking, amount: 10, lines: [{ accountId: office, amount: 10, billId: b2 }] }), /Accounts Payable account/);
    await assert.rejects(admin.post('/income', { date: '2026-04-20', companyId: acme, accountId: checking, amount: 10, lines: [{ accountId: ap, amount: 10, billId: b2 }] }), /Only expenses/);
  });

  await t.test('bills with payments are protected', async () => {
    await assert.rejects(admin.del(`/bills/${b2}`), /has payments/);
    const b = await admin.get(`/bills/${b2}`);
    const body = { date: b.date, dueDate: b.due_date, companyId: acme, accountId: ap, fundId: youth, refNumber: 'INV-2', amount: 40, lines: [{ accountId: rent, amount: 40, fundId: youth }] };
    await assert.rejects(admin.put(`/bills/${b2}`, body), /can’t be less than that/);
    await assert.rejects(admin.put(`/bills/${b2}`, { ...body, amount: 200, lines: [{ accountId: rent, amount: 200 }], companyId: zed }), /vendor and Accounts Payable/);
    await admin.put(`/bills/${b2}`, { ...body, amount: 250, lines: [{ accountId: rent, amount: 250, fundId: youth }], memo: 'Increased' });
    assert.equal((await admin.get(`/bills/${b2}`)).balance, '200.00');
  });

  await t.test('editing or deleting a payment updates the bill balance', async () => {
    const p = await admin.get(`/expenses/${pay1}`);
    const body = (amt2) => ({
      date: p.date, companyId: acme, accountId: checking, method: 'check', checkNumber: '1001', amount: 300 + amt2,
      lines: [{ accountId: ap, amount: 300, billId: b1 }, { accountId: ap, amount: amt2, billId: b2 }],
    });
    await assert.rejects(admin.put(`/expenses/${pay1}`, body(251)), /open balance of 250.00/);
    await admin.put(`/expenses/${pay1}`, body(250));
    assert.equal((await admin.get(`/bills/${b2}`)).balance, '0.00');
    await admin.del(`/expenses/${pay1}`);
    assert.deepEqual([(await admin.get(`/bills/${b1}`)).balance, (await admin.get(`/bills/${b2}`)).balance], ['300.00', '250.00']);
    // Partial payments add up across several payments
    for (const amt of [100, 200]) await admin.post('/bill-payments', { companyId: acme, date: '2026-04-25', accountId: card, payments: [{ billId: b1, amount: amt }] });
    const b = await admin.get(`/bills/${b1}`);
    assert.deepEqual([b.balance, b.payments.length], ['0.00', 2]);
    await admin.del(`/bills/${b2}`).catch(() => {});
  });

  await t.test('account type: current liability can become accounts payable and back (if it has no bills)', async () => {
    const acct = await admin.get(`/accounts/${payroll}`);
    await admin.put(`/accounts/${payroll}`, { ...acct, account_type: 'accounts_payable' });
    assert.equal((await admin.get(`/accounts/${payroll}`)).account_type, 'accounts_payable');
    await admin.put(`/accounts/${payroll}`, { ...acct, account_type: 'current_liability' });
    await assert.rejects(admin.put(`/accounts/${ap}`, { ...(await admin.get(`/accounts/${ap}`)), account_type: 'current_liability' }), /has bills/);
    await assert.rejects(admin.put(`/accounts/${office}`, { ...(await admin.get(`/accounts/${office}`)), account_type: 'income' }), /can’t be changed/);
  });

  await t.test('attachments and the period closing date apply to bills', async () => {
    const a = await admin.post('/attachments', { fileName: 'inv.pdf', data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), transactionId: b1 });
    assert.equal(a.transaction_id, b1);
    await admin.put('/period-closing', { closingDate: '2026-04-30' });
    await assert.rejects(bill({ refNumber: 'INV-9' }), /closed through/);
    await admin.put('/period-closing', { closingDate: null });
  });

  await t.test('private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/bills/${b1}`), /not found/);
    assert.deepEqual(await admin.get('/bills?status=all'), []);
    const lk2 = await admin.get('/lookups');
    const v = (await admin.post('/companies', { name: 'V' })).id;
    await assert.rejects(admin.post('/bill-payments', { companyId: v, date: '2026-05-01', accountId: lk2.accounts.find((x) => x.account_number === '1000').id, payments: [{ billId: b1, amount: 1 }] }), /Bill not found/);
  });
});
