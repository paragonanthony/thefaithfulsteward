// Period closing date tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_closing'); });
after(async () => { await app?.stop(); });

const CLOSED = /closed through/;

test('period closing', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Closing Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, savings, undeposited, contributions, office, fees] = ['1000', '1010', '1050', '4000', '5300', '5500'].map(acct);
  const income = (date, amount = 100, accountId = checking) => admin.post('/income', { date, amount, accountId, lines: [{ accountId: contributions, amount }] });
  const incomeBody = (date, amount = 100, memo = '') => ({ date, amount, accountId: checking, memo, lines: [{ accountId: contributions, amount }] });

  // Activity before closing
  const march = (await income('2026-03-15')).id;
  const undep = (await income('2026-03-20', 40, undeposited)).id;
  const april = (await income('2026-04-05')).id;
  const je = (await admin.post('/journal-entries', { date: '2026-03-25', lines: [{ accountId: office, debit: 10 }, { accountId: checking, credit: 10 }] })).id;

  await t.test('only administrators set the date; no future dates', async () => {
    await admin.post('/admin/users', { username: 'clerk', password: 'clerk-password', role: 'user' });
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    await assert.rejects(clerk.put('/period-closing', { closingDate: '2026-03-31' }), /administrator/);
    await assert.rejects(admin.put('/period-closing', { closingDate: '2999-01-01' }), /future/);
    await assert.rejects(admin.put('/period-closing', { closingDate: 'March' }), /valid closing date/);
    const r = await admin.put('/period-closing', { closingDate: '2026-03-31', note: 'Q1 closed after audit' });
    assert.deepEqual(r, { closingDate: '2026-03-31', changed: true });
    assert.equal((await admin.get('/auth/me')).currentOrganization.period_closing_date, '2026-03-31');
    assert.equal((await clerk.get('/period-closing')).closingDate, '2026-03-31');
  });

  await t.test('transactions on or before the date cannot be added', async () => {
    await assert.rejects(income('2026-03-31'), CLOSED);
    await assert.rejects(income('2026-01-01'), CLOSED);
    await assert.rejects(admin.post('/expenses', { date: '2026-03-10', amount: 5, accountId: checking, lines: [{ accountId: office, amount: 5 }] }), CLOSED);
    await assert.rejects(admin.post('/journal-entries', { date: '2026-02-01', lines: [{ accountId: office, debit: 1 }, { accountId: checking, credit: 1 }] }), CLOSED);
    await assert.rejects(admin.post('/deposits', { date: '2026-03-31', accountId: checking, incomeIds: [undep] }), CLOSED);
    assert.ok((await income('2026-04-01')).id, 'the day after is open');
  });

  await t.test('closed transactions cannot be changed or deleted, or moved in or out', async () => {
    await assert.rejects(admin.put(`/income/${march}`, incomeBody('2026-03-15', 100, 'just a memo')), CLOSED);
    await assert.rejects(admin.put(`/income/${march}`, incomeBody('2026-04-15')), CLOSED, 'moving out of the closed period');
    await assert.rejects(admin.del(`/income/${march}`), CLOSED);
    await assert.rejects(admin.put(`/income/${april}`, incomeBody('2026-03-30')), CLOSED, 'moving into the closed period');
    await assert.rejects(admin.del(`/journal-entries/${je}`), CLOSED);
    // Nothing changed
    assert.equal((await admin.get(`/income/${march}`)).date, '2026-03-15');
    assert.equal((await admin.get(`/income/${april}`)).date, '2026-04-05');
  });

  await t.test('a later deposit can still include closed-period undeposited income', async () => {
    const dep = await admin.post('/deposits', { date: '2026-04-02', accountId: checking, incomeIds: [undep] });
    assert.ok(dep.id);
  });

  await t.test('old items can still be cleared in a later reconciliation', async () => {
    const start = await admin.get(`/reconciliations/start?accountId=${checking}`);
    const ids = start.transactions.map((x) => x.id);
    assert.ok(ids.includes(march) && ids.includes(je));
    const rec = await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-04-30', statementEndingBalance: 0, clearedIds: [march, je] });
    const view = await admin.get(`/reconciliations/${rec.id}`);
    assert.equal(view.transactions.filter((x) => x.cleared).length, 2);
    // But reconciliation adjustments dated in the closed period are refused
    await assert.rejects(admin.put(`/reconciliations/${rec.id}`, {
      accountId: checking, statementDate: '2026-04-30', statementEndingBalance: 0, clearedIds: [march],
      serviceCharge: { amount: 5, date: '2026-03-31', accountId: fees },
    }), CLOSED);
    await admin.del(`/reconciliations/${rec.id}`);
    await assert.rejects(admin.post('/reconciliations', { accountId: savings, statementDate: '2026-03-31', statementEndingBalance: 0 }), CLOSED);
  });

  await t.test('imports flag closed-period rows', async () => {
    const p = await admin.post('/import/transactions/preview', { rows: [
      { date: '2026-03-02', type: 'Income', headerAccount: 'Operating Checking', detailAccount: 'Individual Contributions', amount: 10 },
      { date: '2026-05-02', type: 'Income', headerAccount: 'Operating Checking', detailAccount: 'Individual Contributions', amount: 10 },
    ] });
    assert.deepEqual(p.results.map((r) => r.status), ['error', 'ok']);
    assert.match(p.results[0].errors[0], /closed period/);
  });

  await t.test('changes are logged and the period can be reopened', async () => {
    await admin.put('/period-closing', { closingDate: null, note: 'Correction needed' });
    const r = await admin.get('/period-closing');
    assert.equal(r.closingDate, null);
    assert.deepEqual(r.history.map((h) => [h.previous_date, h.closing_date, h.note, h.changed_by]),
      [[ '2026-03-31', null, 'Correction needed', 'Admin'], [null, '2026-03-31', 'Q1 closed after audit', 'Admin']]);
    await admin.put(`/income/${march}`, incomeBody('2026-03-15', 100, 'fixed while open'));
    assert.equal((await admin.put('/period-closing', { closingDate: '2026-03-31' })).changed, true);
    assert.equal((await admin.put('/period-closing', { closingDate: '2026-03-31' })).changed, false, 'same date is not logged twice');
    assert.equal((await admin.get('/period-closing')).history.length, 3);
  });

  await t.test('each organization has its own closing date', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.equal((await admin.get('/period-closing')).closingDate, null);
    const lk2 = await admin.get('/lookups');
    const r = await admin.post('/income', {
      date: '2026-01-05', amount: 5, accountId: lk2.accounts.find((a) => a.account_number === '1000').id,
      lines: [{ accountId: lk2.accounts.find((a) => a.account_number === '4000').id, amount: 5 }],
    });
    assert.ok(r.id);
  });
});
