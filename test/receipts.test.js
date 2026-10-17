// Income receipt PDFs (printing / downloading). Receipts are no longer emailed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_receipt_pdfs'); });
after(async () => { await app?.stop(); });

test('receipt PDFs', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Hope Center' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const checking = lk.accounts.find((a) => a.account_number === '1000').id;
  const contributions = lk.accounts.find((a) => a.account_number === '4000').id;
  const jane = await admin.post('/companies', { name: 'Jane Donor', email: 'jane@example.com' });
  const income = (await admin.post('/income', {
    date: '2026-03-01', amount: 150, accountId: checking, companyId: jane.id, method: 'check', checkNumber: '77', lines: [{ accountId: contributions, amount: 150 }],
  })).id;
  // Reads the whole response (an unread body keeps the connection open, and the test server couldn't shut down).
  const pdf = async (id, c = admin, q = '') => {
    const res = await fetch(`${app.base}/receipts/${id}/pdf${q}`, { headers: { Cookie: c.cookie } });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  };

  await t.test('a receipt can be viewed or downloaded as a PDF', async () => {
    const view = await pdf(income);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('content-type'), 'application/pdf');
    assert.match(view.headers.get('content-disposition'), /^inline; filename="Receipt-\d+\.pdf"/);
    const dl = await pdf(income, admin, '?download=1');
    assert.match(dl.headers.get('content-disposition'), /^attachment;/);
    assert.equal(dl.body.subarray(0, 5).toString(), '%PDF-');
  });

  await t.test('emailing is gone', async () => {
    await assert.rejects(admin.post(`/receipts/${income}/email`, { to: 'x@example.com' }), (e) => e.status === 404);
    await assert.rejects(admin.post('/receipts/email-batch', { incomeIds: [income] }), (e) => e.status === 404);
    await assert.rejects(admin.get('/m365/status'), (e) => e.status === 404);
    const list = await admin.get('/income?page=1');
    assert.equal('receipt_emailed_at' in list.rows[0], false);
  });

  await t.test('receipts are private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.equal((await pdf(income)).status, 404);
  });
});
