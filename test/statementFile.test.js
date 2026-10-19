// Reconciling from a statement downloaded as a file (OFX / QFX / QBO or CSV), read without Claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseAmount, parseDate, parseStatementFile } from '../server/services/statementFile.js';

const bank = { account_type: 'bank' };
const card = { account_type: 'credit_card' };
const file = (fileName, text) => ({ fileName, data: Buffer.from(text) });
const b64 = (text) => Buffer.from(text).toString('base64');

// SGML OFX as banks send it (QFX / QBO are the same with Quicken / QuickBooks headers).
const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>123456789<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260601<DTEND>20260630
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260605120000<TRNAMT>1500.00<FITID>1<NAME>DEPOSIT</STMTTRN>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260611<TRNAMT>-200.00<FITID>2<CHECKNUM>1001<NAME>CHECK</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260613<TRNAMT>-42.10<FITID>3<NAME>STAPLES &amp; CO<MEMO>OFFICE SUPPLIES</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260618<TRNAMT>-15.99<FITID>4<NAME>ZOOM.US</STMTTRN>
<STMTTRN><TRNTYPE>SRVCHG<DTPOSTED>20260630<TRNAMT>-12.00<FITID>5<NAME>MONTHLY FEE</STMTTRN>
<STMTTRN><TRNTYPE>INT<DTPOSTED>20260630<TRNAMT>0.37<FITID>6<NAME>INTEREST PAID</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>1230.28<DTASOF>20260630</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

// A CSV with a few lines of account details above the header, Debit / Credit columns, a check number column and a
// running balance, newest first.
const CSV = `Account Name : Business Checking
Account Number : XXXX6789

Posted Date,Check Number,Description,Debit,Credit,Balance
06/30/2026,,INTEREST PAID,,0.37,"1,230.28"
06/30/2026,,SERVICE CHARGE,12.00,,"1,229.91"
06/18/2026,,ZOOM.US,15.99,,"1,241.91"
06/13/2026,,"STAPLES, INC",42.10,,"1,257.90"
06/11/2026,1001,CHECK,200.00,,"1,300.00"
06/05/2026,,DEPOSIT,,"1,500.00","1,500.00"
`;

test('dates and amounts', () => {
  assert.deepEqual(['20260605120000[-5:EST]', '2026-06-05', '6/5/2026', '06/05/26', 'Jun 5, 2026', '2/30/2026', 'soon'].map(parseDate),
    ['2026-06-05', '2026-06-05', '2026-06-05', '2026-06-05', '2026-06-05', null, null]);
  assert.deepEqual(['$1,234.56', '-12', '(12.00)', '12.00 DR', '12.00 CR', '12.00-', '', 'n/a'].map(parseAmount),
    [1234.56, -12, -12, -12, 12, -12, 0, NaN]);
});

test('reads an OFX statement', () => {
  const s = parseStatementFile(file('june.qfx', OFX), bank);
  assert.deepEqual(s.items.map((i) => [i.date, i.amount, i.kind]), [
    ['2026-06-05', '1500.00', 'transaction'], ['2026-06-11', '-200.00', 'transaction'], ['2026-06-13', '-42.10', 'transaction'],
    ['2026-06-18', '-15.99', 'transaction'], ['2026-06-30', '-12.00', 'fee'], ['2026-06-30', '0.37', 'interest'],
  ]);
  assert.equal(s.items[1].description, 'Check #1001 — CHECK', 'the check number is kept for matching');
  assert.equal(s.items[2].description, 'STAPLES & CO — OFFICE SUPPLIES');
  assert.deepEqual(s.statement, { accountName: null, last4: null, periodStart: '2026-06-01', periodEnd: '2026-06-30', openingBalance: '0.00', closingBalance: '1230.28', balanced: null });
  assert.deepEqual(s.warnings, []);
  // The ledger balance is today's, not the period end's: the ending balance is left for the bookkeeper.
  const later = parseStatementFile(file('june.ofx', OFX.replace('<DTASOF>20260630', '<DTASOF>20260715')), bank);
  assert.equal(later.statement.closingBalance, null);
  assert.match(later.warnings.join(' '), /as of 2026-07-15/);
});

test('reads a CSV statement', () => {
  const s = parseStatementFile(file('june.csv', CSV), bank);
  assert.deepEqual(s.items.map((i) => [i.date, i.amount, i.kind]), [
    ['2026-06-30', '0.37', 'interest'], ['2026-06-30', '-12.00', 'fee'], ['2026-06-18', '-15.99', 'transaction'],
    ['2026-06-13', '-42.10', 'transaction'], ['2026-06-11', '-200.00', 'transaction'], ['2026-06-05', '1500.00', 'transaction'],
  ]);
  assert.deepEqual([s.items[3].description, s.items[4].description], ['STAPLES, INC', 'Check #1001 — CHECK']);
  assert.deepEqual([s.statement.periodStart, s.statement.periodEnd, s.statement.openingBalance, s.statement.closingBalance], ['2026-06-05', '2026-06-30', '0.00', '1230.28']);

  // One signed Amount column and no balance: the ending balance is left to enter.
  const plain = parseStatementFile(file('june.csv', 'Date,Description,Amount\n2026-06-05,DEPOSIT,1500\n2026-06-13,STAPLES,-42.10\nTotal,,1457.90\n'), bank);
  assert.deepEqual(plain.items.map((i) => i.amount), ['1500.00', '-42.10']);
  assert.equal(plain.statement.closingBalance, null);
  assert.match(plain.warnings.join(' '), /no ending balance/);
  assert.match(plain.warnings.join(' '), /1 line was left out/, 'the totals line');

  // An unsigned amount with a Debit / Credit column.
  const typed = parseStatementFile(file('june.csv', 'Date,Description,Amount,Debit/Credit\n6/5/2026,DEPOSIT,1500.00,Credit\n6/13/2026,STAPLES,42.10,Debit\n'), bank);
  assert.deepEqual(typed.items.map((i) => i.amount), ['1500.00', '-42.10']);

  // A card export with charges as positive amounts is flagged.
  const cardCsv = parseStatementFile(file('card.csv', 'Transaction Date,Description,Amount\n06/03/2026,AMAZON,25.00\n06/09/2026,ADOBE,54.99\n06/20/2026,PAYMENT THANK YOU,-100.00\n'), card);
  assert.match(cardCsv.warnings.join(' '), /Reverse signs/);

  assert.throws(() => parseStatementFile(file('x.csv', 'Name,Phone\nA,1\n'), bank), /date and amount columns/);
  assert.throws(() => parseStatementFile(file('x.ofx', 'hello'), bank), /doesn’t look like an OFX/);
});

let app;
before(async () => { app = await startTestServer('npacct_test_statement_file'); });
after(async () => { await app?.stop(); });

test('reconcile from a statement file, without Claude', async (t) => {
  const admin = app.client();
  await admin.post('/auth/login', { username: 'admin', password: 'admin-password' });
  const org = await admin.post('/admin/organizations', { name: 'Statement File Org' });
  await admin.post('/auth/select-org', { organizationId: org.id }); // no Claude API key
  const lk = await admin.get('/lookups');
  const acct = (n) => lk.accounts.find((a) => a.account_number === n).id;
  const [checking, contributions, office] = ['1000', '4000', '5300'].map(acct);
  const exp = async (date, amount, extra = {}) => (await admin.post('/expenses', { date, amount, accountId: checking, lines: [{ accountId: office, amount }], ...extra })).id;
  const inc = (await admin.post('/income', { date: '2026-06-05', amount: 1500, accountId: checking, lines: [{ accountId: contributions, amount: 1500 }] })).id;
  const chk = await exp('2026-06-09', 200, { method: 'check', checkNumber: '1001' });
  const staples = await exp('2026-06-12', 42.1);
  const outstanding = await exp('2026-06-20', 99);

  for (const [name, text] of [['june.qbo', OFX], ['june.csv', CSV]]) {
    await t.test(`reads ${name} and matches it to the books`, async () => {
      const r = await admin.post('/reconciliations/extract-statement', { accountId: checking, fileName: name, data: b64(text) });
      const line = (amount) => r.extract.items.findIndex((i) => i.amount === amount);
      assert.deepEqual([r.extract.fileName, r.extract.statement.periodEnd, r.extract.statement.closingBalance], [name, '2026-06-30', '1230.28']);
      assert.deepEqual(r.match.matched.map((m) => m.transactionId).sort(), [inc, chk, staples].sort());
      assert.deepEqual(r.match.missing, [line('-15.99')], 'Zoom is on the statement but not in the books');
      assert.deepEqual(r.match.notOnStatement, [outstanding]);
      assert.deepEqual([r.match.serviceCharge, r.match.interest], ['12.00', '0.37']);
      assert.equal(r.attachment.file_name, name, 'the statement file is kept with the reconciliation');
      // The missing line can become a bank feed line, as from a PDF statement.
      const { ids: [feedId] } = await admin.post('/bank-feed/lines', { accountId: checking, lines: [r.extract.items[line('-15.99')]] });
      assert.ok(feedId);
    });
  }

  await t.test('PDFs still need Claude; an unreadable CSV says why', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
    await assert.rejects(admin.post('/reconciliations/extract-statement', { accountId: checking, fileName: 'june.pdf', data: pdf }), /CSV, OFX, QFX or QBO/);
    await assert.rejects(admin.post('/reconciliations/extract-statement', { accountId: checking, fileName: 'june.csv', data: b64('Name,Phone\nA,1\n') }), /date and amount columns/);
  });
});
