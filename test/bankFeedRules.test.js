// Bank feed line assignments (customer / vendor and account) and bank feed rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_feed_rules'); });
after(async () => { await app?.stop(); });

test('bank feed rules', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Rules Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Rules Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, card, contributions, supplies, rent, office, bankFees] = ['1000', '2000', '4000', '5100', '5200', '5300', '5500'].map(a);
  const fuel = supplies; // stand-ins: "Fuel" and "Food"
  const food = office;
  const caseys = (await admin.post('/companies', { name: 'Caseys' })).id;
  const landlord = (await admin.post('/companies', { name: 'Landlord LLC', default_expense_account_id: rent, default_income_account_id: contributions })).id;

  const lines = async (accountId = checking) => (await admin.get(`/bank-feed?accountId=${accountId}`)).items;
  const by = async (desc, accountId) => (await lines(accountId)).find((i) => i.description === desc);
  const pick = (i) => [i.company_id, i.assigned_account_id, i.assigned_by];
  const importLines = (items, accountId = checking) => admin.post('/bank-feed/import', { accountId, items });

  await importLines([
    { date: '2026-09-01', description: 'CASEYS #2231 FUEL', amount: -45.2 },
    { date: '2026-09-02', description: 'Caseys General Store', amount: -6.5 },
    { date: '2026-09-03', description: 'CASEYS REFUND', amount: 12 },
    { date: '2026-09-04', description: 'ACH RENT PAYMENT', amount: -1500 },
    { date: '2026-09-05', description: 'MONTHLY SERVICE FEE', amount: -10 },
  ]);

  let fuelRule;
  let foodRule;
  await t.test('rules validate their fields', async () => {
    const rule = (over) => admin.post('/bank-feed-rules', { matchText: 'x', accountId: fuel, ...over });
    await assert.rejects(rule({ matchText: '  ' }), /Enter the text/);
    await assert.rejects(rule({ accountId: null }), /customer \/ vendor, the account, or both/);
    await assert.rejects(rule({ minAmount: 10, maxAmount: 10 }), /must be more than Amount from/);
    await assert.rejects(rule({ maxAmount: 0 }), /more than zero/);
    await assert.rejects(rule({ bankAccountId: office }), /Bank or Credit Card/);
    assert.deepEqual(await admin.get('/bank-feed-rules'), []);
  });

  await t.test('rules assign existing unmatched lines by text, direction and amount range', async () => {
    fuelRule = (await admin.post('/bank-feed-rules', { name: 'Caseys fuel', matchText: 'caseys', direction: 'out', minAmount: 10, companyId: caseys, accountId: fuel })).id;
    const r = await admin.post('/bank-feed-rules', { matchText: 'CASEYS', direction: 'out', maxAmount: '10.00', companyId: caseys, accountId: food });
    foodRule = r.id;
    assert.equal(r.assigned, 2);
    assert.deepEqual(pick(await by('CASEYS #2231 FUEL')), [caseys, fuel, 'rule']);
    assert.equal((await by('CASEYS #2231 FUEL')).rule_name, 'Caseys fuel');
    assert.deepEqual(pick(await by('Caseys General Store')), [caseys, food, 'rule']);
    assert.equal((await by('Caseys General Store')).rule_name, 'CASEYS', 'a rule without a name shows its text');
    assert.deepEqual(pick(await by('CASEYS REFUND')), [null, null, null], 'money in doesn’t match an "out" rule');
    // At exactly $10: "from 10" matches, "under 10" doesn't
    await importLines([{ date: '2026-09-06', description: 'CASEYS 10 EVEN', amount: -10 }]);
    assert.deepEqual(pick(await by('CASEYS 10 EVEN')), [caseys, fuel, 'rule']);
  });

  await t.test('a rule that sets only the customer / vendor uses its default account for the direction', async () => {
    await admin.post('/bank-feed-rules', { matchText: 'rent', companyId: landlord });
    assert.deepEqual(pick(await by('ACH RENT PAYMENT')), [landlord, rent, 'rule']);
    // A rule limited to another bank account doesn't apply
    await admin.post('/bank-feed-rules', { matchText: 'SERVICE FEE', accountId: bankFees, bankAccountId: card });
    assert.deepEqual(pick(await by('MONTHLY SERVICE FEE')), [null, null, null]);
    await importLines([{ date: '2026-09-07', description: 'CARD SERVICE FEE', amount: -5 }], card);
    assert.deepEqual(pick(await by('CARD SERVICE FEE', card)), [null, bankFees, 'rule']);
  });

  await t.test('lines assigned by hand keep their values; clearing them lets rules apply again', async () => {
    const line = await by('Caseys General Store');
    const r = await admin.put(`/bank-feed/${line.id}/assign`, { companyId: caseys, accountId: rent });
    assert.deepEqual([...pick(r), r.rule_name], [caseys, rent, 'user', null]);
    await admin.put(`/bank-feed-rules/${foodRule}`, { matchText: 'caseys', direction: 'out', maxAmount: 10, companyId: caseys, accountId: office });
    assert.deepEqual(pick(await by('Caseys General Store')), [caseys, rent, 'user']);
    const cleared = await admin.put(`/bank-feed/${line.id}/assign`, { companyId: null, accountId: null });
    assert.deepEqual(pick(cleared), [caseys, food, 'rule']);
    await assert.rejects(admin.put(`/bank-feed/${line.id}/assign`, { accountId: checking }), /other than the bank account itself/);
  });

  await t.test('the first matching rule wins; reordering and deleting re-apply the rules', async () => {
    const all = await admin.get('/bank-feed-rules');
    assert.deepEqual(all.map((x) => x.match_text), ['caseys', 'caseys', 'rent', 'SERVICE FEE']);
    // A broader Caseys rule moved to the top takes over
    const broad = (await admin.post('/bank-feed-rules', { matchText: 'caseys', accountId: bankFees })).id;
    assert.deepEqual(pick(await by('CASEYS REFUND')), [null, bankFees, 'rule']);
    assert.deepEqual(pick(await by('CASEYS #2231 FUEL')), [caseys, fuel, 'rule']);
    await admin.put('/bank-feed-rules/order', { ids: [broad, ...all.map((x) => x.id)] });
    assert.deepEqual(pick(await by('CASEYS #2231 FUEL')), [null, bankFees, 'rule']);
    await assert.rejects(admin.put('/bank-feed-rules/order', { ids: [broad] }), /every rule once/);
    await admin.del(`/bank-feed-rules/${broad}`);
    assert.deepEqual(pick(await by('CASEYS #2231 FUEL')), [caseys, fuel, 'rule']);
    assert.deepEqual(pick(await by('CASEYS REFUND')), [null, null, null]);
    // Inactive rules don't apply
    await admin.put(`/bank-feed-rules/${fuelRule}`, { name: 'Caseys fuel', matchText: 'caseys', direction: 'out', minAmount: 10, companyId: caseys, accountId: fuel, isActive: false });
    assert.deepEqual(pick(await by('CASEYS #2231 FUEL')), [null, null, null]);
  });

  await t.test('matched lines keep what they had; rules and assignments only touch unmatched lines', async () => {
    const line = await by('ACH RENT PAYMENT');
    const exp = (await admin.post('/expenses', { date: line.date, amount: 1500, accountId: checking, companyId: landlord, lines: [{ accountId: rent, amount: 1500 }] })).id;
    await admin.post(`/bank-feed/${line.id}/match`, { transactionId: exp });
    await assert.rejects(admin.put(`/bank-feed/${line.id}/assign`, { accountId: office }), /aren’t matched or ignored/);
    await admin.post('/bank-feed-rules/apply');
    const { rows: [row] } = await app.db.query('SELECT company_id, assigned_account_id FROM bank_feed_items WHERE id = $1', [line.id]);
    assert.deepEqual([row.company_id, row.assigned_account_id], [landlord, rent]);
  });

  await t.test('rules are private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.deepEqual(await admin.get('/bank-feed-rules'), []);
    await assert.rejects(admin.put(`/bank-feed-rules/${foodRule}`, { matchText: 'x', accountId: null }), /not found/);
    await assert.rejects(admin.del(`/bank-feed-rules/${foodRule}`), /not found/);
    const lk2 = await admin.get('/lookups');
    await assert.rejects(admin.post('/bank-feed-rules', { matchText: 'x', companyId: caseys }), /Invalid customer/);
    await assert.rejects(admin.post('/bank-feed-rules', { matchText: 'x', accountId: fuel }), /Invalid account/);
    assert.ok(lk2.accounts.length);
  });
});
