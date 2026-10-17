// Reconciling from an uploaded statement (the Anthropic client is a fake), and the statement matching rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

process.env.ENCRYPTION_KEY ||= 'test-encryption-key'; // organizations' Claude API keys are stored encrypted
const CLAUDE_KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
import { matchStatement } from '../server/services/statementMatch.js';

let app;
let nextAnswer = null;
before(async () => {
  app = await startTestServer('npacct_test_rec_statement');
  const answer = (p) => ({ model: p.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(nextAnswer) }] });
  (await import('../server/services/extraction.js')).setAnthropicClient({
    beta: { messages: { create: async (p) => answer(p), stream: (p) => ({ finalMessage: async () => answer(p) }) } },
  });
});
after(async () => { await app?.stop(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n').toString('base64');

test('matching rules', () => {
  const cands = [
    { id: 1, date: '2026-06-01', amount: '200.00', direction: 'out', check_number: '1001' },
    { id: 2, date: '2026-06-02', amount: '200.00', direction: 'out', check_number: null },
    { id: 3, date: '2026-06-03', amount: '50.00', direction: 'in', check_number: null },
    { id: 4, date: '2026-05-01', amount: '75.00', direction: 'in', check_number: null },
    { id: 5, date: '2026-06-30', amount: '12.00', direction: 'out', check_number: null },
    { id: 6, date: '2026-07-05', amount: '9.00', direction: 'out', check_number: null },
  ];
  const items = [
    { date: '2026-06-20', description: 'CHECK #1001', amount: '-200.00', kind: 'transaction' }, // check clears weeks later
    { date: '2026-06-03', description: 'POS PURCHASE', amount: '-200.00', kind: 'transaction' },
    { date: '2026-06-04', description: 'DEPOSIT', amount: '50.00', kind: 'transaction' },
    { date: '2026-06-10', description: 'DEPOSIT', amount: '75.00', kind: 'transaction' }, // book date too far away
    { date: '2026-06-30', description: 'SERVICE FEE', amount: '-12.00', kind: 'fee' }, // already recorded as an expense
    { date: '2026-06-30', description: 'INTEREST', amount: '0.42', kind: 'interest' },
    { date: '2026-06-30', description: 'MAINTENANCE FEE', amount: '-3.00', kind: 'fee' },
  ];
  const m = matchStatement(items, cands, { statementEnd: '2026-06-30' });
  assert.deepEqual(m.matched, [{ index: 0, transactionId: 1 }, { index: 1, transactionId: 2 }, { index: 2, transactionId: 3 }, { index: 4, transactionId: 5 }]);
  assert.deepEqual(m.missing, [3]);
  assert.deepEqual(m.notOnStatement, [4], 'transaction 6 is after the statement end');
  assert.deepEqual([m.serviceCharge, m.interest], ['3.00', '0.42']);
});

test('reconcile from a statement', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Rec Statement Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Rec Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  await admin.put('/attachments/claude-key', { apiKey: CLAUDE_KEY }); // the organization's own Claude API key
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, contributions, office, fees, interest] = ['1000', '4000', '5300', '5500', '4900'].map(acct);
  const exp = async (date, amount, extra = {}) => (await admin.post('/expenses', { date, amount, accountId: checking, lines: [{ accountId: office, amount }], ...extra })).id;
  const inc = (await admin.post('/income', { date: '2026-06-05', amount: 1500, accountId: checking, lines: [{ accountId: contributions, amount: 1500 }] })).id;
  const chk = await exp('2026-06-09', 200, { method: 'check', checkNumber: '1001' });
  const staples = await exp('2026-06-12', 42.1);
  const outstanding = await exp('2026-06-20', 99);

  nextAnswer = {
    accountName: 'Business Checking', last4: '6789', periodStart: '2026-06-01', periodEnd: '2026-06-30', openingBalance: 0, closingBalance: 1230.28, notes: null,
    transactions: [
      { date: '2026-06-05', description: 'Deposit', amount: 1500, kind: 'transaction' },
      { date: '2026-06-11', description: 'Check 1001', amount: -200, kind: 'transaction' },
      { date: '2026-06-13', description: 'STAPLES', amount: -42.1, kind: 'transaction' },
      { date: '2026-06-18', description: 'ZOOM.US', amount: -15.99, kind: 'transaction' },
      { date: '2026-06-30', description: 'Service fee', amount: -12, kind: 'fee' },
      { date: '2026-06-30', description: 'Interest paid', amount: 0.37, kind: 'interest' },
    ],
  };

  let extract;
  let recId;
  let pendingAttachment;
  await t.test('reads the statement and matches it to the books', async () => {
    const r = await admin.post('/reconciliations/extract-statement', { accountId: checking, fileName: 'june.pdf', data: PDF });
    extract = r.extract;
    assert.deepEqual([extract.statement.periodEnd, extract.statement.closingBalance, extract.statement.balanced, extract.items.length], ['2026-06-30', '1230.28', true, 6]);
    assert.deepEqual(r.match.matched, [{ index: 0, transactionId: inc }, { index: 1, transactionId: chk }, { index: 2, transactionId: staples }]);
    assert.deepEqual(r.match.missing, [3]);
    assert.deepEqual(r.match.notOnStatement, [outstanding]);
    assert.deepEqual([r.match.serviceCharge, r.match.interest], ['12.00', '0.37']);
    // The statement file is kept: pending until the new reconciliation is saved
    assert.deepEqual([r.attachment.file_name, r.attachment.transaction_id], ['june.pdf', null]);
    pendingAttachment = r.attachment.id;
  });

  await t.test('the extract is saved with the reconciliation', async () => {
    recId = (await admin.post('/reconciliations', {
      accountId: checking, statementDate: '2026-06-30', statementEndingBalance: 1230.28, clearedIds: [inc, chk, staples],
      serviceCharge: { amount: 12, date: '2026-06-30', accountId: fees }, interest: { amount: 0.37, date: '2026-06-30', accountId: interest },
      statementExtract: { ...extract, fileName: 'june.pdf' },
    })).id;
    await admin.post('/attachments/link', { ids: [pendingAttachment], transactionId: recId });
    assert.deepEqual((await admin.get(`/attachments?transactionId=${recId}`)).map((x) => x.file_name), ['june.pdf']);
    const rec = await admin.get(`/reconciliations/${recId}`);
    assert.deepEqual([rec.statement_extract.fileName, rec.statement_extract.items.length, rec.statement_extract.missing], ['june.pdf', 6, [3]]);
    assert.equal(rec.transactions.filter((x) => x.cleared).length, 3);
  });

  await t.test('a missing line becomes a transaction through the bank feed, and then matches', async () => {
    const line = extract.items[3];
    const { ids: [feedId] } = await admin.post('/bank-feed/lines', { accountId: checking, lines: [line] });
    assert.deepEqual((await admin.post('/bank-feed/lines', { accountId: checking, lines: [line] })).ids, [feedId], 'reused, not duplicated');
    const zoom = await exp(line.date, 15.99, { bankFeedItemId: feedId });
    const { match } = await admin.post('/reconciliations/match-statement', { accountId: checking, reconciliationId: recId, extract });
    assert.deepEqual(match.matched.at(-1), { index: 3, transactionId: zoom });
    assert.deepEqual(match.missing, []);
    // With everything cleared the difference is $0.00
    await admin.put(`/reconciliations/${recId}`, {
      accountId: checking, statementDate: '2026-06-30', statementEndingBalance: 1230.28, clearedIds: [inc, chk, staples, zoom], complete: true,
      serviceCharge: { amount: 12, date: '2026-06-30', accountId: fees }, interest: { amount: 0.37, date: '2026-06-30', accountId: interest },
      statementExtract: { ...extract, missing: [] },
    });
    assert.equal((await admin.get(`/reconciliations/${recId}`)).is_complete, true);
    await assert.rejects(admin.post('/reconciliations/extract-statement', { accountId: checking, reconciliationId: recId, fileName: 'june.pdf', data: PDF }), /complete/);
  });

  await t.test('validation and isolation', async () => {
    await assert.rejects(admin.post('/reconciliations/extract-statement', { accountId: office, fileName: 'june.pdf', data: PDF }), /Bank or Credit Card/);
    await assert.rejects(admin.post('/reconciliations/extract-statement', { accountId: checking, fileName: 'june.docx', data: Buffer.from('PK').toString('base64') }), /PDF or an image/);
    await assert.rejects(admin.post('/reconciliations/match-statement', { accountId: checking, extract: null }), /No statement/);
    await admin.post('/auth/select-org', { organizationId: other.id });
    await assert.rejects(admin.post('/reconciliations/match-statement', { accountId: checking, reconciliationId: recId, extract }), /Invalid account/);
    await assert.rejects(admin.post('/bank-feed/lines', { accountId: checking, lines: [extract.items[0]] }), /Invalid account/);
  });
});
