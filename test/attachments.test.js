// Attachments and Claude document extraction tests (the Anthropic client is a fake).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

process.env.ENCRYPTION_KEY ||= 'test-encryption-key'; // organizations' Claude API keys are stored encrypted
const CLAUDE_KEY = 'sk-ant-test-0123456789abcdefghijklmnop';

let app;
let calls = [];
let nextAnswer = null;
let nextError = null;
before(async () => {
  app = await startTestServer('npacct_test_attach');
  const extraction = await import('../server/services/extraction.js');
  extraction.setAnthropicClient({
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          if (nextError) { const e = nextError; nextError = null; throw e; }
          return { model: params.model, stop_reason: nextAnswer.stop_reason || 'end_turn', content: [{ type: 'text', text: JSON.stringify(nextAnswer.json) }] };
        },
      },
    },
  });
});
after(async () => { await app?.stop(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const upload = (c, fileName, buf, extra = {}) => c.post('/attachments', { fileName, data: buf.toString('base64'), ...extra });

test('attachments and extraction', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Attach Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Attach Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, savings, card, contributions, office, rent] = ['1000', '1010', '2000', '4000', '5300', '5200'].map(acct);
  const general = lk.funds[0].id;
  const staples = (await admin.post('/companies', { name: 'Staples' })).id;

  await t.test('each organization stores its own Claude API key, encrypted; it is never sent back', async () => {
    const before = await admin.get('/attachments/claude-key');
    assert.deepEqual([before.configured, before.saved, before.hint, before.encryptionAvailable], [false, false, null, true]);
    assert.equal((await admin.get('/attachments/config')).extractionEnabled, false);
    const pdf0 = await upload(admin, 'early.pdf', PDF);
    await assert.rejects(admin.post(`/attachments/${pdf0.id}/extract`, { type: 'expense' }), /add a Claude API key under Organization Settings/);
    await assert.rejects(admin.put('/attachments/claude-key', { apiKey: 'not-a-key' }), /start with sk-ant-/);
    const saved = await admin.put('/attachments/claude-key', { apiKey: `  ${CLAUDE_KEY}  ` });
    assert.equal(saved.hint, 'mnop');
    const k = await admin.get('/attachments/claude-key');
    assert.deepEqual([k.configured, k.saved, k.hint, k.updated_by], [true, true, 'mnop', 'Admin']);
    assert.ok(!JSON.stringify(k).includes('0123456789'), 'the key never reaches the browser');
    const { rows: [row] } = await app.db.query('SELECT api_key_enc FROM organization_claude_keys WHERE organization_id = $1', [org.id]);
    assert.match(row.api_key_enc, /^v1:/);
    assert.ok(!row.api_key_enc.includes('0123456789'), 'stored encrypted');
    assert.ok(!JSON.stringify(await admin.get('/org')).includes(row.api_key_enc), 'not part of the organization record');
    assert.equal((await admin.get('/attachments/config')).extractionEnabled, true);
    // Another organization has no key until it adds its own
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.equal((await admin.get('/attachments/claude-key')).configured, false);
    await admin.post('/auth/select-org', { organizationId: org.id });
    // Only organization administrators can change it
    await admin.post('/admin/users', { username: 'clerk', password: 'clerk-password', role: 'user' });
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    assert.equal((await clerk.get('/attachments/claude-key')).configured, true);
    await assert.rejects(clerk.put('/attachments/claude-key', { apiKey: CLAUDE_KEY }), /administrator/);
    await assert.rejects(clerk.del('/attachments/claude-key'), /administrator/);
    // Removing it turns Claude off; adding it back turns it on
    await admin.del('/attachments/claude-key');
    assert.equal((await admin.get('/attachments/claude-key')).configured, false);
    await admin.put('/attachments/claude-key', { apiKey: CLAUDE_KEY });
  });

  let expenseId;
  await t.test('attach files to a saved expense', async () => {
    expenseId = (await admin.post('/expenses', { date: '2026-03-01', amount: 40, accountId: checking, fundId: general, lines: [{ accountId: office, amount: 40, fundId: general }] })).id;
    const a = await upload(admin, 'receipt.pdf', PDF, { transactionId: expenseId });
    assert.deepEqual([a.file_name, a.content_type, a.size_bytes, a.transaction_id, a.can_extract, a.created_by], ['receipt.pdf', 'application/pdf', PDF.length, expenseId, true, 'Admin']);
    await upload(admin, 'notes.docx', Buffer.from('PK fake docx'), { transactionId: expenseId });
    const list = await admin.get(`/attachments?transactionId=${expenseId}`);
    assert.deepEqual(list.map((x) => [x.file_name, x.can_extract]), [['receipt.pdf', true], ['notes.docx', false]]);
    // Download the file back
    const res = await fetch(`${app.base}/attachments/${a.id}/file`, { headers: { Cookie: admin.cookie } });
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="receipt.pdf"/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
    const dl = await fetch(`${app.base}/attachments/${list[1].id}/file`, { headers: { Cookie: admin.cookie } });
    assert.match(dl.headers.get('content-disposition'), /^attachment;/, 'non-viewable types always download');
  });

  await t.test('validation', async () => {
    await assert.rejects(upload(admin, 'evil.html', Buffer.from('<script>')), /can't be attached/);
    await assert.rejects(upload(admin, 'fake.png', Buffer.from('<html>not a png</html>')), /doesn't look like a valid PNG/);
    await assert.rejects(upload(admin, 'empty.pdf', Buffer.alloc(0)), /missing|empty/);
    await assert.rejects(upload(admin, 'big.pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])), /at most 10 MB/);
    const deposit = await app.db.query(`INSERT INTO transactions (organization_id, transaction_type, date, amount) VALUES ($1, 'deposit', '2026-03-02', 0) RETURNING id`, [org.id]);
    await assert.rejects(upload(admin, 'slip.pdf', PDF, { transactionId: deposit.rows[0].id }), /income, expenses, bills, bank transfers, journal entries and reconciliations/);
  });

  await t.test('pending uploads are linked when a new record is saved', async () => {
    const p1 = await upload(admin, 'scan.png', PNG);
    assert.equal(p1.transaction_id, null);
    assert.deepEqual((await admin.get(`/attachments?ids=${p1.id}`)).map((x) => x.id), [p1.id]);
    const tr = (await admin.post('/transfers', { date: '2026-03-03', fromAccountId: checking, toAccountId: savings, amount: 25 })).id;
    assert.equal((await admin.post('/attachments/link', { ids: [p1.id], transactionId: tr })).linked, 1);
    assert.deepEqual((await admin.get(`/attachments?transactionId=${tr}`)).map((x) => x.file_name), ['scan.png']);
    // Already linked files can't be moved by linking again
    assert.equal((await admin.post('/attachments/link', { ids: [p1.id], transactionId: expenseId })).linked, 0);
    // Tuition records
    await admin.put('/org', { ...(await admin.get('/org')), tuition_enabled: true });
    const tuit = (await admin.post('/tuition', { companyId: staples, date: '2026-03-01', amount: 100 })).id;
    const p2 = await upload(admin, 'agreement.pdf', PDF);
    await admin.post('/attachments/link', { ids: [p2.id], tuitionId: tuit });
    assert.deepEqual((await admin.get(`/attachments?tuitionId=${tuit}`)).map((x) => x.file_name), ['agreement.pdf']);
    // Deleting the record deletes its files
    await admin.del(`/transfers/${tr}`);
    await assert.rejects(admin.get(`/attachments/${p1.id}/file`), /not found/i);
  });

  await t.test('saved prompts per transaction type', async () => {
    const p = await admin.get('/attachments/prompts');
    assert.deepEqual(p.prompts.map((x) => x.type), ['income', 'expense', 'bill', 'transfer', 'journal', 'tuition', 'statement', 'classify']);
    assert.ok(p.prompts.every((x) => x.isDefault && x.prompt.length > 20));
    await admin.put('/attachments/prompts/expense', { prompt: 'Always code office purchases to Office Supplies.' });
    const after = (await admin.get('/attachments/prompts')).prompts.find((x) => x.type === 'expense');
    assert.deepEqual([after.prompt, after.isDefault, after.updated_by], ['Always code office purchases to Office Supplies.', false, 'Admin']);
    await assert.rejects(admin.put('/attachments/prompts/expense', { prompt: '  ' }), /can’t be empty/);
    await assert.rejects(admin.put('/attachments/prompts/deposit', { prompt: 'x' }), /Unknown/);
  });

  await t.test('extracts an expense with the saved prompt and the org\'s lists', async () => {
    const att = (await admin.get(`/attachments?transactionId=${expenseId}`))[0];
    calls = [];
    nextAnswer = {
      json: {
        date: '2026-02-27', amount: 41.237, companyId: staples, companyName: 'STAPLES #123', checkNumber: null, refNumber: 'INV-88',
        bankAccountId: card, fundId: general, memo: 'Printer paper', notes: 'Tax included',
        lines: [{ accountId: office, amount: 30, memo: 'Paper', fundId: null }, { accountId: rent, amount: 11.24, memo: 'Toner', fundId: 999999 }, { accountId: checking, amount: 1, memo: 'bank as expense', fundId: null }],
      },
    };
    const r = await admin.post(`/attachments/${att.id}/extract`, { type: 'expense' });
    const req = calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(req.fallbacks, 'default');
    const [doc, text] = req.messages[0].content;
    assert.deepEqual([doc.type, doc.source.media_type, Buffer.from(doc.source.data, 'base64').equals(PDF)], ['document', 'application/pdf', true]);
    assert.match(text.text, /Always code office purchases to Office Supplies\./);
    assert.match(text.text, new RegExp(`${staples} \\| Staples`));
    assert.match(text.text, new RegExp(`${office} \\| 5300 Office Supplies \\| Expense`));
    assert.deepEqual(r.fields, {
      date: '2026-02-27', memo: 'Printer paper', amount: '41.24', fundId: general, refNumber: 'INV-88', companyId: staples, companyName: 'STAPLES #123',
      checkNumber: null, bankAccountId: card,
      lines: [{ accountId: office, amount: '30.00', memo: 'Paper', fundId: null }, { accountId: rent, amount: '11.24', memo: 'Toner', fundId: null }, { accountId: null, amount: '1.00', memo: 'bank as expense', fundId: null }],
    });
    assert.equal(r.notes, 'Tax included');
    assert.ok(r.warnings.some((w) => /suggested account/.test(w)));
    assert.ok((await admin.get(`/attachments?transactionId=${expenseId}`))[0].extracted_at);
  });

  await t.test('other transaction types', async () => {
    const pending = await upload(admin, 'photo.png', PNG);
    nextAnswer = { json: { date: '2026-03-05', amount: 500, fromAccountId: checking, toAccountId: checking, fundId: null, refNumber: 'CONF1', memo: 'Move', notes: null } };
    const tr = await admin.post(`/attachments/${pending.id}/extract`, { type: 'transfer' });
    assert.equal(calls.at(-1).messages[0].content[0].type, 'image');
    assert.deepEqual([tr.fields.fromAccountId, tr.fields.toAccountId, tr.fields.amount], [checking, null, '500.00']);
    assert.ok(tr.warnings.some((w) => /same account/.test(w)));
    assert.doesNotMatch(calls.at(-1).messages[0].content[1].text, /Staples/, 'no customer list for transfers');

    nextAnswer = { json: { date: '2026-03-31', fundId: general, memo: 'Accrue', notes: null, lines: [{ accountId: rent, fundId: null, memo: 'Rent', debit: 900, credit: null }, { accountId: checking, fundId: null, memo: null, debit: null, credit: 800 }] } };
    const je = await admin.post(`/attachments/${pending.id}/extract`, { type: 'journal' });
    assert.deepEqual(je.fields.lines.map((l) => [l.debit, l.credit]), [['900.00', null], [null, '800.00']]);
    assert.ok(je.warnings.some((w) => /don’t balance/.test(w)));

    nextAnswer = { json: { date: '2026-08-15', amount: 4800, companyId: null, companyName: 'The Rivera Family', description: '2026-27 Tuition', incomeAccountId: office, fundId: null, memo: null, notes: null } };
    const tu = await admin.post(`/attachments/${pending.id}/extract`, { type: 'tuition' });
    assert.deepEqual([tu.fields.companyId, tu.fields.companyName, tu.fields.incomeAccountId, tu.fields.description], [null, 'The Rivera Family', null, '2026-27 Tuition']);
    assert.ok(tu.warnings.some((w) => /Rivera Family/.test(w)));

    nextAnswer = { json: { date: 'yesterday', amount: 75, companyId: null, companyName: null, checkNumber: '1042', refNumber: null, bankAccountId: null, fundId: null, memo: 'Gift', notes: null, lines: [{ accountId: contributions, amount: 75, memo: null, fundId: null }] } };
    const inc = await admin.post(`/attachments/${pending.id}/extract`, { type: 'income' });
    assert.deepEqual([inc.fields.date, inc.fields.checkNumber, inc.fields.lines[0].accountId], [null, '1042', contributions]);
    assert.match(calls.at(-1).messages[0].content[1].text, /donation check/, 'standard income prompt');
  });

  await t.test('errors', async () => {
    const docx = (await admin.get(`/attachments?transactionId=${expenseId}`))[1];
    await assert.rejects(admin.post(`/attachments/${docx.id}/extract`, { type: 'expense' }), /Save this document as a PDF/);
    const pdf = (await admin.get(`/attachments?transactionId=${expenseId}`))[0];
    await assert.rejects(admin.post(`/attachments/${pdf.id}/extract`, { type: 'deposit' }), /Unknown transaction type/);
    nextAnswer = { stop_reason: 'refusal', json: {} };
    await assert.rejects(admin.post(`/attachments/${pdf.id}/extract`, { type: 'expense' }), /declined/);
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    nextError = new Anthropic.RateLimitError(429, { error: { message: 'rate' } }, 'rate', new Headers());
    await assert.rejects(admin.post(`/attachments/${pdf.id}/extract`, { type: 'expense' }), /busy/);
  });

  await t.test('private to the organization', async () => {
    const att = (await admin.get(`/attachments?transactionId=${expenseId}`))[0];
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.get(`/attachments/${att.id}/file`), /not found/i);
    await assert.rejects(admin.get(`/attachments?transactionId=${expenseId}`), /not found/i);
    await assert.rejects(admin.post(`/attachments/${att.id}/extract`, { type: 'expense' }), /not found/i);
    await assert.rejects(admin.del(`/attachments/${att.id}`), /not found/i);
    const mine = await upload(admin, 'x.pdf', PDF);
    assert.equal((await admin.post('/attachments/link', { ids: [mine.id], transactionId: expenseId }).catch((e) => e)).status, 404);
    assert.ok((await admin.get('/attachments/prompts')).prompts.find((x) => x.type === 'expense').isDefault, 'prompts are per organization');
    await admin.post('/auth/select-org', { organizationId: org.id });
    await admin.del(`/attachments/${att.id}`);
    assert.equal((await admin.get(`/attachments?transactionId=${expenseId}`)).length, 1);
  });
});
