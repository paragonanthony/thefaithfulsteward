// Backups: an organization downloads as an Excel workbook (or a zip with its attachments) and restores, as a new
// organization or over the current one, exactly as it was, even when the app has gained or lost columns since.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { unzipSync, zipSync } from 'fflate';
import { startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer('npacct_test_backup'); });
after(async () => { await app?.stop(); });

async function download(c, path) {
  const res = await fetch(app.base + path, { headers: { Cookie: c.cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(JSON.parse(buf.toString()).error);
  return { buf, type: res.headers.get('content-type'), name: /filename="([^"]+)"/.exec(res.headers.get('content-disposition'))[1] };
}
const b64 = (buf) => Buffer.from(buf).toString('base64');

/** Everything that should come back the same, without ids: ledger by account, counts, settings. */
async function snapshot(db, orgId) {
  const one = async (sql) => (await db.query(sql, [orgId])).rows;
  return {
    org: (await one('SELECT name, fiscal_year_start_month, period_closing_date, ein FROM organizations WHERE id = $1'))[0],
    ledger: await one(`SELECT a.account_number, a.name, f.name AS fund, SUM(d.debit)::text AS dr, SUM(d.credit)::text AS cr
      FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id JOIN accounts a ON a.id = d.account_id LEFT JOIN funds f ON f.id = d.fund_id
      WHERE h.organization_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    transactions: await one(`SELECT t.transaction_type, t.date, t.amount::text, a.name AS account, c.name AS company, t.memo, t.created_at,
      (SELECT COUNT(*)::int FROM transaction_details d WHERE d.transaction_id = t.id) AS lines, (t.reconciliation_id IS NOT NULL) AS cleared
      FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.organization_id = $1 ORDER BY t.date, t.transaction_type, t.amount`),
    reconciliations: await one(`SELECT r.statement_date, r.is_complete, (SELECT COUNT(*)::int FROM reconciled_totals x WHERE x.reconciliation_id = r.transaction_id) AS locked
      FROM reconciliations r JOIN transactions t ON t.id = r.transaction_id WHERE t.organization_id = $1`),
    deposits: await one(`SELECT COUNT(*)::int AS n FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id
      JOIN transactions l ON l.id = d.linked_transaction_id AND l.organization_id = t.organization_id WHERE t.organization_id = $1`),
    accounts: await one(`SELECT a.account_number, a.name, g.name AS grp, f.name AS fund FROM accounts a LEFT JOIN account_groups g ON g.id = a.account_group_id
      LEFT JOIN funds f ON f.id = a.default_fund_id WHERE a.organization_id = $1 ORDER BY 1, 2`),
    feed: await one(`SELECT b.description, b.status, r.match_text FROM bank_feed_items b LEFT JOIN bank_feed_rules r ON r.id = b.rule_id WHERE b.organization_id = $1 ORDER BY 1`),
    budgets: await one(`SELECT b.name, COUNT(l.id)::int AS lines, SUM(l.amount)::text AS total FROM budgets b JOIN budget_lines l ON l.budget_id = b.id WHERE b.organization_id = $1 GROUP BY 1`),
    reports: await one(`SELECT name, definition->'columns'->>'mode' AS mode FROM report_definitions WHERE organization_id = $1 AND builtin_key IS NULL ORDER BY name`),
  };
}

/** Rebuild a workbook from read-excel-file sheets (after changing them). */
const rewrite = (sheets) => writeXlsxFile(sheets.map((s) => ({
  sheet: s.sheet,
  data: s.data.map((row) => row.map((v) => (v instanceof Date ? { value: v, format: 'yyyy-mm-dd' } : v))),
}))).toBuffer();

test('backup and restore', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const src = await admin.post('/admin/organizations', { name: 'Grace Chapel' });
  await admin.post('/auth/select-org', { organizationId: src.id });
  await admin.put('/org', { name: 'Grace Chapel', fiscal_year_start_month: 7, ein: '12-3456789' });
  const lk = await admin.get('/lookups');
  const a = (n) => lk.accounts.find((x) => x.account_number === n).id;
  const [checking, savings, undeposited, contributions, office, rent, ap] = ['1000', '1010', '1050', '4000', '5300', '5200', '2100'].map(a);
  const vendor = (await admin.post('/companies', { name: 'Office Mart', city: 'Springfield' })).id;
  const donor = (await admin.post('/companies', { name: 'Jane Donor' })).id;
  const fund = (await admin.post('/funds', { name: 'Youth', is_restricted: true })).id;
  const inc = (await admin.post('/income', { date: '2026-03-01', amount: 100, accountId: checking, companyId: donor, memo: 'Gift', lines: [{ accountId: contributions, amount: 100, fundId: fund }] })).id;
  const exp = (await admin.post('/expenses', { date: '2026-03-02', amount: 40, accountId: checking, companyId: vendor, lines: [{ accountId: office, amount: 25 }, { accountId: rent, amount: 15 }] })).id;
  const u1 = (await admin.post('/income', { date: '2026-03-03', amount: 30, accountId: undeposited, lines: [{ accountId: contributions, amount: 30 }] })).id;
  const dep = (await admin.post('/deposits', { date: '2026-03-04', accountId: checking, incomeIds: [u1] })).id;
  const je = (await admin.post('/journal-entries', { date: '2026-03-05', memo: 'JE', lines: [{ accountId: checking, debit: 10 }, { accountId: contributions, credit: 10 }] })).id;
  const tr = (await admin.post('/transfers', { date: '2026-03-06', fromAccountId: checking, toAccountId: savings, amount: 5 })).id;
  const bill = (await admin.post('/bills', { date: '2026-03-01', companyId: vendor, accountId: ap, amount: 50, lines: [{ accountId: rent, amount: 50 }] })).id;
  const pay = (await admin.post('/bill-payments', { companyId: vendor, date: '2026-03-07', accountId: checking, payments: [{ billId: bill, amount: 50 }] })).id;
  await admin.post('/reconciliations', { accountId: checking, statementDate: '2026-03-31', statementEndingBalance: 45, clearedIds: [inc, exp, dep, je, tr, pay], complete: true });
  await admin.post('/income', { date: '2026-04-10', amount: 20, accountId: checking, lines: [{ accountId: contributions, amount: 20 }] });
  const pdf = Buffer.from('%PDF-1.4\nreceipt\n%%EOF');
  await admin.post('/attachments', { fileName: 'receipt.pdf', data: b64(pdf), transactionId: exp });
  await admin.post('/bank-feed-rules', { matchText: 'coffee', accountId: office });
  await admin.post('/bank-feed/import', { accountId: checking, items: [{ date: '2026-04-02', description: 'COFFEE SHOP', amount: -4 }, { date: '2026-04-03', description: 'OTHER', amount: -9 }] });
  await admin.post('/budgets', { name: 'FY27', startDate: '2026-07-01', endDate: '2027-06-30', lines: ['2026-07', '2026-08', '2026-09'].map((month) => ({ accountId: office, month, amount: 10 })) });
  await admin.post('/reports', { name: 'Youth report', definition: { type: 'pnl', columns: { mode: 'fund', funds: [fund] }, rows: [{ kind: 'accounts', id: 'r1', label: 'Office', filter: { accounts: [office] } }] } });
  await admin.put('/period-closing', { closingDate: '2026-03-31' });
  // Secrets that must never be in a backup
  await app.db.query(`INSERT INTO simplefin_connections (organization_id, access_url_enc, server_host) VALUES ($1, 'SECRET-ACCESS-URL', 'bridge.example')`, [src.id]);
  const { rows: [conn] } = await app.db.query('SELECT id FROM simplefin_connections WHERE organization_id = $1', [src.id]);
  await app.db.query(`INSERT INTO simplefin_accounts (organization_id, connection_id, simplefin_account_id, name, account_id) VALUES ($1, $2, 'ACT-1', 'Checking', $3)`, [src.id, conn.id, checking]);
  await app.db.query(`INSERT INTO organization_claude_keys (organization_id, api_key_enc) VALUES ($1, 'SECRET-CLAUDE-KEY')`, [src.id]);
  const before = await snapshot(app.db, src.id);
  assert.equal(before.reconciliations[0].locked > 0, true);
  assert.equal(before.reports.length, 1);

  let workbook;
  await t.test('the backup is an Excel workbook with a sheet per kind of record and no secrets', async () => {
    const file = await download(admin, '/backup');
    assert.match(file.name, /^Grace Chapel backup \d{4}-\d{2}-\d{2}\.xlsx$/);
    assert.match(file.type, /spreadsheetml/);
    workbook = file.buf;
    const sheets = await readXlsxFile(file.buf);
    const names = sheets.map((s) => s.sheet);
    for (const n of ['About', 'General Ledger', 'organizations', 'accounts', 'companies', 'transactions', 'transaction_details', 'gl_headers', 'gl_details', 'reconciliations', 'attachments', 'budgets', 'budget_lines', 'users']) assert.ok(names.includes(n), n);
    for (const n of ['simplefin_connections', 'simplefin_accounts', 'organization_claude_keys', 'user_organizations', 'oauth_tokens', 'reconciled_totals']) assert.ok(!names.includes(n), n);
    const text = JSON.stringify(sheets);
    assert.ok(!text.includes('SECRET'), 'no secrets');
    assert.ok(!text.includes('password'), 'no password columns');
    const about = Object.fromEntries(sheets[0].data.filter((r) => r[1] != null).map((r) => [r[0], r[1]]));
    assert.equal(about.Organization, 'Grace Chapel');
    assert.equal(about['Format version'], 1);
    const gl = sheets.find((s) => s.sheet === 'General Ledger').data;
    assert.deepEqual(gl[0].slice(0, 3), ['Date', 'Entry', 'Type']);
    const dr = gl.slice(1).reduce((s, r) => s + (r[10] || 0), 0);
    const cr = gl.slice(1).reduce((s, r) => s + (r[11] || 0), 0);
    assert.ok(dr > 0 && Math.abs(dr - cr) < 0.001, 'the readable ledger balances');
    const tx = sheets.find((s) => s.sheet === 'transactions').data;
    assert.ok(tx[0].includes('transaction_type') && tx[0].includes('account_id'));
    assert.ok(tx[1][tx[0].indexOf('date')] instanceof Date, 'dates are real dates in Excel');
  });

  await t.test('only organization administrators can back up', async () => {
    await admin.post('/admin/users', { username: 'clerk', password: 'clerk-password', role: 'user' });
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    await assert.rejects(download(clerk, '/backup'), /administrator/);
    await assert.rejects(clerk.post('/backup/inspect', { data: b64(workbook) }), /administrator/);
  });

  let restored;
  await t.test('restoring as a new organization brings everything back', async () => {
    const info = await admin.post('/backup/inspect', { data: b64(workbook) });
    assert.equal(info.organization, 'Grace Chapel');
    assert.equal(info.counts.transactions, before.transactions.length);
    assert.deepEqual(info.warnings, []);
    const r = await admin.post('/backup/restore-new', { data: b64(workbook), name: 'Grace Chapel (restored)' });
    restored = r.organizationId;
    assert.equal(r.name, 'Grace Chapel (restored)');
    assert.ok(r.warnings.some((w) => /attachments/.test(w) && /files/.test(w)), 'attachments need the zip backup');
    const after = await snapshot(app.db, restored);
    assert.deepEqual({ ...after, org: { ...after.org, name: 'Grace Chapel' } }, before);
    // Who created the records is kept; the restoring user administers it; the secrets are not there
    const { rows: [m] } = await app.db.query(`SELECT role FROM user_organizations uo JOIN users u ON u.id = uo.user_id WHERE u.username = 'admin' AND organization_id = $1`, [restored]);
    assert.equal(m.role, 'admin');
    const { rows: [k] } = await app.db.query('SELECT COUNT(*)::int AS n FROM organization_claude_keys WHERE organization_id = $1', [restored]);
    assert.equal(k.n, 0);
    const { rows: [c] } = await app.db.query(`SELECT u.username FROM transactions t JOIN users u ON u.id = t.created_by_user_id WHERE t.organization_id = $1 LIMIT 1`, [restored]);
    assert.equal(c.username, 'admin');
  });

  await t.test('the restored organization works and keeps its protections', async () => {
    await admin.post('/auth/select-org', { organizationId: restored });
    const lk2 = await admin.get('/lookups');
    const chk = lk2.accounts.find((x) => x.account_number === '1000').id;
    const off = lk2.accounts.find((x) => x.account_number === '5300').id;
    await assert.rejects(admin.post('/expenses', { date: '2026-03-15', amount: 1, accountId: chk, lines: [{ accountId: off, amount: 1 }] }), /closed/);
    const e = await admin.post('/expenses', { date: '2026-05-01', amount: 7, accountId: chk, lines: [{ accountId: off, amount: 7 }] });
    assert.ok(e.id);
    const report = (await admin.get('/reports')).find((x) => x.name === 'Youth report');
    const def = (await app.db.query('SELECT definition FROM report_definitions WHERE id = $1', [report.id])).rows[0].definition;
    const youth = lk2.funds.find((f) => f.name === 'Youth').id;
    assert.deepEqual([def.columns.funds, def.rows[0].filter.accounts], [[youth], [off]], 'report settings point at the restored fund and account');
  });

  await t.test('the zip backup includes the attachments', async () => {
    await admin.post('/auth/select-org', { organizationId: src.id });
    const file = await download(admin, '/backup?attachments=1');
    assert.match(file.name, /\.zip$/);
    const entries = unzipSync(new Uint8Array(file.buf));
    const pdfs = Object.keys(entries).filter((n) => n.startsWith('files/attachments/'));
    assert.equal(pdfs.length, 1);
    assert.match(pdfs[0], /receipt\.pdf$/);
    const r = await admin.post('/backup/restore-new', { data: b64(file.buf) });
    assert.equal(r.name, 'Grace Chapel');
    assert.deepEqual(r.warnings, []);
    const { rows: [att] } = await app.db.query(`SELECT a.data, t.amount::text FROM attachments a JOIN transactions t ON t.id = a.transaction_id WHERE a.organization_id = $1`, [r.organizationId]);
    assert.equal(Buffer.compare(att.data, pdf), 0);
    assert.equal(att.amount, '40.00');
  });

  await t.test('a backup from an older or newer version restores: unknown columns and sheets are skipped, missing ones get defaults', async () => {
    const sheets = await readXlsxFile(workbook);
    const sheet = (n) => sheets.find((s) => s.sheet === n);
    // A column this version doesn't have, and a sheet for a feature it doesn't have
    const companies = sheet('companies').data;
    companies[0].push('loyalty_tier');
    for (const row of companies.slice(1)) row.push('gold');
    sheets.push({ sheet: 'future_feature', data: [['id', 'organization_id', 'thing'], [1, src.id, 'x']] });
    // Columns added since the backup was made: removed from the file, so they get their defaults
    const drop = (n, col) => { const d = sheet(n).data; const i = d[0].indexOf(col); for (const row of d) row.splice(i, 1); };
    drop('accounts', 'is_active');
    drop('companies', 'notes');
    drop('transactions', 'import_key');
    drop('transactions', 'created_at');
    const buf = await rewrite(sheets);
    const info = await admin.post('/backup/inspect', { data: b64(buf) });
    assert.equal(info.warnings.length, 2, info.warnings.join('\n'));
    assert.match(info.warnings.join(' '), /loyalty_tier/);
    assert.match(info.warnings.join(' '), /future_feature/);
    const r = await admin.post('/backup/restore-new', { data: b64(buf), name: 'Older Backup' });
    const after = await snapshot(app.db, r.organizationId);
    assert.deepEqual(after.ledger, before.ledger);
    assert.deepEqual(after.accounts, before.accounts);
    const { rows: [x] } = await app.db.query('SELECT bool_and(is_active) AS active FROM accounts WHERE organization_id = $1', [r.organizationId]);
    assert.equal(x.active, true, 'a missing required column gets its default');
  });

  await t.test('replacing the current organization with a backup', async () => {
    await admin.post('/auth/select-org', { organizationId: src.id });
    // Changes after the backup was made
    await admin.post('/expenses', { date: '2026-06-01', amount: 99, accountId: checking, lines: [{ accountId: office, amount: 99 }] });
    await admin.post('/companies', { name: 'Added Later' });
    await assert.rejects(admin.post('/backup/restore', { data: b64(workbook), confirmName: 'Grace' }), /Type the organization's name/);
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    await assert.rejects(clerk.post('/backup/restore', { data: b64(workbook), confirmName: 'Grace Chapel' }), /administrator/);
    const r = await admin.post('/backup/restore', { data: b64(workbook), confirmName: 'grace chapel' });
    assert.equal(r.organizationId, src.id);
    const after = await snapshot(app.db, src.id);
    assert.deepEqual(after, before, 'back exactly as backed up, closed period and reconciliation included');
    // Kept: its users, bank connection (pointed at the restored checking account) and Claude key
    const { rows: users } = await app.db.query(`SELECT u.username FROM user_organizations uo JOIN users u ON u.id = uo.user_id WHERE organization_id = $1 ORDER BY 1`, [src.id]);
    assert.deepEqual(users.map((u) => u.username), ['admin', 'clerk']);
    const { rows: [sf] } = await app.db.query(`SELECT a.account_number FROM simplefin_accounts s JOIN accounts a ON a.id = s.account_id WHERE s.organization_id = $1`, [src.id]);
    assert.equal(sf.account_number, '1000');
    const { rows: [k] } = await app.db.query('SELECT api_key_enc FROM organization_claude_keys WHERE organization_id = $1', [src.id]);
    assert.equal(k.api_key_enc, 'SECRET-CLAUDE-KEY');
    // Other organizations are untouched
    assert.deepEqual((await snapshot(app.db, restored)).ledger.length > 0, true);
  });

  await t.test('only system administrators restore as a new organization; a bad file changes nothing', async () => {
    const clerk = app.client();
    await clerk.post('/auth/login', { username: 'clerk', password: 'clerk-password' });
    await assert.rejects(clerk.post('/backup/restore-new', { data: b64(workbook) }), /System administrator/);
    await assert.rejects(admin.post('/backup/restore-new', { data: b64(Buffer.from('not a backup')) }), /isn’t a backup/);
    const { rows: [before2] } = await app.db.query('SELECT COUNT(*)::int AS n FROM organizations');
    // A general ledger that doesn't balance
    const sheets = await readXlsxFile(workbook);
    const gl = sheets.find((s) => s.sheet === 'gl_details').data;
    gl[1][gl[0].indexOf('debit')] = 12345;
    gl[1][gl[0].indexOf('credit')] = 0;
    await assert.rejects(admin.post('/backup/restore-new', { data: b64(await rewrite(sheets)) }), /doesn’t balance/);
    // A newer format
    const about = sheets.find((s) => s.sheet === 'About').data;
    about.find((r) => r[0] === 'Format version')[1] = 99;
    await assert.rejects(admin.post('/backup/inspect', { data: b64(await rewrite(sheets)) }), /newer version/);
    const { rows: [after2] } = await app.db.query('SELECT COUNT(*)::int AS n FROM organizations');
    assert.equal(after2.n, before2.n);
    // A zip without a workbook
    await assert.rejects(admin.post('/backup/inspect', { data: b64(zipSync({ 'a.txt': new Uint8Array([1]) })) }), /doesn’t contain a backup/);
  });
});
