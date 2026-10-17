// Bank transfer tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_transfer'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);

test('bank transfers', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Transfer Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, savings, undeposited, card, office] = ['1000', '1010', '1050', '2000', '5300'].map(acct);
  const general = lk.funds[0].id;

  let id;
  await t.test('creates a transfer with GL entries Dr To / Cr From', async () => {
    id = (await admin.post('/transfers', { date: '2026-06-01', fromAccountId: checking, toAccountId: savings, amount: 750, fundId: general, memo: 'Reserve funds', refNumber: 'T-1' })).id;
    const tr = await admin.get(`/transfers/${id}`);
    assert.equal(tr.transaction_type, 'transfer');
    assert.deepEqual([cents(tr.amount), tr.account_id, tr.memo, tr.ref_number], [75000, checking, 'Reserve funds', 'T-1']);
    assert.deepEqual(tr.gl.map((g) => [g.account_name, cents(g.debit), cents(g.credit), g.fund_name]),
      [['Savings', 75000, 0, 'General Fund'], ['Operating Checking', 0, 75000, 'General Fund']]);
  });

  await t.test('validation', async () => {
    const b = { date: '2026-06-01', fromAccountId: checking, toAccountId: savings, amount: 10 };
    await assert.rejects(admin.post('/transfers', { ...b, toAccountId: checking }), /must be different/);
    await assert.rejects(admin.post('/transfers', { ...b, amount: 0 }), /greater than zero/);
    await assert.rejects(admin.post('/transfers', { ...b, fromAccountId: null }), /From account is required/);
    await assert.rejects(admin.post('/transfers', { ...b, toAccountId: office }), /To account must be a Bank or Credit Card/);
    await assert.rejects(admin.post('/transfers', { ...b, fromAccountId: undeposited }), /Undeposited Funds/);
    await assert.rejects(admin.post('/transfers', { ...b, date: '' }), /Date/);
  });

  await t.test('shows in both registers', async () => {
    const chk = await admin.get(`/register?accountId=${checking}`);
    const sav = await admin.get(`/register?accountId=${savings}`);
    assert.deepEqual([chk.endingBalance, sav.endingBalance], [-750, 750]);
    assert.deepEqual([chk.entries[0].type, chk.entries[0].toFrom, chk.entries[0].number], ['transfer', 'Transfer', 'T-1']);
  });

  await t.test('paying a credit card is a transfer too', async () => {
    const pay = (await admin.post('/transfers', { date: '2026-06-02', fromAccountId: checking, toAccountId: card, amount: 200 })).id;
    const tr = await admin.get(`/transfers/${pay}`);
    assert.equal(tr.gl[0].account_name, 'Credit Card');
    assert.match(tr.gl[0].fund_name ?? '', /^$/);
    await admin.del(`/transfers/${pay}`);
  });

  await t.test('each side reconciles separately', async () => {
    const chk = await admin.get(`/reconciliations/start?accountId=${checking}`);
    assert.deepEqual(chk.transactions.map((x) => [x.id, x.transaction_type, x.direction, cents(x.amount)]), [[id, 'transfer', 'out', 75000]]);
    const rec = await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-06-30', statementEndingBalance: -750, clearedIds: [id], complete: true });
    assert.ok(rec.id);
    assert.deepEqual((await admin.get(`/reconciliations/start?accountId=${savings}`)).transactions.map((x) => [x.id, x.direction]), [[id, 'in']]);
    // Locked once reconciled: amount can't change, the memo can
    await assert.rejects(admin.put(`/transfers/${id}`, { date: '2026-06-01', fromAccountId: checking, toAccountId: savings, amount: 800 }), /completed reconciliation/);
    await admin.put(`/transfers/${id}`, { date: '2026-06-01', fromAccountId: checking, toAccountId: savings, amount: 750, fundId: general, memo: 'Reserve (renamed)' });
    await assert.rejects(admin.del(`/transfers/${id}`), /completed reconciliation/);
  });

  await t.test('matches bank feed lines on both accounts', async () => {
    await admin.post('/bank-feed/import', { accountId: savings, items: [{ date: '2026-06-02', description: 'TRANSFER IN', amount: 750, externalId: 's1' }] });
    const item = (await admin.get(`/bank-feed?accountId=${savings}`)).items[0];
    assert.deepEqual(item.suggestions.map((s) => [s.id, s.transaction_type]), [[id, 'transfer']]);
    await admin.post(`/bank-feed/${item.id}/match`, { transactionId: id });
    const matched = (await admin.get(`/transfers/${id}`)).feedMatches;
    assert.deepEqual(matched.map((m) => [m.account_name, m.description, Number(m.amount), m.source, m.matched_by]), [['Savings', 'TRANSFER IN', 750, 'file', 'Admin']]);
    await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2026-06-03', description: 'TRANSFER OUT', amount: -120, externalId: 'c1' }] });
    const out = (await admin.get(`/bank-feed?accountId=${checking}`)).items[0];
    const created = (await admin.post('/transfers', { date: '2026-06-03', fromAccountId: checking, toAccountId: savings, amount: 120, bankFeedItemId: out.id })).id;
    assert.equal((await admin.get(`/bank-feed?accountId=${checking}&status=matched`)).items[0].transaction_id, created);
    assert.equal((await admin.get(`/transfers/${created}`)).feedMatches[0].account_name, 'Operating Checking');
    assert.deepEqual((await admin.get(`/transfers/${created}`)).feedMatches.length, 1);
  });

  await t.test('respects the period closing date', async () => {
    await admin.put('/period-closing', { closingDate: '2026-06-30' });
    await assert.rejects(admin.post('/transfers', { date: '2026-06-15', fromAccountId: checking, toAccountId: savings, amount: 5 }), /closed through/);
    assert.ok((await admin.post('/transfers', { date: '2026-07-01', fromAccountId: checking, toAccountId: savings, amount: 5 })).id);
    await admin.put('/period-closing', { closingDate: null });
  });

  await t.test('private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/transfers/${id}`), /not found/);
    const lk2 = await admin.get('/lookups');
    await assert.rejects(admin.post('/transfers', { date: '2026-06-01', fromAccountId: checking, toAccountId: lk2.accounts.find((a) => a.account_number === '1010').id, amount: 1 }), /Invalid account/);
    await assert.rejects(admin.del(`/transfers/${id}`), /not found/);
  });
});
