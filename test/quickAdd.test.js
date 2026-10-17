// Bank feed Quick Add: create the income / expense straight from a line that has an account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_quick_add'); });
after(async () => { await app?.stop(); });

test('bank feed quick add', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Quick Add Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Quick Add Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, contributions, office] = ['1000', '4000', '5300'].map(a);
  const youth = (await admin.post('/funds', { name: 'Youth' })).id;
  await admin.put(`/accounts/${office}`, { ...(await admin.get(`/accounts/${office}`)), default_fund_id: youth });
  const staples = (await admin.post('/companies', { name: 'Staples' })).id;
  await admin.post('/bank-feed/import', {
    accountId: checking,
    items: [
      { date: '2026-05-01', description: 'STAPLES 0042', amount: -42.1 },
      { date: '2026-05-02', description: 'MOBILE DEPOSIT', amount: 250 },
      { date: '2026-05-03', description: 'UNKNOWN', amount: -9 },
    ],
  });
  const by = async (desc, status = 'unmatched') => (await admin.get(`/bank-feed?accountId=${checking}&status=${status}`)).items.find((i) => i.description === desc);

  await t.test('money out becomes an expense with the line’s account, vendor and the account’s default fund', async () => {
    const line = await by('STAPLES 0042');
    await admin.put(`/bank-feed/${line.id}/assign`, { companyId: staples, accountId: office });
    const r = await admin.post(`/bank-feed/${line.id}/quick-add`);
    assert.equal(r.type, 'expense');
    const e = await admin.get(`/expenses/${r.id}`);
    assert.deepEqual([e.date, Number(e.amount), e.account_id, e.company_id, e.memo, e.transaction_method], ['2026-05-01', 42.1, checking, staples, 'STAPLES 0042', 'electronic']);
    assert.deepEqual(e.lines.map((l) => [l.account_id, Number(l.amount), l.fund_id]), [[office, 42.1, youth]]);
    const matched = await by('STAPLES 0042', 'matched');
    assert.equal(matched.transaction_id, r.id);
    await assert.rejects(admin.post(`/bank-feed/${line.id}/quick-add`), /already matched/);
  });

  await t.test('money in becomes income; the customer / vendor is optional', async () => {
    const line = await by('MOBILE DEPOSIT');
    await admin.put(`/bank-feed/${line.id}/assign`, { accountId: contributions });
    const r = await admin.post(`/bank-feed/${line.id}/quick-add`);
    assert.equal(r.type, 'income');
    const inc = await admin.get(`/income/${r.id}`);
    assert.deepEqual([Number(inc.amount), inc.account_id, inc.company_id, inc.lines[0].account_id], [250, checking, null, contributions]);
  });

  await t.test('a line needs an account; closed periods and other organizations are refused', async () => {
    const line = await by('UNKNOWN');
    await assert.rejects(admin.post(`/bank-feed/${line.id}/quick-add`), /Choose an account/);
    await admin.put(`/bank-feed/${line.id}/assign`, { accountId: office });
    await admin.put('/period-closing', { closingDate: '2026-05-31' });
    await assert.rejects(admin.post(`/bank-feed/${line.id}/quick-add`), /closed/);
    await admin.put('/period-closing', { closingDate: null });
    assert.ok(await by('UNKNOWN'), 'nothing was saved');
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.post(`/bank-feed/${line.id}/quick-add`), /not found/);
  });
});
