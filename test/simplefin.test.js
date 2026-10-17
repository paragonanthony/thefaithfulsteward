// SimpleFIN bank feed tests, using a fake SimpleFIN server (no network access needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

process.env.ENCRYPTION_KEY = 'test-encryption-key';
process.env.SIMPLEFIN_ALLOWED_HOSTS = 'sfin.test';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const daysAgo = (n) => now() - n * DAY;
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const token = (url) => Buffer.from(url).toString('base64');
const ACCESS = 'https://demo:s3cr%40t@sfin.test/simplefin';
const AUTH = `Basic ${Buffer.from('demo:s3cr@t').toString('base64')}`;

/** A minimal SimpleFIN server: one claimable token, an /accounts endpoint behind Basic auth. */
const fake = {
  claimed: new Set(),
  calls: [],
  status: 200,
  errlist: [],
  accounts: [
    { id: 'ACT-chk', name: 'Business Checking', currency: 'USD', balance: '5230.11', 'balance-date': daysAgo(0), org: { name: 'First Community Bank', domain: 'fcb.example' } },
    { id: 'ACT-cc', name: 'Rewards Card', currency: 'USD', balance: '-25.00', 'balance-date': daysAgo(0), org: { name: 'Card Co' } },
  ],
  txns: { 'ACT-chk': [], 'ACT-cc': [] },
};
const txn = (id, amount, ago, extra = {}) => ({ id, posted: daysAgo(ago), amount, description: `BANK ${id}`, ...extra });

async function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  fake.calls.push([opts.method || 'GET', u.pathname, Object.fromEntries(u.searchParams), u.searchParams.getAll('account')]);
  const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  if (u.pathname.startsWith('/claim/')) {
    if (opts.method !== 'POST') return reply(405, '');
    if (fake.claimed.has(u.pathname)) return reply(403, 'used');
    fake.claimed.add(u.pathname);
    return reply(200, ACCESS);
  }
  if (u.pathname === '/simplefin/accounts') {
    if (opts.headers?.Authorization !== AUTH) return reply(403, 'forbidden');
    if (fake.status !== 200) return reply(fake.status, '');
    const start = Number(u.searchParams.get('start-date') || 0);
    const end = Number(u.searchParams.get('end-date') || Infinity);
    const only = u.searchParams.getAll('account');
    const balancesOnly = u.searchParams.get('balances-only') === '1';
    const accounts = fake.accounts.filter((a) => !only.length || only.includes(a.id)).map((a) => ({
      ...a, transactions: balancesOnly ? [] : fake.txns[a.id].filter((t) => t.posted >= start && t.posted < end && (!t.pending || u.searchParams.get('pending') === '1')),
    }));
    return reply(200, { errlist: fake.errlist, accounts });
  }
  return reply(404, '');
}

let app;
before(async () => {
  app = await startTestServer('npacct_test_simplefin');
  (await import('../server/services/simplefin.js')).setSimplefinFetch(fakeFetch);
});
after(async () => { await app?.stop(); });

test('SimpleFIN bank feeds', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Feed Org' });
  const other = await admin.post('/admin/organizations', { name: 'Other Feed Org' });
  await admin.post('/auth/select-org', { organizationId: org.id });
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, card, office] = ['1000', '2000', '5300'].map(acct);
  const status = () => admin.get('/bank-connections/status');
  // Every line on a ledger account, unmatched and matched
  const allLines = async (accountId) => (await Promise.all(['unmatched', 'matched'].map((st) => admin.get(`/bank-feed?accountId=${accountId}&status=${st}`)))).flatMap((r) => r.items);

  await t.test('setup tokens are checked before anything is stored', async () => {
    assert.deepEqual(await status(), { configured: true, connections: [] });
    await assert.rejects(admin.post('/bank-connections/connections', { setupToken: '' }), /Paste the SimpleFIN setup token/);
    await assert.rejects(admin.post('/bank-connections/connections', { setupToken: 'not a token' }), /doesn’t look like a SimpleFIN setup token/);
    await assert.rejects(admin.post('/bank-connections/connections', { setupToken: token('https://169.254.169.254/claim/x') }), /isn’t an allowed SimpleFIN server/);
    await assert.rejects(admin.post('/bank-connections/connections', { setupToken: token('http://sfin.test/claim/x') }), /must use https/);
    assert.equal(fake.calls.length, 0, 'nothing was requested');
  });

  let conn;
  await t.test('connecting claims the token, stores the access URL encrypted and lists the accounts', async () => {
    const r = await admin.post('/bank-connections/connections', { setupToken: token('https://sfin.test/claim/abc'), label: 'Treasurer' });
    assert.deepEqual([r.accounts, r.errors], [2, []]);
    assert.deepEqual(fake.calls.map((c) => [c[0], c[1], c[2]['balances-only']]), [['POST', '/claim/abc', undefined], ['GET', '/simplefin/accounts', '1']]);
    const st = await status();
    [conn] = st.connections;
    assert.deepEqual([conn.label, conn.server_host], ['Treasurer', 'sfin.test']);
    assert.ok(!JSON.stringify(st).includes('s3cr'), 'the access URL never reaches the browser');
    assert.deepEqual(conn.accounts.map((a) => [a.institution_name, a.name, a.balance, a.is_enabled, a.sync_start_date]),
      [['Card Co', 'Rewards Card', '-25.00', false, isoDaysAgo(30)], ['First Community Bank', 'Business Checking', '5230.11', false, isoDaysAgo(30)]]);
    const { rows: [row] } = await app.db.query('SELECT access_url_enc FROM simplefin_connections WHERE id = $1', [conn.id]);
    assert.match(row.access_url_enc, /^v1:/);
    assert.ok(!row.access_url_enc.includes('s3cr'));
    await assert.rejects(admin.post('/bank-connections/connections', { setupToken: token('https://sfin.test/claim/abc') }), /already used or has expired/);
  });

  let chkId;
  let ccId;
  await t.test('mapping an account imports its posted transactions from the Import from date', async () => {
    fake.txns['ACT-chk'] = [
      txn('T1', '1250.00', 5, { description: 'DEPOSIT GRANT' }),
      txn('T2', '-42.10', 3, { description: 'POS PURCHASE', payee: 'Staples' }),
      txn('T3', '-9.99', 1, { pending: true }),
      txn('T-old', '-5.00', 60),
    ];
    fake.txns['ACT-cc'] = [txn('C1', '-25.00', 2, { description: 'AMAZON' })];
    chkId = conn.accounts.find((a) => a.name === 'Business Checking').id;
    ccId = conn.accounts.find((a) => a.name === 'Rewards Card').id;
    fake.calls = [];
    const r = await admin.put(`/bank-connections/accounts/${chkId}`, { accountId: checking, isEnabled: true, syncStartDate: isoDaysAgo(30) });
    assert.deepEqual([r.sync.added, r.sync.updated], [2, 0]);
    assert.deepEqual(fake.calls.map((c) => c[3]), [['ACT-chk']], 'only the mapped account is read');
    const feed = (await admin.get(`/bank-feed?accountId=${checking}`)).items;
    assert.deepEqual(feed.map((i) => [i.description, Number(i.amount), i.source]).sort(), [['DEPOSIT GRANT', 1250, 'simplefin'], ['POS PURCHASE · Staples', -42.1, 'simplefin']]);
    await assert.rejects(admin.put(`/bank-connections/accounts/${ccId}`, { accountId: checking, isEnabled: true }), /already fed by another/);
    await assert.rejects(admin.put(`/bank-connections/accounts/${ccId}`, { accountId: office, isEnabled: true }), /Bank or Credit Card/);
    await admin.put(`/bank-connections/accounts/${ccId}`, { accountId: card, isEnabled: true, syncStartDate: isoDaysAgo(30) });
    assert.deepEqual((await admin.get(`/bank-feed?accountId=${card}`)).items.map((i) => Number(i.amount)), [-25]);
  });

  await t.test('Sync now reads every enabled account in one request: new, changed and newly posted lines', async () => {
    const posItem = (await admin.get(`/bank-feed?accountId=${checking}`)).items.find((i) => i.description.startsWith('POS'));
    const exp = (await admin.post('/expenses', { date: posItem.date, amount: 42.1, accountId: checking, lines: [{ accountId: office, amount: 42.1 }] })).id;
    await admin.post(`/bank-feed/${posItem.id}/match`, { transactionId: exp });
    fake.txns['ACT-chk'] = [
      txn('T1', '1300.00', 5, { description: 'DEPOSIT GRANT (corrected)' }), // changed, unmatched: updated
      txn('T2', '-99.00', 3, { description: 'CHANGED' }), // matched: left alone
      txn('T3', '-9.99', 1), // now posted
      txn('T4', '15.00', 0, { description: 'INTEREST' }),
    ];
    fake.calls = [];
    const r = await admin.post(`/bank-connections/connections/${conn.id}/sync`);
    assert.deepEqual([r.added, r.updated, r.errors], [2, 1, []]);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0][3], [], 'a full sync reads every account');
    const feed = (await allLines(checking));
    assert.deepEqual(feed.map((i) => [i.description, Number(i.amount)]).sort(),
      [['BANK T3', -9.99], ['DEPOSIT GRANT (corrected)', 1300], ['INTEREST', 15], ['POS PURCHASE · Staples', -42.1]]);
    // Nothing new: nothing changes
    const again = await admin.post(`/bank-connections/connections/${conn.id}/sync`);
    assert.deepEqual([again.added, again.updated], [0, 0]);
    // A bank added at SimpleFIN later appears on the next sync, not yet imported
    fake.accounts.push({ id: 'ACT-sav', name: 'Savings', currency: 'USD', balance: '900.00', org: { name: 'First Community Bank' } });
    fake.txns['ACT-sav'] = [txn('S1', '1.00', 1)];
    await admin.post(`/bank-connections/connections/${conn.id}/sync`);
    const sav = (await status()).connections[0].accounts.find((x) => x.name === 'Savings');
    assert.deepEqual([sav.institution_name, sav.balance, sav.is_enabled, sav.account_id], ['First Community Bank', '900.00', false, null]);
    // Sync Now on the Bank Feed syncs every connection of the organization
    fake.txns['ACT-cc'].push(txn('C2', '-12.00', 0, { description: 'CAFE' }));
    const all = await admin.post('/bank-connections/sync');
    assert.deepEqual([all.connections, all.added, all.updated, all.errors], [1, 1, 0, []]);
  });

  await t.test('problems SimpleFIN reports are shown on the connection', async () => {
    fake.errlist = [{ code: 'con.auth', msg: 'First Community Bank needs you to sign in again' }];
    const r = await admin.post(`/bank-connections/connections/${conn.id}/sync`);
    assert.deepEqual(r.errors, ['First Community Bank needs you to sign in again']);
    assert.equal((await status()).connections[0].error_message, 'First Community Bank needs you to sign in again');
    fake.errlist = [];
    fake.status = 403;
    await assert.rejects(admin.post(`/bank-connections/connections/${conn.id}/sync`), /may have been revoked/);
    assert.match((await status()).connections[0].error_message, /revoked/);
    fake.status = 200;
    await admin.post(`/bank-connections/connections/${conn.id}/sync`);
    assert.equal((await status()).connections[0].error_message, null);
  });

  await t.test('connections are private to their organization and need an org admin to change', async () => {
    await admin.post('/auth/select-org', { organizationId: other.id });
    assert.deepEqual((await status()).connections, []);
    assert.equal((await admin.post('/bank-connections/sync')).connections, 0);
    await assert.rejects(admin.post(`/bank-connections/connections/${conn.id}/sync`), /not found/);
    await assert.rejects(admin.put(`/bank-connections/accounts/${chkId}`, { accountId: null }), /not found/);
    await assert.rejects(admin.del(`/bank-connections/connections/${conn.id}`), /not found/);
    await admin.post('/auth/select-org', { organizationId: org.id });
  });

  await t.test('removing a connection forgets the access URL; imported lines stay', async () => {
    await admin.del(`/bank-connections/connections/${conn.id}`);
    assert.deepEqual((await status()).connections, []);
    const { rows } = await app.db.query('SELECT COUNT(*)::int AS n FROM simplefin_accounts');
    assert.equal(rows[0].n, 0);
    assert.equal((await allLines(checking)).length, 4);
  });
});
