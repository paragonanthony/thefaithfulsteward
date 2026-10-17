// Tuition tracking tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_tuition'); });
after(async () => { await app?.stop(); });

test('tuition tracking', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Academy' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, fees, supplies] = [acct('1000'), acct('4200'), acct('5100')];
  const general = lk.funds[0].id;
  const families = [];
  for (const name of ['Adams Family', 'Baker Family', 'Chen Family']) families.push((await admin.post('/companies', { name })).id);
  const [adams, baker, chen] = families;

  await t.test('disabled until turned on in organization settings', async () => {
    await assert.rejects(admin.get('/tuition'), (e) => e.status === 403);
    assert.equal((await admin.get('/auth/me')).currentOrganization.tuition_enabled, false);
    const o = await admin.get('/org');
    await admin.put('/org', { ...o, tuition_enabled: true });
    assert.equal((await admin.get('/auth/me')).currentOrganization.tuition_enabled, true);
    assert.deepEqual(await admin.get('/tuition'), []);
  });

  let adamsFall;
  await t.test('create a tuition record', async () => {
    await assert.rejects(admin.post('/tuition', { date: '2026-08-15', amount: 100 }), /Customer is required/);
    await assert.rejects(admin.post('/tuition', { companyId: adams, date: '2026-08-15', amount: 0 }), /greater than zero/);
    await assert.rejects(admin.post('/tuition', { companyId: adams, date: '2026-08-15', amount: 10, incomeAccountId: supplies }), /income account/);
    adamsFall = (await admin.post('/tuition', { companyId: adams, date: '2026-08-15', amount: 4800, description: 'Fall 2026', incomeAccountId: fees, fundId: general })).id;
    const rec = await admin.get(`/tuition/${adamsFall}`);
    assert.deepEqual([rec.company_name, Number(rec.amount), Number(rec.paid), Number(rec.balance)], ['Adams Family', 4800, 0, 4800]);
  });

  await t.test('create multiple records at once (duplicates skipped)', async () => {
    const r = await admin.post('/tuition/bulk', { companyIds: [baker, chen], date: '2026-08-15', amount: 5200, description: 'Fall 2026', incomeAccountId: fees });
    assert.equal(r.created, 2);
    const again = await admin.post('/tuition/bulk', { companyIds: [adams, baker, chen], date: '2026-08-15', amount: 5200, description: 'Fall 2026' });
    assert.equal(again.created, 0, 'Adams already has a Fall 2026 record on that date too');
    assert.equal(again.skipped.length, 3);
    const spring = await admin.post('/tuition/bulk', { companyIds: [adams, baker, chen], date: '2027-01-10', amount: 2500, description: 'Spring 2027' });
    assert.equal(spring.created, 3);
    assert.equal((await admin.get('/tuition')).length, 6);
    await assert.rejects(admin.post('/tuition/bulk', { companyIds: [], date: '2026-08-15', amount: 1 }), /at least one customer/);
  });

  let pay1;
  await t.test('income linked to tuition updates paid and balance', async () => {
    const bakerFall = (await admin.get(`/tuition?companyId=${baker}`)).find((x) => x.description === 'Fall 2026');
    pay1 = (await admin.post('/income', {
      date: '2026-09-01', amount: 1200, accountId: checking, companyId: adams,
      lines: [{ accountId: fees, amount: 1200, tuitionId: adamsFall }],
    })).id;
    let rec = await admin.get(`/tuition/${adamsFall}`);
    assert.deepEqual([Number(rec.paid), Number(rec.balance)], [1200, 3600]);
    assert.equal(rec.payments.length, 1);
    assert.equal(rec.payments[0].transaction_id, pay1);

    const inc = await admin.get(`/income/${pay1}`);
    assert.equal(inc.lines[0].tuition_id, adamsFall);
    assert.equal(inc.lines[0].tuition_description, 'Fall 2026');

    // Editing the income changes the amount applied
    await admin.put(`/income/${pay1}`, { date: '2026-09-01', amount: 1500, accountId: checking, companyId: adams, lines: [{ accountId: fees, amount: 1500, tuitionId: adamsFall }] });
    rec = await admin.get(`/tuition/${adamsFall}`);
    assert.deepEqual([Number(rec.paid), Number(rec.balance)], [1500, 3300]);

    await assert.rejects(admin.post('/income', {
      date: '2026-09-02', amount: 100, accountId: checking, companyId: adams, lines: [{ accountId: fees, amount: 100, tuitionId: bakerFall.id }],
    }), /different customer/);
    await assert.rejects(admin.post('/expenses', {
      date: '2026-09-02', amount: 100, accountId: checking, companyId: adams, lines: [{ accountId: supplies, amount: 100, tuitionId: adamsFall }],
    }), /Only income/);
  });

  await t.test('one payment can cover several records, and paid-off records leave the open list', async () => {
    const adamsSpring = (await admin.get(`/tuition?companyId=${adams}`)).find((x) => x.description === 'Spring 2027');
    const pay2 = (await admin.post('/income', {
      date: '2026-10-01', amount: 5800, accountId: checking, companyId: adams,
      lines: [{ accountId: fees, amount: 3300, tuitionId: adamsFall }, { accountId: fees, amount: 2500, tuitionId: adamsSpring.id }],
    })).id;
    const open = await admin.get(`/tuition?status=open&companyId=${adams}`);
    assert.equal(open.length, 0);
    const paid = await admin.get(`/tuition?status=paid&companyId=${adams}`);
    assert.equal(paid.length, 2);
    assert.deepEqual((await admin.get(`/tuition?status=open&companyId=${adams}&include=${adamsFall}`)).map((x) => x.id), [adamsFall], 'include keeps a linked record');
    await admin.del(`/income/${pay2}`);
    assert.equal(Number((await admin.get(`/tuition/${adamsFall}`)).balance), 3300, 'deleting income restores the balance');
  });

  await t.test('search', async () => {
    assert.equal((await admin.get('/tuition?search=chen')).length, 2);
    assert.equal((await admin.get('/tuition?search=spring')).length, 3);
  });

  await t.test('records with payments cannot be deleted or moved to another customer', async () => {
    const rec = await admin.get(`/tuition/${adamsFall}`);
    await assert.rejects(admin.del(`/tuition/${adamsFall}`), /has payments/);
    await assert.rejects(admin.put(`/tuition/${adamsFall}`, { ...rec, companyId: baker, incomeAccountId: rec.income_account_id, fundId: rec.fund_id }), /customer cannot be changed/);
    await admin.put(`/tuition/${adamsFall}`, { companyId: adams, date: rec.date, amount: 5000, description: 'Fall 2026 (revised)', incomeAccountId: fees });
    assert.equal(Number((await admin.get(`/tuition/${adamsFall}`)).balance), 3500);
    const chenSpring = (await admin.get(`/tuition?companyId=${chen}`)).find((x) => x.description === 'Spring 2027');
    await admin.del(`/tuition/${chenSpring.id}`);
  });

  await t.test('tuition records are private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    const o = await admin.get('/org');
    await admin.put('/org', { ...o, tuition_enabled: true });
    assert.equal((await admin.get('/tuition')).length, 0);
    await assert.rejects(admin.get(`/tuition/${adamsFall}`), /not found/);
    const lk2 = await admin.get('/lookups');
    const fam = (await admin.post('/companies', { name: 'Other Family' })).id;
    await assert.rejects(admin.post('/income', {
      date: '2026-09-01', amount: 10, accountId: lk2.accounts.find((a) => a.account_number === '1000').id, companyId: fam,
      lines: [{ accountId: lk2.accounts.find((a) => a.account_number === '4200').id, amount: 10, tuitionId: adamsFall }],
    }), /Invalid tuition record/);
    await assert.rejects(admin.post('/tuition/bulk', { companyIds: [adams], date: '2026-08-15', amount: 1 }), /Invalid customer/);
  });
});
