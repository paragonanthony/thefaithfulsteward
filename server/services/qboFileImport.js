// Import a QuickBooks Online company from its report exports (Excel or CSV): the Journal (every transaction with all
// its lines), the Customer / Vendor / Employee contact lists, and the Balance Sheet, Profit and Loss, Trial Balance or
// Account List (for the chart of accounts and each account's type). The General Ledger, when included, is used to
// check that the Journal is complete.
//
// analyzeQboFiles reads the files and reports what would be imported; runQboFileImport does it in one batch that can
// be undone. Each transaction gets an import key, so importing the same export again skips what's already there.
import crypto from 'node:crypto';
import readXlsxFile from 'read-excel-file/node';
import { ACCOUNT_TYPES, BANKING_TYPES, TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError, fromCents, isDate } from '../util.js';
import { saveIncomeExpense, saveJournal, saveTransfer } from './ledger.js';
import { parseImportDate } from './importer.js';
import { parseAccountType } from './listImport.js';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

/** Minimal CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsvText(src) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const s = src.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => (c === '' ? null : c)));
}

async function readRows(file) {
  const name = String(file.fileName || 'file');
  const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data || ''), 'base64');
  if (!data.length) throw new HttpError(400, `${name} is empty`);
  if (data.length > MAX_FILE_BYTES) throw new HttpError(400, `${name} is larger than 15 MB`);
  if (/\.xlsx$/i.test(name) || data.subarray(0, 2).toString() === 'PK') {
    let sheets;
    try { sheets = await readXlsxFile(data); } catch { throw new HttpError(400, `${name} couldn’t be read as an Excel file`); }
    return (Array.isArray(sheets) && sheets[0]?.data) ? sheets[0].data : sheets;
  }
  if (/\.xls$/i.test(name)) throw new HttpError(400, `${name}: older .xls files aren’t supported; export to Excel (.xlsx) or CSV`);
  return parseCsvText(data.toString('utf8'));
}

// Report titles QuickBooks puts at the top of each export.
const KINDS = {
  journal: ['journal'],
  generalLedger: ['generalledger'],
  customers: ['customercontactlist', 'customerlist', 'customers'],
  vendors: ['vendorcontactlist', 'vendorlist', 'vendors'],
  employees: ['employeecontactlist', 'employeelist', 'employees'],
  balanceSheet: ['balancesheet'],
  profitAndLoss: ['profitandloss', 'profitloss', 'incomestatement'],
  trialBalance: ['trialbalance'],
  accountList: ['accountlist', 'chartofaccounts'],
};
export const KIND_LABELS = {
  journal: 'Journal', generalLedger: 'General Ledger', customers: 'Customer list', vendors: 'Vendor list', employees: 'Employee list',
  balanceSheet: 'Balance Sheet', profitAndLoss: 'Profit and Loss', trialBalance: 'Trial Balance', accountList: 'Account List',
};

function identify(rows) {
  for (const r of rows.slice(0, 6)) {
    for (const c of r || []) {
      const k = squash(c);
      if (!k) continue;
      for (const [kind, titles] of Object.entries(KINDS)) if (titles.includes(k)) return kind;
    }
  }
  return null;
}

/** The heading row: the first row that has all the given column names. Returns { index, col(name...) }. */
function headerRow(rows, required) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(squash);
    if (required.every((names) => names.some((n) => cells.includes(squash(n))))) {
      const col = (...names) => { for (const n of names) { const j = cells.indexOf(squash(n)); if (j >= 0) return j; } return -1; };
      return { index: i, col };
    }
  }
  return null;
}

function money(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = Number(s.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(n) ? Math.round((neg ? -n : n) * 100) : NaN;
}
const dateOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : parseImportDate(v));

// ---------------------------------------------------------------------------
// Parsing reports
// ---------------------------------------------------------------------------

/** Journal: transactions start on rows with a date; following rows with an account are its lines. */
function parseJournal(rows, warnings) {
  const h = headerRow(rows, [['Date'], ['Account', 'Account full name', 'Account name'], ['Debit'], ['Credit']]);
  if (!h) throw new HttpError(400, 'The Journal export is missing its Date, Account, Debit and Credit columns');
  const c = {
    date: h.col('Date'), type: h.col('Transaction Type', 'Type'), num: h.col('Num', 'No.', 'Number'), name: h.col('Name'),
    memo: h.col('Memo/Description', 'Memo', 'Description'), account: h.col('Account', 'Account full name', 'Account name'), debit: h.col('Debit'), credit: h.col('Credit'),
  };
  const txns = [];
  let cur = null;
  for (const r of rows.slice(h.index + 1)) {
    if (!r) continue;
    const cell = (k) => (c[k] >= 0 ? r[c[k]] : null);
    if (text(cell('date'))) {
      const date = dateOf(cell('date'));
      if (!date) { warnings.push(`A Journal row has a date that couldn’t be read ("${text(cell('date'))}"); that transaction was skipped.`); cur = null; continue; }
      cur = { date, qboType: text(cell('type')) || 'Transaction', num: text(cell('num')), name: text(cell('name')), memo: text(cell('memo')), lines: [] };
      txns.push(cur);
    }
    const account = text(cell('account'));
    if (!cur || !account || /^total\b/i.test(account)) continue;
    const debit = money(cell('debit'));
    const credit = money(cell('credit'));
    if (Number.isNaN(debit) || Number.isNaN(credit)) { cur.bad = 'an amount couldn’t be read'; continue; }
    // A negative debit is a credit (and vice versa); a line is one or the other.
    const net = debit - credit;
    if (!net) continue;
    cur.lines.push({ account, debit: Math.max(net, 0), credit: Math.max(-net, 0), memo: text(cell('memo')), name: text(cell('name')) });
  }
  return txns;
}

/** Contact lists: one name per row (with phone, email and address when QuickBooks includes them). */
function parseContacts(rows, kind) {
  const first = kind === 'customers' ? ['Customer', 'Name', 'Customer full name'] : kind === 'vendors' ? ['Vendor', 'Name', 'Vendor full name'] : ['Employee', 'Name'];
  const h = headerRow(rows, [first]);
  if (!h) return [];
  const c = { name: h.col(...first), phone: h.col('Phone Numbers', 'Phone', 'Phone number'), email: h.col('Email', 'E-mail'), address: h.col('Billing Address', 'Address'), full: h.col('Full Name') };
  const out = [];
  for (const r of rows.slice(h.index + 1)) {
    const name = text(r?.[c.name]);
    if (!name || /^total\b/i.test(name)) continue;
    if (/^(this report contains no data|.*\bgmt[+-]?\d)/i.test(name)) continue;
    out.push({ name: name.slice(0, 200), kind, phone: c.phone >= 0 ? text(r[c.phone]) : '', email: c.email >= 0 ? text(r[c.email]) : '', address: c.address >= 0 ? text(r[c.address]) : '' });
  }
  return out;
}

// Balance Sheet / Profit and Loss section headings and the account type of accounts under them.
const SECTIONS = {
  bankaccounts: 'bank', accountsreceivable: 'current_asset', accountsreceivablear: 'current_asset', othercurrentassets: 'current_asset',
  fixedassets: 'fixed_asset', otherassets: 'current_asset', accountspayable: 'accounts_payable', accountspayableap: 'accounts_payable',
  creditcards: 'credit_card', othercurrentliabilities: 'current_liability', longtermliabilities: 'long_term_liability', equity: 'equity',
  income: 'income', costofgoodssold: 'expense', expenses: 'expense', otherincome: 'other_income', otherexpenses: 'other_expense', otherexpense: 'other_expense',
};
const CONTAINERS = new Set(['assets', 'currentassets', 'liabilitiesandequity', 'liabilities', 'currentliabilities', 'liabilitiesandnetassets', 'netassets']);
const SUMMARIES = new Set(['grossprofit', 'netoperatingincome', 'netotherincome', 'netincome', 'netrevenue', 'retainedearnings', 'totalassets', 'totalliabilitiesandequity']);

/** Accounts and their types from the section structure of a Balance Sheet or Profit and Loss export. */
function parseStatement(rows) {
  const h = headerRow(rows, [['Total']]);
  const start = h ? h.index + 1 : 0;
  const body = rows.slice(start).map((r) => ({ label: text(r?.[0]), value: r?.[1] ?? null })).filter((r) => r.label);
  const totals = new Set(body.filter((r) => /^total /i.test(r.label)).map((r) => norm(r.label.slice(6))));
  const stack = []; // { label, section?: type, parent?: true }
  const out = [];
  for (const r of body) {
    const k = squash(r.label);
    if (/^total /i.test(r.label)) {
      const name = norm(r.label.slice(6));
      const at = stack.map((s) => norm(s.label)).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (SUMMARIES.has(k) || /accrual basis|cash basis|gmt[+-]?\d/i.test(r.label)) continue;
    const opens = totals.has(norm(r.label));
    const sectionType = SECTIONS[k];
    if (sectionType && opens && !stack.some((s) => s.parent)) { stack.push({ label: r.label, section: sectionType }); continue; }
    if (CONTAINERS.has(k)) { if (opens) stack.push({ label: r.label }); continue; }
    const type = [...stack].reverse().find((s) => s.section)?.section || null;
    const parents = stack.filter((s) => s.parent).map((s) => s.label);
    if (opens) {
      out.push({ name: [...parents, r.label].join(':'), type });
      stack.push({ label: r.label, parent: true });
    } else if (r.value !== null) out.push({ name: [...parents, r.label].join(':'), type });
  }
  return out;
}

/** Account List export: Account and Type columns (Detail Type and Description when present). */
function parseAccountList(rows) {
  const h = headerRow(rows, [['Account', 'Account name', 'Full name', 'Name'], ['Type', 'Account type']]);
  if (!h) return [];
  const c = { name: h.col('Account', 'Account name', 'Full name', 'Name'), type: h.col('Type', 'Account type'), description: h.col('Description'), number: h.col('Account #', 'Number', 'Account number') };
  return rows.slice(h.index + 1).map((r) => ({
    name: text(r?.[c.name]), type: parseAccountType(text(r?.[c.type]).replace(/\s*\(.*\)$/, '')) || SECTIONS[squash(r?.[c.type])] || null,
    description: c.description >= 0 ? text(r?.[c.description]) : '', number: c.number >= 0 ? text(r?.[c.number]) : '',
  })).filter((a) => a.name && !/^total\b/i.test(a.name));
}

/** Trial Balance: account names (full names, e.g. "Auto Expenses:Gas"). */
function parseTrialBalance(rows) {
  const h = headerRow(rows, [['Debit'], ['Credit']]);
  if (!h) return [];
  return rows.slice(h.index + 1).map((r) => text(r?.[0])).filter((n) => n && !/^total$/i.test(n) && !/accrual basis|cash basis|gmt[+-]?\d/i.test(n));
}

/** General Ledger: total debits and credits per account (to check the Journal against). */
function parseGeneralLedger(rows) {
  const h = headerRow(rows, [['Account', 'Account full name', 'Split'], ['Debit'], ['Credit']]);
  if (!h) return null;
  const c = { account: h.col('Account', 'Account full name'), debit: h.col('Debit'), credit: h.col('Credit'), date: h.col('Date') };
  if (c.account < 0) return null;
  const totals = new Map();
  for (const r of rows.slice(h.index + 1)) {
    const account = text(r?.[c.account]);
    if (!account || !text(r?.[c.date])) continue;
    const t = totals.get(norm(account)) || { account, cents: 0 };
    t.cents += (money(r[c.debit]) || 0) - (money(r[c.credit]) || 0);
    totals.set(norm(account), t);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/** Read every file and pull out the transactions, names and accounts. */
async function readExport(files) {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, 'Choose the files you exported from QuickBooks');
  if (files.length > MAX_FILES) throw new HttpError(400, `Choose at most ${MAX_FILES} files`);
  const warnings = [];
  const out = { files: [], txns: [], contacts: [], accounts: new Map(), gl: null, warnings };
  const addAccount = (name, info = {}) => {
    const k = norm(name);
    if (!k) return;
    const a = out.accounts.get(k) || { name: String(name).trim(), type: null, source: null };
    if (info.type && !a.type) { a.type = info.type; a.source = info.source; }
    if (info.description && !a.description) a.description = info.description;
    if (info.number && !a.number) a.number = info.number;
    out.accounts.set(k, a);
  };
  const parsed = [];
  for (const f of files) {
    const rows = await readRows(f);
    const kind = identify(rows);
    out.files.push({ fileName: f.fileName, kind, label: kind ? KIND_LABELS[kind] : 'Not recognized', rows: rows.length });
    parsed.push({ kind, rows });
  }
  // Account types: Account List first, then the statements; Trial Balance adds names.
  for (const p of parsed.filter((x) => x.kind === 'accountList')) for (const a of parseAccountList(p.rows)) addAccount(a.name, { type: a.type, source: 'Account List', description: a.description, number: a.number });
  for (const p of parsed.filter((x) => x.kind === 'balanceSheet' || x.kind === 'profitAndLoss')) {
    for (const a of parseStatement(p.rows)) addAccount(a.name, { type: a.type, source: KIND_LABELS[p.kind] });
  }
  for (const p of parsed.filter((x) => x.kind === 'trialBalance')) for (const n of parseTrialBalance(p.rows)) addAccount(n);
  for (const p of parsed.filter((x) => ['customers', 'vendors', 'employees'].includes(x.kind))) out.contacts.push(...parseContacts(p.rows, p.kind));
  for (const p of parsed.filter((x) => x.kind === 'journal')) out.txns.push(...parseJournal(p.rows, warnings));
  for (const p of parsed.filter((x) => x.kind === 'generalLedger')) out.gl = parseGeneralLedger(p.rows) || out.gl;
  for (const t of out.txns) for (const l of t.lines) addAccount(l.account);
  if (!parsed.some((p) => p.kind === 'journal') && parsed.some((p) => p.kind === 'generalLedger')) {
    warnings.push('Transactions are imported from the Journal report. Export Reports → Journal (All Dates) from QuickBooks and add it to bring in transactions.');
  }
  // Account types QuickBooks doesn't spell out: a few well-known names.
  for (const a of out.accounts.values()) {
    if (a.type) continue;
    const k = squash(a.name);
    if (k.includes('openingbalanceequity') || k.includes('retainedearnings') || k.includes('ownersequity') || k.includes('ownerdraw')) a.type = 'equity';
    else if (k.includes('undepositedfunds')) a.type = 'current_asset';
    if (a.type) a.source = 'Name';
  }
  return out;
}

/** A stable key for each transaction in the export (identical transactions get #2, #3, ...). */
function keyTransactions(txns) {
  const seen = new Map();
  for (const t of txns) {
    const sig = [t.date, t.qboType, t.num, t.name, t.memo, ...t.lines.map((l) => `${l.account}|${l.debit}|${l.credit}|${l.memo}`).sort()].join('\u0001');
    const h = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 40);
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    t.key = `qbo-file:${h}:${n}`;
  }
}

/**
 * Decide how each transaction is saved, given each QuickBooks account's ledger account (type):
 *  - one bank / card line and every other line on the other side → Income (money in) or Expense (money out)
 *  - two lines, both bank / card accounts → Transfer
 *  - QuickBooks journal entries, and anything else → Journal Entry
 */
function classify(t, typeOf, isUndeposited) {
  if (squash(t.qboType) === 'journalentry') return 'journal'; // kept as a journal entry, as in QuickBooks
  const lines = t.lines;
  const bankLines = lines.filter((l) => BANKING_TYPES.includes(typeOf(l.account)));
  if (lines.length === 2 && bankLines.length === 2 && norm(lines[0].account) !== norm(lines[1].account)
    && !bankLines.some((l) => isUndeposited(l.account))) return 'transfer';
  if (bankLines.length === 1) {
    const bank = bankLines[0];
    const others = lines.filter((l) => l !== bank);
    if (bank.debit && others.every((l) => l.credit && !l.debit)) return 'income';
    if (bank.credit && others.every((l) => l.debit && !l.credit)) return 'expense';
  }
  return 'journal';
}

async function orgState(db, orgId) {
  const { rows: accounts } = await db.query('SELECT id, account_number, name, account_type, is_active, is_undeposited_funds FROM accounts WHERE organization_id = $1 ORDER BY account_number NULLS LAST, name', [orgId]);
  const { rows: companies } = await db.query('SELECT id, name FROM companies WHERE organization_id = $1', [orgId]);
  const { rows: [org] } = await db.query('SELECT period_closing_date FROM organizations WHERE id = $1', [orgId]);
  return { accounts, companies, closed: org?.period_closing_date || null };
}

/**
 * The plan for each QuickBooks account: map to an existing ledger account (same name) or create one of a type.
 * `choices` ({ [qbo name]: { accountId } | { type } }) overrides the defaults.
 */
function planAccounts(exp, state, choices = {}) {
  const byName = new Map(state.accounts.map((a) => [norm(a.name), a]));
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const used = new Map();
  for (const t of exp.txns) for (const l of t.lines) used.set(norm(l.account), (used.get(norm(l.account)) || 0) + 1);
  return [...exp.accounts.values()].map((a) => {
    const choice = choices[a.name] || choices[norm(a.name)] || {};
    const existing = choice.accountId ? byId.get(Number(choice.accountId)) : (choice.type ? null : byName.get(norm(a.name)));
    const type = existing ? existing.account_type : (TYPE_BY_KEY[choice.type] ? choice.type : a.type);
    return {
      name: a.name, qboType: a.type, typeSource: a.source, lines: used.get(norm(a.name)) || 0, description: a.description || null, number: a.number || null,
      action: existing ? 'existing' : 'create', accountId: existing?.id ?? null, accountName: existing ? (existing.account_number ? `${existing.account_number} · ${existing.name}` : existing.name) : null,
      type, typeLabel: type ? TYPE_BY_KEY[type].label : null,
      undeposited: Boolean(existing?.is_undeposited_funds),
      warning: existing && a.type && a.type !== existing.account_type ? `QuickBooks has it as ${TYPE_BY_KEY[a.type].label}; the existing account is ${TYPE_BY_KEY[existing.account_type].label}` : null,
    };
  });
}

/** Read the export and work out everything that would happen, without saving. */
async function buildPlan(db, orgId, files, { accounts: choices = {}, from = null, to = null } = {}) {
  const exp = await readExport(files);
  keyTransactions(exp.txns);
  const state = await orgState(db, orgId);
  const accounts = planAccounts(exp, state, choices);
  const acctByName = new Map(accounts.map((a) => [norm(a.name), a]));
  const typeOf = (name) => acctByName.get(norm(name))?.type || null;
  const isUndeposited = (name) => Boolean(acctByName.get(norm(name))?.undeposited);
  const missingType = accounts.filter((a) => a.action === 'create' && !a.type);

  // Names: contact lists plus every name used on a transaction.
  const companyByName = new Map(state.companies.map((c) => [norm(c.name), c]));
  const names = new Map();
  for (const c of exp.contacts) if (!names.has(norm(c.name))) names.set(norm(c.name), { ...c, existingId: companyByName.get(norm(c.name))?.id ?? null });
  for (const t of exp.txns) {
    for (const n of [t.name, ...t.lines.map((l) => l.name)]) {
      if (n && !names.has(norm(n))) names.set(norm(n), { name: n.slice(0, 200), kind: 'journal', existingId: companyByName.get(norm(n))?.id ?? null });
    }
  }

  // Transactions already imported (same key) are skipped.
  const keys = exp.txns.map((t) => t.key);
  const { rows: had } = keys.length
    ? await db.query('SELECT import_key FROM transactions WHERE organization_id = $1 AND import_key = ANY($2::text[])', [orgId, keys])
    : { rows: [] };
  const already = new Set(had.map((r) => r.import_key));
  const fromD = isDate(from) ? from : null;
  const toD = isDate(to) ? to : null;
  const summary = { total: exp.txns.length, import: 0, already: 0, outside: 0, closed: 0, problems: 0, byType: { income: 0, expense: 0, transfer: 0, journal: 0 }, byQboType: {} };
  const problems = [];
  let first = null;
  let last = null;
  for (const t of exp.txns) {
    first = !first || t.date < first ? t.date : first;
    last = !last || t.date > last ? t.date : last;
    summary.byQboType[t.qboType] = (summary.byQboType[t.qboType] || 0) + 1;
    const debits = t.lines.reduce((s, l) => s + l.debit, 0);
    const credits = t.lines.reduce((s, l) => s + l.credit, 0);
    if (t.bad || t.lines.length < 2 || debits !== credits) {
      t.status = 'problem';
      problems.push({ date: t.date, type: t.qboType, num: t.num, name: t.name, message: t.bad ? `Skipped: ${t.bad}` : t.lines.length < 2 ? 'Skipped: it has fewer than two lines' : `Skipped: debits (${fromCents(debits)}) don’t equal credits (${fromCents(credits)})` });
    } else if (already.has(t.key)) t.status = 'already';
    else if ((fromD && t.date < fromD) || (toD && t.date > toD)) t.status = 'outside';
    else if (state.closed && t.date <= state.closed) t.status = 'closed';
    else {
      t.status = 'import';
      t.as = classify(t, typeOf, isUndeposited);
      summary.byType[t.as] += 1;
    }
    if (t.status !== 'import') summary[t.status === 'problem' ? 'problems' : t.status] += 1;
    else summary.import += 1;
  }
  summary.firstDate = first;
  summary.lastDate = last;
  summary.closedThrough = state.closed;

  // Check the Journal against the General Ledger: the same net debits / credits for every account.
  let check = null;
  if (exp.gl) {
    const fromJournal = new Map();
    for (const t of exp.txns) for (const l of t.lines) fromJournal.set(norm(l.account), (fromJournal.get(norm(l.account)) || 0) + l.debit - l.credit);
    const mismatches = [];
    for (const [k, g] of exp.gl) {
      const j = fromJournal.get(k) || 0;
      if (j !== g.cents) mismatches.push({ account: g.account, generalLedger: fromCents(g.cents), journal: fromCents(j) });
    }
    for (const [k, j] of fromJournal) if (!exp.gl.has(k) && j) mismatches.push({ account: exp.accounts.get(k)?.name || k, generalLedger: '0.00', journal: fromCents(j) });
    check = { accounts: exp.gl.size, mismatches };
  }

  return {
    exp, state, accounts, names: [...names.values()], missingType,
    result: {
      files: exp.files,
      warnings: exp.warnings,
      summary,
      problems: problems.slice(0, 200),
      accounts,
      names: { total: names.size, create: [...names.values()].filter((n) => !n.existingId).length, list: [...names.values()].map((n) => ({ name: n.name, kind: n.kind, exists: Boolean(n.existingId) })) },
      check,
      ready: !missingType.length && summary.import > 0,
      accountTypes: ACCOUNT_TYPES.map((t) => ({ key: t.key, label: t.label })),
      existingAccounts: state.accounts.map((a) => ({ id: a.id, label: a.account_number ? `${a.account_number} · ${a.name}` : a.name, type: a.account_type })),
    },
  };
}

export async function analyzeQboFiles(db, orgId, files, options = {}) {
  return (await buildPlan(db, orgId, files, options)).result;
}

/** Parse a "City, ST 12345" style address into parts (best effort; anything else goes in Address 1). */
function splitAddress(s) {
  const parts = String(s || '').split(/\r?\n|,\s*(?=[^,]*,\s*[A-Z]{2}\s+\d{5})/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return {};
  const lastLine = parts.at(-1);
  const m = lastLine.match(/^(.*?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m && parts.length > 1) return { address1: parts[0].slice(0, 200), address2: parts.length > 2 ? parts.slice(1, -1).join(', ').slice(0, 200) : null, city: m[1].replace(/,$/, '').slice(0, 100), state: m[2], postal: m[3] };
  return { address1: parts.join(', ').slice(0, 200) };
}

/** Import everything the plan says, as one batch. */
export async function runQboFileImport(db, ctx, files, options = {}) {
  const { orgId } = ctx;
  const plan = await buildPlan(db, orgId, files, options);
  if (plan.missingType.length) throw new HttpError(400, `Choose an account type for ${plan.missingType.map((a) => `“${a.name}”`).slice(0, 5).join(', ')}${plan.missingType.length > 5 ? ' and others' : ''}`);
  const toImport = plan.exp.txns.filter((t) => t.status === 'import');
  if (!toImport.length && !plan.accounts.some((a) => a.action === 'create') && !plan.names.some((n) => !n.existingId)) throw new HttpError(400, 'There is nothing new to import');

  // Accounts
  const createdAccounts = [];
  const accountId = new Map();
  for (const a of plan.accounts) {
    if (a.action === 'existing') { accountId.set(norm(a.name), a.accountId); continue; }
    const { rows: [row] } = await db.query(
      `INSERT INTO accounts (organization_id, account_type, account_number, name, description) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [orgId, a.type, a.number, a.name.slice(0, 200), a.description]);
    accountId.set(norm(a.name), row.id);
    createdAccounts.push(row.id);
  }

  // Customers / vendors
  const createdCompanies = [];
  const companyId = new Map();
  for (const n of plan.names) {
    if (n.existingId) { companyId.set(norm(n.name), n.existingId); continue; }
    const addr = splitAddress(n.address);
    const phone = String(n.phone || '').replace(/^(phone|mobile|main)\s*:\s*/i, '').split(/\s{2,}|\n|;/)[0]?.slice(0, 50) || null;
    const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(n.email || '').split(/[,;\s]/)[0]) ? String(n.email).split(/[,;\s]/)[0].slice(0, 200) : null;
    const { rows: [row] } = await db.query(
      `INSERT INTO companies (organization_id, name, address1, address2, city, state, postal, phone1, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, n.name, addr.address1 || null, addr.address2 || null, addr.city || null, addr.state || null, addr.postal || null, phone, email]);
    companyId.set(norm(n.name), row.id);
    createdCompanies.push(row.id);
  }

  const { rows: [batch] } = await db.query(
    `INSERT INTO import_batches (organization_id, kind, file_name, row_count, created_company_ids, created_account_ids, created_by_user_id)
     VALUES ($1, 'qbo_files', $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, `QuickBooks export (${plan.exp.files.filter((f) => f.kind).map((f) => f.label).join(', ')})`.slice(0, 200), toImport.length, createdCompanies, createdAccounts, ctx.userId]);

  const acct = (name) => accountId.get(norm(name));
  for (const t of toImport) {
    const memo = t.memo || null;
    const company = t.name ? companyId.get(norm(t.name)) : null;
    let id;
    try {
      if (t.as === 'transfer') {
        const from = t.lines.find((l) => l.credit);
        const to = t.lines.find((l) => l.debit);
        id = await saveTransfer(db, ctx, { date: t.date, amount: fromCents(to.debit), fromAccountId: acct(from.account), toAccountId: acct(to.account), memo, refNumber: t.num || null });
      } else if (t.as === 'income' || t.as === 'expense') {
        const bank = t.lines.find((l) => BANKING_TYPES.includes(plan.accounts.find((a) => norm(a.name) === norm(l.account))?.type));
        const others = t.lines.filter((l) => l !== bank);
        const isCheck = t.as === 'expense' && /check/i.test(t.qboType) && t.num;
        id = await saveIncomeExpense(db, ctx, t.as, {
          date: t.date, amount: fromCents(t.as === 'income' ? bank.debit : bank.credit), accountId: acct(bank.account), companyId: company,
          memo, method: isCheck ? 'check' : 'electronic', checkNumber: isCheck ? t.num : null, refNumber: isCheck ? null : t.num || null,
          lines: others.map((l) => ({ accountId: acct(l.account), amount: fromCents(t.as === 'income' ? l.credit : l.debit), memo: l.memo || null })),
        });
      } else {
        id = await saveJournal(db, ctx, { date: t.date, memo: [t.qboType !== 'Journal Entry' ? t.qboType : null, t.num ? `#${t.num}` : null, memo].filter(Boolean).join(' · ') || null,
          lines: t.lines.map((l) => ({ accountId: acct(l.account), debit: l.debit ? fromCents(l.debit) : '', credit: l.credit ? fromCents(l.credit) : '', memo: l.memo || null })) });
        if (company) await db.query('UPDATE transactions SET company_id = $1 WHERE id = $2', [company, id]);
      }
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(400, `QuickBooks ${t.qboType} on ${t.date}${t.num ? ` #${t.num}` : ''}${t.name ? ` (${t.name})` : ''} couldn’t be imported: ${err.message}`);
      throw err;
    }
    await db.query('UPDATE transactions SET import_batch_id = $1, import_key = $2 WHERE id = $3', [batch.id, t.key, id]);
  }
  return {
    batchId: batch.id, imported: toImport.length, byType: plan.result.summary.byType, createdAccounts: createdAccounts.length, createdCompanies: createdCompanies.length,
    skippedAlready: plan.result.summary.already, skippedProblems: plan.result.summary.problems, skippedClosed: plan.result.summary.closed, skippedOutside: plan.result.summary.outside,
  };
}
