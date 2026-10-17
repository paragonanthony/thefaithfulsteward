// Journal entry tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_journal'); });
after(async () => { await app?.stop(); });

const cents = (v) => Math.round(Number(v) * 100);

test('journal entries', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'JE Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, savings, payable, rent, office] = ['1000', '1010', '2100', '5200', '5300'].map(acct);
  const general = lk.funds[0].id;
  const youth = (await admin.post('/funds', { name: 'Youth Program' })).id;

  let jeId;
  await t.test('save a balanced entry and post it to the general ledger', async () => {
    jeId = (await admin.post('/journal-entries', {
      date: '2026-06-30', memo: 'Accrue June rent', fundId: general,
      lines: [
        { accountId: rent, debit: 1500, memo: 'June rent' },
        { accountId: payable, credit: 1500, memo: 'Owed to landlord' },
      ],
    })).id;
    const je = await admin.get(`/journal-entries/${jeId}`);
    assert.equal(je.transaction_type, 'journal');
    assert.equal(cents(je.amount), 150000);
    assert.equal(je.memo, 'Accrue June rent');
    assert.deepEqual(je.lines.map((l) => [l.account_id, cents(l.debit), cents(l.credit), l.fund_id, l.memo]),
      [[rent, 150000, 0, general, 'June rent'], [payable, 0, 150000, general, 'Owed to landlord']]);
    assert.equal(je.gl.length, 2);
    assert.deepEqual(je.gl.map((g) => [cents(g.debit), cents(g.credit), g.fund_name]), [[150000, 0, 'General Fund'], [0, 150000, 'General Fund']]);
  });

  await t.test('validation', async () => {
    const base = { date: '2026-06-30', memo: 'x' };
    await assert.rejects(admin.post('/journal-entries', { ...base, lines: [{ accountId: rent, debit: 10 }, { accountId: payable, credit: 9 }] }), /must equal credits/);
    await assert.rejects(admin.post('/journal-entries', { ...base, lines: [{ accountId: rent, debit: 10 }] }), /at least two lines/);
    await assert.rejects(admin.post('/journal-entries', { ...base, lines: [{ accountId: rent, debit: 10, credit: 10 }, { accountId: payable, credit: 0 }] }), /not both/);
    await assert.rejects(admin.post('/journal-entries', { ...base, lines: [{ accountId: rent, debit: -10 }, { accountId: payable, credit: -10 }] }), /negative/);
    await assert.rejects(admin.post('/journal-entries', { ...base, lines: [{ debit: 10 }, { accountId: payable, credit: 10 }] }), /Account is required/);
    await assert.rejects(admin.post('/journal-entries', { ...base, lines: [{ accountId: rent, debit: 10 }, { accountId: payable }] }), /debit or a credit/);
    await assert.rejects(admin.post('/journal-entries', { memo: 'x', lines: [{ accountId: rent, debit: 10 }, { accountId: payable, credit: 10 }] }), /Date/);
  });

  await t.test('line funds override the header fund', async () => {
    const id = (await admin.post('/journal-entries', {
      date: '2026-07-01', memo: 'Reclass supplies to Youth', fundId: general,
      lines: [{ accountId: office, debit: 200, fundId: youth }, { accountId: office, credit: 200 }],
    })).id;
    const je = await admin.get(`/journal-entries/${id}`);
    assert.deepEqual(je.lines.map((l) => l.fund_id), [youth, general]);
  });

  await t.test('editing replaces the GL entry and flows into reports', async () => {
    await admin.put(`/journal-entries/${jeId}`, {
      date: '2026-06-30', memo: 'Accrue June rent (corrected)', fundId: general,
      lines: [{ accountId: rent, debit: 1600 }, { accountId: payable, credit: 1600 }],
    });
    const je = await admin.get(`/journal-entries/${jeId}`);
    assert.equal(cents(je.amount), 160000);
    assert.equal(je.gl.length, 2);
    const reports = await admin.get('/reports');
    const bs = (await admin.get(`/reports/${reports.find((r) => r.builtin_key === 'balance_sheet').id}`)).definition;
    const res = await admin.post('/reports/run', { definition: bs, to: '2026-12-31' });
    const line = (label) => res.lines.find((l) => l.label === label);
    assert.equal(line('Total Liabilities').values[0], 160000);
    // No assets yet: the $1,600 liability is offset by the expense in net assets, so the statement still balances.
    assert.equal(line('Total Assets'), undefined);
    assert.equal(line('Total Net Assets').values[0], -160000);
    assert.equal(line('Total Liabilities and Net Assets').values[0], 0);
  });

  await t.test('transfers between bank accounts show in both registers', async () => {
    await admin.post('/journal-entries', {
      date: '2026-07-15', memo: 'Move to savings', lines: [{ accountId: savings, debit: 300 }, { accountId: checking, credit: 300 }],
    });
    assert.equal((await admin.get(`/register?accountId=${savings}`)).endingBalance, 300);
    const reg = await admin.get(`/register?accountId=${checking}`);
    assert.equal(reg.endingBalance, -300);
    assert.equal(reg.entries.at(-1).type, 'journal');
  });

  await t.test('list and search', async () => {
    assert.equal((await admin.get('/journal-entries')).length, 3);
    assert.deepEqual((await admin.get('/journal-entries?search=rent')).map((x) => x.id), [jeId]);
    assert.equal((await admin.get('/journal-entries?search=Accounts Payable')).length, 1, 'matches line account name');
    assert.equal((await admin.get('/journal-entries?search=1600.00')).length, 1, 'matches amount');
    assert.equal((await admin.get('/journal-entries?from=2026-07-01&to=2026-07-31')).length, 2);
    const row = (await admin.get('/journal-entries')).find((x) => x.id === jeId);
    assert.deepEqual([row.line_count, row.fund_name], [2, 'General Fund']);
  });

  await t.test('delete removes the GL entry', async () => {
    await admin.del(`/journal-entries/${jeId}`);
    await assert.rejects(admin.get(`/journal-entries/${jeId}`), /not found/);
    const { rows } = await app.db.query('SELECT COUNT(*)::int AS n FROM gl_headers WHERE transaction_id = $1', [jeId]);
    assert.equal(rows[0].n, 0);
  });

  await t.test('journal entries are private to the organization', async () => {
    const mine = (await admin.get('/journal-entries'))[0].id;
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.equal((await admin.get('/journal-entries')).length, 0);
    await assert.rejects(admin.get(`/journal-entries/${mine}`), /not found/);
    await assert.rejects(admin.put(`/journal-entries/${mine}`, { date: '2026-07-01', lines: [] }), /at least two lines|not found/);
    const lk2 = await admin.get('/lookups');
    await assert.rejects(admin.post('/journal-entries', {
      date: '2026-07-01', lines: [{ accountId: rent, debit: 5 }, { accountId: lk2.accounts[0].id, credit: 5 }],
    }), /Invalid account/);
    await assert.rejects(admin.del(`/journal-entries/${mine}`), /not found/);
  });
});
