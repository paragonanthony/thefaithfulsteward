// Bank feed Auto Classify, using a fake Claude client (no network access or API key needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

process.env.ENCRYPTION_KEY ||= 'test-encryption-key'; // organizations' Claude API keys are stored encrypted
const CLAUDE_KEY = 'sk-ant-test-0123456789abcdefghijklmnop';

let app;
const calls = [];
let reply = () => ({ lines: [] });
before(async () => {
  app = await startTestServer('npacct_test_feed_classify');
  (await import('../server/services/extraction.js')).setAnthropicClient({
    beta: {
      messages: {
        create: async (p) => {
          calls.push(p);
          return { model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply(p)) }] };
        },
      },
    },
  });
});
after(async () => { await app?.stop(); });

/** The bank line ids in a request, in order. */
const lineIds = (p) => [...p.messages[0].content.at(-1).text.matchAll(/^(\d+): \d{4}-/gm)].map((m) => Number(m[1]));

test('bank feed auto classify', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Classify Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  await admin.put('/attachments/claude-key', { apiKey: CLAUDE_KEY }); // the organization's own Claude API key
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, contributions, grants, supplies, rent, office] = ['1000', '4000', '4100', '5100', '5200', '5300'].map(a);
  const caseys = (await admin.post('/companies', { name: "Casey's General Store" })).id;
  const landlord = (await admin.post('/companies', { name: 'Main Street Properties', default_expense_account_id: rent })).id;
  const donor = (await admin.post('/companies', { name: 'Jane Donor' })).id;
  await admin.post('/bank-feed/import', {
    accountId: checking,
    items: [
      { date: '2026-09-01', description: 'CASEYS #2231', amount: -45.2 },
      { date: '2026-09-02', description: 'ACH MAIN ST PROPERTIES RENT', amount: -1500 },
      { date: '2026-09-03', description: 'MOBILE DEPOSIT JANE DONOR', amount: 250 },
      { date: '2026-09-04', description: 'ONLINE TRANSFER TO SAVINGS', amount: -500 },
      { date: '2026-09-05', description: 'STAPLES 0042', amount: -30 },
      { date: '2026-09-06', description: 'KWIK TRIP', amount: -12 },
    ],
  });
  const lines = async () => (await admin.get(`/bank-feed?accountId=${checking}`)).items;
  const by = async (desc) => (await lines()).find((i) => i.description === desc);
  const id = async (desc) => (await by(desc)).id;

  // A rule already covers Kwik Trip, and Staples was assigned by hand: Auto Classify leaves both alone.
  await admin.post('/bank-feed-rules', { matchText: 'kwik trip', accountId: supplies });
  await admin.put(`/bank-feed/${await id('STAPLES 0042')}/assign`, { accountId: office });

  await t.test('sends only unassigned lines, with the organization’s lists, examples and prompt', async () => {
    await admin.put('/attachments/prompts/classify', { prompt: 'Caseys over $10 is fuel (Program Supplies).' });
    const want = {
      [await id('CASEYS #2231')]: { companyId: caseys, accountId: supplies, reason: 'Fuel at Caseys' },
      [await id('ACH MAIN ST PROPERTIES RENT')]: { companyId: landlord, accountId: null, reason: 'Monthly rent' },
      [await id('MOBILE DEPOSIT JANE DONOR')]: { companyId: donor, accountId: rent, reason: 'Wrong direction on purpose' },
      [await id('ONLINE TRANSFER TO SAVINGS')]: { companyId: null, accountId: null, reason: 'Transfer' },
    };
    reply = (p) => ({ lines: [...lineIds(p).map((lineId) => ({ lineId, ...want[lineId] })), { lineId: 999999, companyId: caseys, accountId: supplies, reason: 'not a line' }] });
    const r = await admin.post('/bank-feed/auto-classify', { accountId: checking });
    assert.deepEqual([r.classified, r.total, r.remaining, r.model], [3, 4, 1, 'claude-test']);
    assert.equal(calls.length, 1);
    const p = calls[0];
    assert.deepEqual(lineIds(p).sort(), Object.keys(want).map(Number).sort(), 'rule-set and hand-set lines are not sent');
    const [lists, ask] = p.messages[0].content.map((c) => c.text);
    assert.ok(p.messages[0].content[0].cache_control, 'the shared lists are cached');
    assert.match(lists, new RegExp(`${caseys}: Casey's General Store`));
    assert.match(lists, /Main Street Properties \[default expense 5200 Rent & Occupancy\]/);
    assert.match(lists, new RegExp(`Income accounts \\(for money in\\):[\\s\\S]*${contributions}: 4000`));
    assert.doesNotMatch(lists.split('Expense accounts')[0], new RegExp(`${supplies}: 5100`), 'expense accounts aren’t offered for money in');
    assert.match(ask, /Caseys over \$10 is fuel/);
    assert.equal(p.output_config.format.type, 'json_schema');
  });

  await t.test('choices are checked: ids must exist and fit the direction; a name alone uses its default account', async () => {
    const c = await by('CASEYS #2231');
    assert.deepEqual([c.company_id, c.assigned_account_id, c.assigned_by, c.assign_note], [caseys, supplies, 'claude', 'Fuel at Caseys']);
    const rent1 = await by('ACH MAIN ST PROPERTIES RENT');
    assert.deepEqual([rent1.company_id, rent1.assigned_account_id], [landlord, rent]);
    const dep = await by('MOBILE DEPOSIT JANE DONOR');
    assert.deepEqual([dep.company_id, dep.assigned_account_id], [donor, null], 'an expense account isn’t used for money in');
    assert.deepEqual([(await by('ONLINE TRANSFER TO SAVINGS')).assigned_by, (await by('STAPLES 0042')).assigned_account_id, (await by('KWIK TRIP')).assigned_by], [null, office, 'rule']);
  });

  await t.test('classified lines keep their values when rules change, and can be changed by hand', async () => {
    await admin.post('/bank-feed-rules', { matchText: 'caseys', accountId: office });
    assert.deepEqual([(await by('CASEYS #2231')).assigned_account_id, (await by('CASEYS #2231')).assigned_by], [supplies, 'claude']);
    const r = await admin.put(`/bank-feed/${await id('CASEYS #2231')}/assign`, { companyId: caseys, accountId: grants });
    assert.deepEqual([r.assigned_by, r.assign_note], ['user', null]);
  });

  await t.test('a second run only sends what is still unassigned; nothing left means no call', async () => {
    calls.length = 0;
    reply = () => ({ lines: [] });
    const r = await admin.post('/bank-feed/auto-classify', { accountId: checking });
    assert.deepEqual([r.classified, r.total, r.remaining], [0, 1, 1]);
    assert.deepEqual(lineIds(calls[0]), [await id('ONLINE TRANSFER TO SAVINGS')]);
    await admin.post(`/bank-feed/${await id('ONLINE TRANSFER TO SAVINGS')}/ignore`);
    calls.length = 0;
    assert.deepEqual(await admin.post('/bank-feed/auto-classify', { accountId: checking }), { classified: 0, total: 0, remaining: 0, model: null });
    assert.equal(calls.length, 0);
  });

  await t.test('the Auto Classify prompt is an organization prompt with a standard version', async () => {
    const prompts = (await admin.get('/attachments/prompts')).prompts;
    const cp = prompts.find((x) => x.type === 'classify');
    assert.deepEqual([cp.label, cp.isDefault, cp.prompt], ['Bank Feed Auto Classify', false, 'Caseys over $10 is fuel (Program Supplies).']);
    await admin.del('/attachments/prompts/classify');
    const reset = (await admin.get('/attachments/prompts')).prompts.find((x) => x.type === 'classify');
    assert.equal(reset.isDefault, true);
    assert.match(reset.prompt, /Transfers between the organization's own accounts/);
  });
});
