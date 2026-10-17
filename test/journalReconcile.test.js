// Reconciling journal entries that touch bank accounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_jrec'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);

test('journal entries in reconciliations', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Rec Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, savings, contributions, office, card] = ['1000', '1010', '4000', '5300', '2000'].map(acct);

  const income = (await admin.post('/income', { date: '2026-03-02', amount: 1000, accountId: checking, lines: [{ accountId: contributions, amount: 1000 }] })).id;
  const je = (body) => admin.post('/journal-entries', body).then((r) => r.id);
  // Transfer $300 checking -> savings
  const transfer = await je({ date: '2026-03-10', memo: 'Transfer to savings', lines: [{ accountId: savings, debit: 300 }, { accountId: checking, credit: 300 }] });
  // A line pair that nets to zero on checking is not a reconciling item
  await je({ date: '2026-03-11', memo: 'Nets to zero', lines: [{ accountId: checking, debit: 25 }, { accountId: checking, credit: 25 }] });

  let checkingRec;
  await t.test('journal entries appear as reconciling items for each bank account they touch', async () => {
    const start = await admin.get(`/reconciliations/start?accountId=${checking}`);
    const items = start.transactions.map((x) => [x.transaction_type, x.id, cents(x.amount), x.direction]);
    assert.deepEqual(items, [['income', income, 100000, 'in'], ['journal', transfer, 30000, 'out']]);
    const sav = await admin.get(`/reconciliations/start?accountId=${savings}`);
    assert.deepEqual(sav.transactions.map((x) => [x.id, cents(x.amount), x.direction]), [[transfer, 30000, 'in']]);
  });

  await t.test('clearing a journal entry counts its net effect and clears only that account', async () => {
    const body = { accountId: checking, statementDate: '2026-03-31', statementEndingBalance: 700, clearedIds: [income, transfer] };
    checkingRec = (await admin.post('/reconciliations', { ...body, complete: true })).id;
    const view = await admin.get(`/reconciliations/${checkingRec}`);
    assert.deepEqual(view.transactions.map((x) => [x.transaction_type, x.direction]), [['income', 'in'], ['journal', 'out']]);
    assert.equal((await admin.get(`/reconciliations/start?accountId=${checking}`)).transactions.length, 0);
    // Still open on savings
    assert.deepEqual((await admin.get(`/reconciliations/start?accountId=${savings}`)).transactions.map((x) => x.id), [transfer]);
    const reg = await admin.get(`/register?accountId=${checking}`);
    assert.equal(reg.entries.find((e) => e.transactionId === transfer).cleared, true);
    const savReg = await admin.get(`/register?accountId=${savings}`);
    assert.equal(savReg.entries.find((e) => e.transactionId === transfer).cleared, false);
  });

  await t.test('a cleared journal entry is protected in completed reconciliations', async () => {
    await assert.rejects(admin.put(`/journal-entries/${transfer}`, {
      date: '2026-03-10', memo: 'Transfer', lines: [{ accountId: savings, debit: 350 }, { accountId: checking, credit: 350 }],
    }), /completed reconciliation/);
    await assert.rejects(admin.del(`/journal-entries/${transfer}`), /completed reconciliation/);
    // Wording changes are fine and keep it cleared
    await admin.put(`/journal-entries/${transfer}`, {
      date: '2026-03-10', memo: 'Monthly transfer to savings', lines: [{ accountId: savings, debit: 300, memo: 'in' }, { accountId: checking, credit: 300, memo: 'out' }],
    });
    const j = await admin.get(`/journal-entries/${transfer}`);
    assert.equal(j.memo, 'Monthly transfer to savings');
    assert.equal(j.lines.find((l) => l.account_id === checking).line_reconciled, true);
    assert.equal(j.lines.find((l) => l.account_id === savings).line_reconciled, null);
    assert.equal((await admin.get(`/reconciliations/${checkingRec}`)).transactions.length, 2);
  });

  await t.test('in an unfinished reconciliation a changed amount simply becomes uncleared', async () => {
    const fee = await je({ date: '2026-04-05', memo: 'Supplies on account', lines: [{ accountId: office, debit: 50 }, { accountId: checking, credit: 50 }] });
    const rec = (await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-04-30', statementEndingBalance: 650, clearedIds: [fee] })).id;
    let items = (await admin.get(`/reconciliations/${rec}`)).transactions;
    assert.equal(items.find((x) => x.id === fee).cleared, true);
    await admin.put(`/journal-entries/${fee}`, { date: '2026-04-05', memo: 'Supplies', lines: [{ accountId: office, debit: 55 }, { accountId: checking, credit: 55 }] });
    items = (await admin.get(`/reconciliations/${rec}`)).transactions;
    assert.deepEqual([items.find((x) => x.id === fee).cleared, cents(items.find((x) => x.id === fee).amount)], [false, 5500]);
    // Re-clear and complete: 700 - 55 = 645
    await admin.put(`/reconciliations/${rec}`, { accountId: checking, statementDate: '2026-04-30', statementEndingBalance: 645, clearedIds: [fee], complete: true });
    // Undo then delete the April reconciliation releases the journal line
    await admin.post(`/reconciliations/${rec}/undo`);
    await admin.del(`/reconciliations/${rec}`);
    assert.deepEqual((await admin.get(`/reconciliations/start?accountId=${checking}`)).transactions.map((x) => x.id), [fee]);
    await admin.del(`/journal-entries/${fee}`);
  });

  await t.test('savings reconciles the other side of the transfer', async () => {
    await admin.post('/reconciliations', { accountId: savings, statementDate: '2026-03-31', statementEndingBalance: 300, clearedIds: [transfer], complete: true });
    assert.equal((await admin.get(`/register?accountId=${savings}`)).entries.find((e) => e.transactionId === transfer).cleared, true);
  });

  await t.test('credit card accounts: a journal debit reduces the balance owed', async () => {
    const charge = await je({ date: '2026-03-15', memo: 'Card fee', lines: [{ accountId: office, debit: 20 }, { accountId: card, credit: 20 }] });
    const items = (await admin.get(`/reconciliations/start?accountId=${card}`)).transactions;
    assert.deepEqual(items.map((x) => [x.id, x.direction]), [[charge, 'out']]);
    // Statement shows $20 owed
    await admin.post('/reconciliations', { accountId: card, statementDate: '2026-03-31', statementEndingBalance: 20, clearedIds: [charge], complete: true });
  });
});
