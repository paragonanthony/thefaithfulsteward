// Reconciliation report and attachments on reconciliations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_rec_report'); });
after(async () => { await app?.stop(); });

test('reconciliation report', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Report Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Report Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, contributions, office, fees, interest, grants] = ['1000', '4000', '5300', '5500', '4900', '4100'].map(a);
  const inc = async (date, amount) => (await admin.post('/income', { date, amount, accountId: checking, lines: [{ accountId: contributions, amount }] })).id;
  const exp = async (date, amount, extra = {}) => (await admin.post('/expenses', { date, amount, accountId: checking, lines: [{ accountId: office, amount }], ...extra })).id;

  const inc1 = await inc('2026-03-05', 100);
  const exp1 = await exp('2026-03-10', 40, { method: 'check', checkNumber: '101' });
  const exp4 = await exp('2026-03-28', 10); // never cleared
  const exp5 = await exp('2026-03-30', 7); // cleared in April
  const march = (await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-03-31', statementEndingBalance: 60, clearedIds: [inc1, exp1], complete: true })).id;
  const inc2 = await inc('2026-04-05', 200);
  const exp2 = await exp('2026-04-10', 30);
  const exp3 = await exp('2026-04-20', 15);
  const je = (await admin.post('/journal-entries', { date: '2026-04-25', memo: 'Correction', lines: [{ accountId: checking, debit: 5 }, { accountId: grants, credit: 5 }] })).id;
  await inc('2026-05-02', 50); // after the statement date
  const april = (await admin.post('/reconciliations', {
    accountId: checking, statementDate: '2026-04-30', statementEndingBalance: 222, clearedIds: [inc2, exp2, exp5], complete: true,
    serviceCharge: { amount: 2, date: '2026-04-30', accountId: fees }, interest: { amount: 1, date: '2026-04-30', accountId: interest },
  })).id;

  await t.test('balances, cleared and uncleared transactions as of the statement date', async () => {
    const r = await admin.get(`/reconciliations/${april}/report`);
    assert.deepEqual([r.account.name, r.reconciliation.statementDate, r.reconciliation.isComplete], ['Operating Checking', '2026-04-30', true]);
    assert.deepEqual(r.summary, {
      beginningBalance: '60.00',
      clearedDeposits: { count: 1, total: '200.00' },
      clearedPayments: { count: 2, total: '37.00' },
      serviceCharge: '2.00',
      interest: '1.00',
      clearedBalance: '222.00',
      statementEndingBalance: '222.00',
      difference: '0.00',
      unclearedDeposits: { count: 1, total: '5.00' },
      unclearedPayments: { count: 2, total: '25.00' },
      expectedRegisterBalance: '202.00',
      registerBalance: '202.00',
      registerDifference: '0.00',
    });
    assert.deepEqual(r.cleared.map((x) => x.id).sort((p, q) => p - q), [exp5, inc2, exp2].sort((p, q) => p - q));
    assert.deepEqual(r.uncleared.map((x) => [x.id, x.direction]), [[exp4, 'out'], [exp3, 'out'], [je, 'in']]);
  });

  await t.test('an earlier reconciliation reports what was uncleared at its date', async () => {
    const r = await admin.get(`/reconciliations/${march}/report`);
    assert.deepEqual([r.summary.clearedBalance, r.summary.registerBalance, r.summary.registerDifference], ['60.00', '43.00', '0.00']);
    assert.deepEqual(r.uncleared.map((x) => x.id), [exp4, exp5], 'exp5 was cleared later, in April');
  });

  await t.test('an in-progress reconciliation reports its current cleared items', async () => {
    const may = (await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-05-31', statementEndingBalance: 0, clearedIds: [exp3] })).id;
    const r = await admin.get(`/reconciliations/${may}/report`);
    assert.equal(r.reconciliation.isComplete, false);
    assert.deepEqual(r.cleared.map((x) => x.id), [exp3]);
    assert.equal(r.summary.clearedBalance, '207.00');
    // Back on April's report, exp3 is still uncleared as of April 30 (it's only cleared in May, in progress).
    assert.ok((await admin.get(`/reconciliations/${april}/report`)).uncleared.some((x) => x.id === exp3));
    await admin.del(`/reconciliations/${may}`);
  });

  await t.test('files can be attached to a reconciliation and are listed on the report', async () => {
    const att = await admin.post('/attachments', { fileName: 'april-statement.pdf', data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'), transactionId: april });
    assert.equal(att.transaction_id, april);
    assert.deepEqual((await admin.get(`/reconciliations/${april}/report`)).attachments.map((x) => x.file_name), ['april-statement.pdf']);
  });

  await t.test('private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/reconciliations/${april}/report`), /not found/);
  });
});
