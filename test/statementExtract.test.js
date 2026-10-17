// Reading PDF / image bank statements into the bank feed with Claude (the Anthropic client is a fake).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

process.env.ENCRYPTION_KEY ||= 'test-encryption-key'; // organizations' Claude API keys are stored encrypted
const CLAUDE_KEY = 'sk-ant-test-0123456789abcdefghijklmnop';

let app;
const calls = [];
let nextAnswer = null;
before(async () => {
  app = await startTestServer('npacct_test_statement');
  const answer = (params) => {
    calls.push(params);
    return { model: params.model, stop_reason: nextAnswer.stop_reason || 'end_turn', content: [{ type: 'text', text: JSON.stringify(nextAnswer.json) }] };
  };
  (await import('../server/services/extraction.js')).setAnthropicClient({
    beta: { messages: { create: async (p) => answer(p), stream: (p) => ({ finalMessage: async () => answer({ ...p, streamed: true }) }) } },
  });
});
after(async () => { await app?.stop(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('statement extraction', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Statement Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Statement Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  await admin.put('/attachments/claude-key', { apiKey: CLAUDE_KEY }); // the organization's own Claude API key
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, card, office] = ['1000', '2000', '5300'].map(acct);
  const extract = (over = {}) => admin.post('/bank-feed/extract-statement', { accountId: checking, fileName: 'june.pdf', data: PDF.toString('base64'), ...over });

  // One line already in the feed from a CSV import
  await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2026-06-05', description: 'DEPOSIT', amount: 1500 }] });

  await t.test('reads a bank statement into lines for review', async () => {
    nextAnswer = { json: {
      accountName: 'Business Checking', last4: '6789', periodStart: '2026-06-01', periodEnd: '2026-06-30', openingBalance: 1000, closingBalance: 2297.55,
      transactions: [
        { date: '2026-06-05', description: 'Deposit', amount: 1500 },
        { date: '2026-06-09', description: 'Check 1042', amount: -200 },
        { date: '2026-06-30', description: 'Service fee', amount: -2.45 },
        { date: 'June 31', description: 'Smudged', amount: -10 },
        { date: '2026-06-15', description: 'Zero line', amount: 0 },
      ],
      notes: 'Page 3 of 3 was blank',
    } };
    const r = await extract();
    const req = calls.at(-1);
    assert.equal(req.streamed, true, 'long answers stream');
    assert.equal(req.max_tokens, 64000);
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.messages[0].content[0].type, 'document');
    assert.match(req.messages[0].content[1].text, /bank account “Operating Checking”/);
    assert.match(req.messages[0].content[1].text, /List every transaction in its activity sections/, 'standard statement prompt');
    assert.deepEqual(r.items.map((i) => [i.date, i.description, i.amount, Boolean(i.possibleDuplicate)]), [
      ['2026-06-05', 'Deposit', '1500.00', true],
      ['2026-06-09', 'Check 1042', '-200.00', false],
      ['2026-06-30', 'Service fee', '-2.45', false],
    ]);
    assert.deepEqual(r.statement, { accountName: 'Business Checking', last4: '6789', periodStart: '2026-06-01', periodEnd: '2026-06-30', openingBalance: '1000.00', closingBalance: '2297.55', balanced: true });
    assert.ok(r.warnings.some((w) => /2 lines were left out/.test(w)));
    assert.equal(r.notes, 'Page 3 of 3 was blank');
    // The reviewed lines are imported with the existing import (duplicates skipped)
    const imp = await admin.post('/bank-feed/import', { accountId: checking, items: r.items.filter((i) => !i.possibleDuplicate) });
    assert.deepEqual(imp, { imported: 2, skipped: 0, assigned: 0 });
  });

  await t.test('flags lines that don’t add up to the balances', async () => {
    nextAnswer = { json: { accountName: null, last4: null, periodStart: '2026-07-01', periodEnd: '2026-07-31', openingBalance: 100, closingBalance: 50, notes: null,
      transactions: [{ date: '2026-07-02', description: 'ATM', amount: -40 }, { date: '2026-08-02', description: 'Late line', amount: -1 }] } };
    const r = await extract({ fileName: 'july.png', data: PNG.toString('base64') });
    assert.equal(calls.at(-1).messages[0].content[0].type, 'image');
    assert.equal(r.statement.balanced, false);
    assert.ok(r.warnings.some((w) => /difference of -9.00/.test(w)), r.warnings.join(' | '));
    assert.ok(r.warnings.some((w) => /outside the statement period/.test(w)));
  });

  await t.test('credit card balances count charges as increasing the amount owed', async () => {
    nextAnswer = { json: { accountName: 'Visa', last4: '4242', periodStart: '2026-06-01', periodEnd: '2026-06-30', openingBalance: 300, closingBalance: 350, notes: null,
      transactions: [{ date: '2026-06-03', description: 'AMAZON', amount: -150 }, { date: '2026-06-20', description: 'PAYMENT - THANK YOU', amount: 100 }] } };
    const r = await extract({ accountId: card });
    assert.match(calls.at(-1).messages[0].content[1].text, /credit card “Credit Card”/);
    assert.equal(r.statement.balanced, true);
  });

  await t.test('uses the saved statement prompt', async () => {
    await admin.put('/attachments/prompts/statement', { prompt: 'Our bank prints withdrawals in parentheses.' });
    nextAnswer = { json: { accountName: null, last4: null, periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null, notes: null, transactions: [] } };
    const r = await extract();
    assert.match(calls.at(-1).messages[0].content[1].text, /Our bank prints withdrawals in parentheses\./);
    assert.deepEqual([r.items, r.statement.balanced], [[], null]);
  });

  await t.test('validation and errors', async () => {
    await assert.rejects(extract({ accountId: office }), /Bank or Credit Card/);
    await assert.rejects(extract({ fileName: 'june.docx', data: Buffer.from('PK').toString('base64') }), /PDF or an image/);
    await assert.rejects(extract({ fileName: 'fake.pdf', data: Buffer.from('hello').toString('base64') }), /doesn't look like a valid PDF/);
    nextAnswer = { stop_reason: 'max_tokens', json: {} };
    await assert.rejects(extract(), /too much to extract/);
  });

  await t.test('private to the organization', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(extract(), /Invalid account/);
  });
});
