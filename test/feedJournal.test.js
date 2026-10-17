// Bank feed matching for journal entries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_feedje'); });
after(async () => { await app?.stop(); });

test('bank feed matching for journal entries', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Feed Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, savings, contributions, fees] = ['1000', '1010', '4000', '5500'].map(acct);
  const transferBody = (amount, memo = 'Transfer to savings') => ({ date: '2026-05-10', memo, lines: [{ accountId: savings, debit: amount }, { accountId: checking, credit: amount }] });
  const transfer = (await admin.post('/journal-entries', transferBody(300))).id;

  await admin.post('/bank-feed/import', { accountId: checking, items: [
    { date: '2026-05-11', description: 'ONLINE TRANSFER TO SAV', amount: -300, externalId: 'c1' },
    { date: '2026-05-20', description: 'MONTHLY FEE', amount: -12, externalId: 'c2' },
  ] });
  await admin.post('/bank-feed/import', { accountId: savings, items: [{ date: '2026-05-11', description: 'TRANSFER FROM CHK', amount: 300, externalId: 's1' }] });
  const feed = async (accountId, status = 'unmatched') => (await admin.get(`/bank-feed?accountId=${accountId}&status=${status}`)).items;

  await t.test('journal entries are suggested on each bank account they touch', async () => {
    const chk = (await feed(checking)).find((i) => i.external_id === 'c1');
    assert.deepEqual(chk.suggestions.map((s) => [s.id, s.transaction_type, s.company_name]), [[transfer, 'journal', 'Transfer to savings']]);
    const sav = (await feed(savings))[0];
    assert.deepEqual(sav.suggestions.map((s) => s.id), [transfer]);
    const fee = (await feed(checking)).find((i) => i.external_id === 'c2');
    assert.equal(fee.suggestions.length, 0, 'different amount is not suggested');
  });

  await t.test('both sides of a transfer can be matched to the same entry', async () => {
    const chk = (await feed(checking)).find((i) => i.external_id === 'c1');
    const sav = (await feed(savings))[0];
    await admin.post(`/bank-feed/${chk.id}/match`, { transactionId: transfer });
    assert.deepEqual((await feed(savings))[0].suggestions.map((s) => s.id), [transfer], 'still offered for savings');
    await admin.post(`/bank-feed/${sav.id}/match`, { transactionId: transfer });
    const matched = await feed(checking, 'matched');
    assert.deepEqual(matched.map((m) => [m.transaction_type, m.company_name]), [['journal', 'Transfer to savings']]);
  });

  await t.test('matching rules', async () => {
    const fee = (await feed(checking)).find((i) => i.external_id === 'c2');
    await assert.rejects(admin.post(`/bank-feed/${fee.id}/match`, { transactionId: transfer }), /amount does not match/);
    const other = (await admin.post('/journal-entries', { date: '2026-05-20', lines: [{ accountId: fees, debit: 12 }, { accountId: contributions, credit: 12 }] })).id;
    await assert.rejects(admin.post(`/bank-feed/${fee.id}/match`, { transactionId: other }), /different bank account/);
    await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2026-05-12', description: 'DUP', amount: -300, externalId: 'c3' }] });
    const dupLine = (await feed(checking)).find((i) => i.external_id === 'c3');
    await assert.rejects(admin.post(`/bank-feed/${dupLine.id}/match`, { transactionId: transfer }), /already matched/);
    await admin.del(`/bank-feed/${dupLine.id}`);
  });

  await t.test('a journal entry created from a bank feed line is matched automatically', async () => {
    const fee = (await feed(checking)).find((i) => i.external_id === 'c2');
    const je = (await admin.post('/journal-entries', {
      date: '2026-05-20', memo: 'Monthly bank fee', bankFeedItemId: fee.id,
      lines: [{ accountId: fees, debit: 12 }, { accountId: checking, credit: 12 }],
    })).id;
    const m = (await feed(checking, 'matched')).find((i) => i.external_id === 'c2');
    assert.equal(m.transaction_id, je);
    await assert.rejects(admin.post('/journal-entries', {
      date: '2026-05-21', bankFeedItemId: (await feed(savings, 'matched'))[0].id, lines: [{ accountId: fees, debit: 5 }, { accountId: checking, credit: 5 }],
    }), /different bank account|does not match|already matched/);
  });

  await t.test('edits that change the bank amount unmatch the line; other edits keep it', async () => {
    await admin.put(`/journal-entries/${transfer}`, transferBody(300, 'Transfer (renamed)'));
    assert.equal((await feed(checking, 'matched')).filter((i) => i.transaction_id === transfer).length, 1);
    await admin.put(`/journal-entries/${transfer}`, transferBody(350));
    assert.equal((await feed(checking, 'matched')).filter((i) => i.transaction_id === transfer).length, 0);
    assert.equal((await feed(savings, 'matched')).length, 0);
    assert.equal((await feed(savings)).length, 1, 'back to Not Matched');
  });

  await t.test('the same applies to income', async () => {
    const inc = (await admin.post('/income', { date: '2026-05-25', amount: 40, accountId: checking, lines: [{ accountId: contributions, amount: 40 }] })).id;
    await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2026-05-25', description: 'DEPOSIT', amount: 40, externalId: 'c4' }] });
    const line = (await feed(checking)).find((i) => i.external_id === 'c4');
    await admin.post(`/bank-feed/${line.id}/match`, { transactionId: inc });
    await admin.put(`/income/${inc}`, { date: '2026-05-25', amount: 45, accountId: checking, lines: [{ accountId: contributions, amount: 45 }] });
    assert.ok((await feed(checking)).some((i) => i.external_id === 'c4'), 'unmatched after the amount changed');
  });

  await t.test('deleting a journal entry releases its lines', async () => {
    const sav = (await feed(savings))[0];
    const t2 = (await admin.post('/journal-entries', { date: '2026-05-11', lines: [{ accountId: savings, debit: 300 }, { accountId: checking, credit: 300 }] })).id;
    await admin.post(`/bank-feed/${sav.id}/match`, { transactionId: t2 });
    await admin.del(`/journal-entries/${t2}`);
    assert.equal((await feed(savings)).length, 1);
  });
});
