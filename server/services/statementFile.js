import { HttpError } from '../util.js';

// Read a bank statement downloaded as a file (OFX / QFX / QBO, or CSV) into the same shape extractStatement returns
// for a PDF read by Claude: { items: [{ date, description, amount, kind }], statement, warnings, notes }.
// No Claude API key is needed.

export const STATEMENT_FILE_EXTENSIONS = ['csv', 'ofx', 'qfx', 'qbo'];
const ext = (name) => (/\.([A-Za-z0-9]+)$/.exec(name || '')?.[1] || '').toLowerCase();
export const isStatementFile = (fileName) => STATEMENT_FILE_EXTENSIONS.includes(ext(fileName));

const cents = (v) => Math.round(Number(v) * 100);
const dollars = (c) => (c / 100).toFixed(2);
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYYMMDD…' (OFX), 'YYYY-MM-DD', 'M/D/YYYY', 'M/D/YY', 'D-Mon-YYYY' or 'Mon D, YYYY' → 'YYYY-MM-DD', else null. */
export function parseDate(s) {
  const v = String(s ?? '').trim();
  let m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return valid(m[3].length === 2 ? `20${m[3]}` : m[3], m[1], m[2]);
  const t = Date.parse(`${v} 12:00 UTC`);
  if (/[A-Za-z]{3}/.test(v) && Number.isFinite(t)) { const d = new Date(t); return valid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  return null;
}
function valid(y, mo, d) {
  const s = `${y}-${pad(mo)}-${pad(d)}`;
  const dt = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === s ? s : null;
}

/** '$1,234.56', '-12', '(12.00)', '12.00 DR', '12.00-' → a number; '' → 0; unreadable → NaN. */
export function parseAmount(s) {
  let v = String(s ?? '').trim();
  if (!v) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  if (/\s*(DR|DB)$/i.test(v)) { neg = true; v = v.replace(/\s*(DR|DB)$/i, ''); } else v = v.replace(/\s*CR$/i, '');
  if (/^-|-$/.test(v.trim())) { neg = !neg; v = v.replace(/-/g, ''); }
  v = v.replace(/[$,\s+]/g, '');
  if (!/^\d*\.?\d+$/.test(v)) return NaN;
  const n = Number(v);
  return neg ? -n : n;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// Fee and interest lines that match nothing in the books become the reconciliation's service charge and interest.
const FEE = /service (charge|fee)|monthly (maintenance |service )?fee|maintenance fee|account fee|overdraft fee|nsf fee|wire fee|bank (fee|charge)/i;
const INTEREST = /\binterest\b/i;
function kindOf(description, amount, card, ofxType) {
  const t = String(ofxType || '').toUpperCase();
  if (t === 'FEE' || t === 'SRVCHG') return 'fee';
  if ((t === 'INT' || t === 'DIV') && amount > 0 && !card) return 'interest';
  if (INTEREST.test(description)) return amount > 0 && !card ? 'interest' : card && amount < 0 ? 'fee' : 'transaction';
  if (FEE.test(description) && amount < 0) return 'fee';
  return 'transaction';
}

// ---------------------------------------------------------------------------
// OFX / QFX / QBO (QFX and QBO are OFX with Quicken / QuickBooks headers; SGML or XML)
// ---------------------------------------------------------------------------
function parseOfx(text, card) {
  const tag = (block, name) => (block.match(new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i')) || [])[1]?.trim() || null;
  const unescape = (s) => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const items = [];
  let dropped = 0;
  for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
    const b = m[1];
    const date = parseDate(tag(b, 'DTPOSTED'));
    const amount = parseAmount(tag(b, 'TRNAMT'));
    if (!date || !Number.isFinite(amount) || !cents(amount)) { dropped += 1; continue; }
    const check = tag(b, 'CHECKNUM');
    const name = unescape(tag(b, 'NAME'));
    const memo = unescape(tag(b, 'MEMO'));
    const description = [check && !new RegExp(`\\b${check}\\b`).test(`${name} ${memo}`) ? `Check #${check}` : null, name, memo && memo !== name ? memo : null]
      .filter(Boolean).join(' — ').slice(0, 500);
    items.push({ date, description, amount: dollars(cents(amount)), kind: kindOf(description, amount, card, tag(b, 'TRNTYPE')) });
  }
  const list = text.match(/<BANKTRANLIST>([\s\S]*?)(<STMTTRN>|<\/BANKTRANLIST>)/i)?.[1] || '';
  const ledger = text.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>)/i)?.[1] || '';
  return {
    items,
    dropped,
    periodStart: parseDate(tag(list, 'DTSTART')),
    periodEnd: parseDate(tag(list, 'DTEND')),
    balance: ledger ? parseAmount(tag(ledger, 'BALAMT')) : NaN,
    balanceAsOf: ledger ? parseDate(tag(ledger, 'DTASOF')) : null,
  };
}

// ---------------------------------------------------------------------------
// CSV: columns found from the header row (banks put a few lines of account details above it)
// ---------------------------------------------------------------------------
function parseCsvStatement(text, card) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const h = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /amount|debit|credit|withdrawal|deposit/i.test(c)));
  if (h < 0) throw new HttpError(422, 'Couldn’t find the date and amount columns in this CSV file. It needs a header row with a Date column and an Amount column (or Debit and Credit columns).');
  const head = rows[h].map((c) => c.trim());
  const find = (...res) => { for (const re of res) { const i = head.findIndex((c) => re.test(c)); if (i >= 0) return i; } return -1; };
  const col = {
    date: find(/post(ed|ing)?\s*date/i, /^date$/i, /trans(action)?\.?\s*date/i, /date/i),
    description: find(/^desc/i, /description/i, /payee/i, /^name$/i, /memo/i, /details?/i),
    memo: find(/^memo$/i, /^notes?$/i),
    amount: find(/^amount$/i, /amount/i),
    debit: find(/debit/i, /withdrawal/i, /money out/i),
    credit: find(/credit/i, /deposit/i, /money in/i),
    balance: find(/balance/i),
    check: find(/check|chk|cheque/i),
    type: find(/^(transaction )?type$/i, /dr\s*\/\s*cr/i),
  };
  if (col.memo === col.description) col.memo = -1;
  // One "Debit/Credit" column says which way the amount went rather than holding amounts.
  if (col.debit >= 0 && col.debit === col.credit) { if (col.type < 0) col.type = col.debit; col.debit = -1; col.credit = -1; }
  if (col.date < 0 || (col.amount < 0 && col.debit < 0 && col.credit < 0)) {
    throw new HttpError(422, 'Couldn’t find the date and amount columns in this CSV file. It needs a header row with a Date column and an Amount column (or Debit and Credit columns).');
  }
  const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const items = [];
  const balances = []; // [{ order, date, amount, balance }] for the running-balance column
  let dropped = 0;
  for (const r of rows.slice(h + 1)) {
    const date = parseDate(cell(r, col.date));
    let amount;
    if (col.amount >= 0 && cell(r, col.amount)) {
      amount = parseAmount(cell(r, col.amount));
      // A separate Debit / Credit (or DR / CR) column says which way an unsigned amount went.
      if (Number.isFinite(amount) && amount > 0 && /^(debit|dr|db|withdrawal)$/i.test(cell(r, col.type))) amount = -amount;
    } else {
      const cr = parseAmount(cell(r, col.credit));
      const dr = parseAmount(cell(r, col.debit));
      amount = Number.isFinite(cr) && Number.isFinite(dr) ? Math.abs(cr) - Math.abs(dr) : NaN;
    }
    if (!date && !cell(r, col.amount) && !cell(r, col.debit) && !cell(r, col.credit)) continue; // a blank or totals line
    if (!date || !Number.isFinite(amount) || !cents(amount)) { dropped += 1; continue; }
    const check = cell(r, col.check).replace(/^0+/, '');
    const desc = [cell(r, col.description), cell(r, col.memo)].filter(Boolean).join(' — ');
    const description = [/^\d+$/.test(check) && !new RegExp(`\\b${check}\\b`).test(desc) ? `Check #${check}` : null, desc].filter(Boolean).join(' — ').slice(0, 500);
    items.push({ date, description, amount: dollars(cents(amount)), kind: kindOf(description, amount, card) });
    const bal = col.balance >= 0 && cell(r, col.balance) ? parseAmount(cell(r, col.balance)) : NaN;
    if (Number.isFinite(bal)) balances.push({ order: items.length - 1, date, amount: cents(amount), balance: cents(bal) });
  }
  // Running balance (bank accounts): the closing balance is the newest line's, the opening the oldest line's before it.
  let opening = null;
  let closing = null;
  if (!card && balances.length === items.length && items.length) {
    const newestFirst = items[0].date > items[items.length - 1].date;
    const oldest = newestFirst ? balances[balances.length - 1] : balances[0];
    const newest = newestFirst ? balances[0] : balances[balances.length - 1];
    closing = newest.balance;
    opening = oldest.balance - oldest.amount;
  }
  return { items, dropped, opening, closing };
}

/**
 * file: { fileName, data (Buffer) }; account: the ledger account (credit cards keep the balance as the amount owed).
 * Throws HttpError 422 when the file can't be read as a statement.
 */
export function parseStatementFile(file, account) {
  const card = account?.account_type === 'credit_card';
  const text = Buffer.isBuffer(file.data) ? file.data.toString('utf8') : String(file.data || '');
  const warnings = [];
  let items;
  let dropped;
  let periodStart = null;
  let periodEnd = null;
  let opening = null;
  let closing = null;
  if (/<OFX>/i.test(text) || ext(file.fileName) !== 'csv') {
    if (!/<STMTTRN>|<BANKTRANLIST>/i.test(text)) throw new HttpError(422, `${file.fileName} doesn’t look like an OFX, QFX or QBO bank statement.`);
    const o = parseOfx(text, card);
    ({ items, dropped, periodStart, periodEnd } = o);
    // The ledger balance is the statement's ending balance only when it's as of the end of the period downloaded.
    if (Number.isFinite(o.balance) && (!o.balanceAsOf || !periodEnd || o.balanceAsOf <= periodEnd)) {
      closing = cents(card ? Math.abs(o.balance) : o.balance);
    } else if (Number.isFinite(o.balance)) {
      warnings.push(`The file’s balance is as of ${o.balanceAsOf}, after the period it covers, so the ending balance wasn’t filled in. Enter it from your statement.`);
    }
  } else {
    ({ items, dropped, opening, closing } = parseCsvStatement(text, card));
    // Many card exports list charges as positive amounts; here money out (a charge) is negative.
    if (card && items.filter((i) => Number(i.amount) > 0).length > items.length / 2) {
      warnings.push('Most lines in this file are money in (payments or credits). If the charges came out as money in, use Reverse signs.');
    }
  }
  if (!items.length) throw new HttpError(422, `No transactions were found in ${file.fileName}.`);
  if (dropped) warnings.push(`${dropped} line${dropped === 1 ? ' was' : 's were'} left out because the date or amount couldn’t be read.`);
  const dates = items.map((i) => i.date).sort();
  periodStart ||= dates[0];
  periodEnd ||= dates[dates.length - 1];
  const outside = items.filter((i) => i.date < periodStart || i.date > periodEnd).length;
  if (outside) warnings.push(`${outside} line${outside === 1 ? ' is' : 's are'} dated outside the period the file covers; check the dates.`);
  // With only an ending balance (OFX), the opening balance is worked back from the lines.
  const net = items.reduce((s, i) => s + cents(i.amount), 0);
  if (closing !== null && opening === null) opening = card ? closing + net : closing - net;
  if (closing === null) warnings.push('The file has no ending balance. Enter the Statement Ending Balance from your statement.');
  return {
    items,
    statement: {
      accountName: null, last4: null, periodStart, periodEnd,
      openingBalance: opening === null ? null : dollars(opening), closingBalance: closing === null ? null : dollars(closing), balanced: null,
    },
    warnings,
    notes: null,
  };
}
