// Totals of transactions cleared in a completed reconciliation can't change (enforced in the database too),
// while edits that keep the total are allowed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_rec_lock'); });
after(async () => { await app?.stop(); });

test('reconciled totals are locked', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Lock Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, savings, undeposited, card, contributions, grants, office, rent, ap] = ['1000', '1010', '1050', '2000', '4000', '4100', '5300', '5200', '2100'].map(a);
  const general = lk.funds[0].id;
  const vendor = (await admin.post('/companies', { name: 'V' })).id;

  const inc = (await admin.post('/income', { date: '2026-03-01', amount: 100, accountId: checking, lines: [{ accountId: contributions, amount: 100 }] })).id;
  const exp = (await admin.post('/expenses', { date: '2026-03-02', amount: 40, accountId: checking, lines: [{ accountId: office, amount: 40 }] })).id;
  const u1 = (await admin.post('/income', { date: '2026-03-03', amount: 30, accountId: undeposited, lines: [{ accountId: contributions, amount: 30 }] })).id;
  const u2 = (await admin.post('/income', { date: '2026-03-03', amount: 20, accountId: undeposited, lines: [{ accountId: contributions, amount: 20 }] })).id;
  const dep = (await admin.post('/deposits', { date: '2026-03-04', accountId: checking, incomeIds: [u1, u2] })).id;
  const je = (await admin.post('/journal-entries', { date: '2026-03-05', memo: 'JE', lines: [{ accountId: checking, debit: 10 }, { accountId: grants, credit: 10 }] })).id;
  const tr = (await admin.post('/transfers', { date: '2026-03-06', fromAccountId: checking, toAccountId: savings, amount: 5 })).id;
  const bill = (await admin.post('/bills', { date: '2026-03-01', companyId: vendor, accountId: ap, amount: 50, lines: [{ accountId: rent, amount: 50 }] })).id;
  const pay = (await admin.post('/bill-payments', { companyId: vendor, date: '2026-03-07', accountId: checking, payments: [{ billId: bill, amount: 50 }] })).id;
  const rec = (await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-03-31', statementEndingBalance: 65, clearedIds: [inc, exp, dep, je, tr, pay], complete: true })).id;

  await t.test('the cleared totals are recorded when the reconciliation is completed', async () => {
    const { rows } = await app.db.query('SELECT transaction_id, net_cents FROM reconciled_totals WHERE reconciliation_id = $1 ORDER BY transaction_id', [rec]);
    assert.deepEqual(rows.map((r) => [r.transaction_id, Number(r.net_cents)]), [[inc, 10000], [exp, -4000], [dep, 5000], [je, 1000], [tr, -500], [pay, -5000]]);
  });

  await t.test('edits that keep the total are allowed', async () => {
    await admin.put(`/income/${inc}`, { date: '2026-03-02', amount: 100, accountId: checking, fundId: general, memo: 'Split', lines: [{ accountId: contributions, amount: 60 }, { accountId: grants, amount: 40 }] });
    await admin.put(`/expenses/${exp}`, { date: '2026-03-02', amount: 40, accountId: checking, method: 'check', checkNumber: '101', lines: [{ accountId: office, amount: 25 }, { accountId: rent, amount: 15 }] });
    await admin.put(`/deposits/${dep}`, { date: '2026-03-05', accountId: checking, incomeIds: [u1, u2], memo: 'Weekly deposit' });
    await admin.put(`/income/${u1}`, { date: '2026-03-03', amount: 30, accountId: undeposited, fundId: general, lines: [{ accountId: grants, amount: 30, fundId: general }] }); // reposts the deposit's GL
    await admin.put(`/journal-entries/${je}`, { date: '2026-03-05', memo: 'Split', lines: [{ accountId: checking, debit: 6 }, { accountId: checking, debit: 4 }, { accountId: grants, credit: 10 }] });
    await admin.put(`/transfers/${tr}`, { date: '2026-03-06', fromAccountId: checking, toAccountId: savings, amount: 5, memo: 'Renamed' });
    assert.equal((await admin.get(`/expenses/${exp}`)).lines.length, 2);
  });

  await t.test('the app refuses changes to the total', async () => {
    await assert.rejects(admin.put(`/expenses/${exp}`, { date: '2026-03-02', amount: 45, accountId: checking, lines: [{ accountId: office, amount: 45 }] }), /completed reconciliation/);
    await assert.rejects(admin.put(`/expenses/${exp}`, { date: '2026-03-02', amount: 40, accountId: card, lines: [{ accountId: office, amount: 40 }] }), /completed reconciliation/);
    await assert.rejects(admin.put(`/deposits/${dep}`, { date: '2026-03-04', accountId: checking, incomeIds: [u1] }), /completed reconciliation/);
    await assert.rejects(admin.put(`/journal-entries/${je}`, { date: '2026-03-05', lines: [{ accountId: checking, debit: 12 }, { accountId: grants, credit: 12 }] }), /completed reconciliation/);
    await assert.rejects(admin.put(`/transfers/${tr}`, { date: '2026-03-06', fromAccountId: savings, toAccountId: checking, amount: 5 }), /completed reconciliation/);
    for (const [path, id] of [['income', inc], ['expenses', exp], ['deposits', dep], ['journal-entries', je], ['transfers', tr], ['expenses', pay]]) {
      await assert.rejects(admin.del(`/${path}/${id}`), /completed reconciliation/);
    }
  });

  await t.test('the database refuses them too, whatever the code path', async () => {
    const blocked = /completed reconciliation/;
    await assert.rejects(app.db.query('UPDATE transactions SET amount = 999 WHERE id = $1', [exp]), blocked);
    await assert.rejects(app.db.query('UPDATE transactions SET account_id = $1 WHERE id = $2', [savings, inc]), blocked);
    await assert.rejects(app.db.query(`UPDATE gl_details SET credit = 1 WHERE gl_header_id IN (SELECT id FROM gl_headers WHERE transaction_id = $1) AND credit > 0`, [exp]), /total to that account \(40\.00\)/);
    await assert.rejects(app.db.query('DELETE FROM transactions WHERE id = $1', [tr]), blocked);
    await assert.rejects(app.db.query('DELETE FROM gl_headers WHERE transaction_id = $1', [je]), blocked);
    // Rewriting the ledger lines with the same total inside one transaction (what a save does) is fine.
    const client = await app.db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [h] } = await client.query(`SELECT id, organization_id, date FROM gl_headers WHERE transaction_id = $1`, [exp]);
      await client.query('DELETE FROM gl_headers WHERE id = $1', [h.id]);
      const { rows: [nh] } = await client.query(`INSERT INTO gl_headers (organization_id, date, transaction_id, entry_kind, description) VALUES ($1,$2,$3,'transaction','Expense') RETURNING id`, [h.organization_id, h.date, exp]);
      await client.query('INSERT INTO gl_details (gl_header_id, account_id, debit, credit) VALUES ($1,$2,0,40),($1,$3,40,0)', [nh.id, checking, office]);
      await client.query('COMMIT');
    } finally { client.release(); }
    // The API reports database refusals as a 409 with the explanation.
    const res = await fetch(`${app.base}/expenses/${exp}`, { method: 'DELETE', headers: { Cookie: admin.cookie } });
    assert.equal(res.status, 409);
  });

  await t.test('undoing the reconciliation releases the lock; completing again locks the new totals', async () => {
    await admin.post(`/reconciliations/${rec}/undo`);
    assert.equal((await app.db.query('SELECT COUNT(*)::int AS n FROM reconciled_totals WHERE reconciliation_id = $1', [rec])).rows[0].n, 0);
    await admin.put(`/expenses/${exp}`, { date: '2026-03-02', amount: 45, accountId: checking, lines: [{ accountId: office, amount: 45 }] });
    await admin.put(`/reconciliations/${rec}`, { accountId: checking, statementDate: '2026-03-31', statementEndingBalance: 60, clearedIds: [inc, exp, dep, je, tr, pay], complete: true });
    const { rows } = await app.db.query('SELECT net_cents FROM reconciled_totals WHERE reconciliation_id = $1 AND transaction_id = $2', [rec, exp]);
    assert.equal(Number(rows[0].net_cents), -4500);
    await assert.rejects(app.db.query('UPDATE transactions SET amount = 40 WHERE id = $1', [exp]), /completed reconciliation/);
  });

  await t.test('transactions not in a completed reconciliation are unaffected', async () => {
    const other = (await admin.post('/expenses', { date: '2026-04-02', amount: 10, accountId: checking, lines: [{ accountId: office, amount: 10 }] })).id;
    await admin.put(`/expenses/${other}`, { date: '2026-04-02', amount: 12, accountId: checking, lines: [{ accountId: office, amount: 12 }] });
    // In a reconciliation still in progress, changing the amount just makes it uncleared again.
    const rec2 = (await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-04-30', statementEndingBalance: 48, clearedIds: [other] })).id;
    await admin.put(`/expenses/${other}`, { date: '2026-04-02', amount: 13, accountId: checking, lines: [{ accountId: office, amount: 13 }] });
    await admin.del(`/expenses/${other}`);
    await admin.del(`/reconciliations/${rec2}`);
  });
});
