// Receipt template API tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_receipts'); });
after(async () => { await app?.stop(); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('receipt templates', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Receipt Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });

  let standard;
  let custom;
  await t.test('a standard default template is created automatically', async () => {
    const list = await admin.get('/receipt-templates');
    assert.equal(list.length, 1);
    standard = list[0];
    assert.equal(standard.is_default, true);
    assert.equal(standard.template.title, 'Donation Receipt');
    assert.match(standard.template.intro, /\{\{donor_name\}\}/);
    assert.equal((await admin.get('/receipt-templates')).length, 1);
  });

  await t.test('templates are validated', async () => {
    custom = await admin.post('/receipt-templates', {
      name: 'Grant receipt',
      template: { title: 'Grant Acknowledgment', accentColor: 'red', fontFamily: 'Papyrus', fontSize: 40, logo: PNG, showLines: false, footer: 'x'.repeat(5000) },
    });
    const tpl = (await admin.get(`/receipt-templates/${custom.id}`)).template;
    assert.equal(tpl.title, 'Grant Acknowledgment');
    assert.equal(tpl.accentColor, '#0e2a46');
    assert.equal(tpl.fontFamily, 'Georgia');
    assert.equal(tpl.fontSize, 16);
    assert.equal(tpl.logo, PNG);
    assert.equal(tpl.showLines, false);
    assert.equal(tpl.footer.length, 1000);
    assert.equal(tpl.showTaxStatement, true, 'missing options get defaults');
  });

  await t.test('only small PNG/JPEG/GIF/WebP images are accepted', async () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    await assert.rejects(admin.put(`/receipt-templates/${custom.id}`, { name: 'x', template: { logo: svg } }), /PNG or JPEG/);
    await assert.rejects(admin.put(`/receipt-templates/${custom.id}`, { name: 'x', template: { logo: 'https://example.com/logo.png' } }), /PNG or JPEG/);
    const huge = `data:image/png;base64,${'A'.repeat(800 * 1024)}`;
    await assert.rejects(admin.put(`/receipt-templates/${custom.id}`, { name: 'x', template: { signatureImage: huge } }), /smaller/);
  });

  await t.test('default can be changed; the default cannot be deleted', async () => {
    await assert.rejects(admin.del(`/receipt-templates/${standard.id}`), /another template the default/);
    await admin.post(`/receipt-templates/${custom.id}/default`);
    assert.deepEqual((await admin.get('/receipt-templates')).filter((x) => x.is_default).map((x) => x.id), [custom.id]);
    await admin.post(`/receipt-templates/${standard.id}/default`);
    await admin.del(`/receipt-templates/${custom.id}`);
    assert.equal((await admin.get('/receipt-templates')).length, 1);
  });

  await t.test('templates are private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/receipt-templates/${standard.id}`), /not found/);
    await assert.rejects(admin.put(`/receipt-templates/${standard.id}`, { name: 'x', template: {} }), /not found/);
    await assert.rejects(admin.post(`/receipt-templates/${standard.id}/default`), /not found/);
    await admin.post('/auth/select-org', { organizationId: org.id });
  });

  await t.test('only organization admins can change templates', async () => {
    await admin.post('/admin/users', { username: 'clerk', password: 'clerk-password', role: 'user' });
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    assert.equal((await clerk.get('/receipt-templates')).length, 1);
    await assert.rejects(clerk.put(`/receipt-templates/${standard.id}`, { name: 'x', template: {} }), /administrator/);
    await assert.rejects(clerk.post('/receipt-templates', { name: 'x', template: {} }), /administrator/);
  });
});
