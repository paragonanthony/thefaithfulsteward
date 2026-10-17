// Extract transaction data from an attached document with the Claude API.
import Anthropic from '@anthropic-ai/sdk';
import { TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError, isDate } from '../util.js';
import { decrypt, encrypt, hasEncryptionKey } from '../crypto.js';
import { typeInfo } from './attachments.js';
import { todayStr } from './dates.js';

export const EXTRACTION_TYPES = ['income', 'expense', 'bill', 'transfer', 'journal', 'tuition'];
export const TYPE_LABELS = { income: 'Income', expense: 'Expense', bill: 'Bill', transfer: 'Bank Transfer', journal: 'Journal Entry', tuition: 'Tuition', statement: 'Bank Statement', classify: 'Bank Feed Auto Classify' };
/** Types with a saved prompt: the transaction types, bank statements read into the bank feed, and Auto Classify. */
export const PROMPT_TYPES = [...EXTRACTION_TYPES, 'statement', 'classify'];

/** Starting instructions for each transaction type; organizations can replace them. */
export const DEFAULT_PROMPTS = {
  income: `This is a document about money the organization received, such as a donation check, a deposit slip, a grant award letter or a payment remittance.
- Use the person or organization who paid as the customer / donor.
- Use the check number if a check is shown, and any receipt, invoice or reference number as the reference number.
- Pick the income account that best fits (for example donations, grants, program fees, events). Split into several lines only when the document clearly shows separate amounts for different purposes.
- If the payment is designated for a specific program or restricted purpose that matches a fund, use that fund.`,
  expense: `This is a receipt, bill or invoice for something the organization paid for.
- Use the vendor / merchant as the payee.
- Use the total amount actually paid (including tax and tip, after discounts).
- Use the invoice or receipt number as the reference number, and the check number if the document shows a check payment.
- Pick the expense account that best fits each item. Split into several lines only when items clearly belong to different expense accounts; otherwise use one line for the total.
- Put a short description of what was bought in the memo.`,
  bill: `This is a vendor invoice or bill the organization owes and will pay later.
- Use the vendor as the payee, the invoice number as the bill number, the invoice date as the date and the payment due date as the due date (work it out from terms such as "Net 30" if no date is printed).
- Use the total amount due (including tax and shipping, after discounts).
- Pick the expense account that best fits each item. Split into several lines only when items clearly belong to different expense accounts; otherwise use one line for the total.
- Put a short description of what was bought in the memo.`,
  transfer: `This is a bank document showing money moved between two of the organization's own accounts, such as a transfer confirmation, a statement line, or a credit card payment confirmation.
- The From account is where the money left; the To account is where it arrived (a credit card payment goes To the credit card account).
- Use the confirmation or reference number as the reference number.`,
  journal: `This document supports a general journal entry, such as a payroll register, a depreciation schedule, a loan statement or an accountant's adjusting entry.
- Create balanced lines: total debits must equal total credits.
- Use the most specific accounts from the chart of accounts, and describe each line briefly.`,
  tuition: `This is a tuition document such as an enrollment agreement, tuition statement or invoice to a family.
- Use the family / student account holder as the customer.
- Use the total tuition owed as the amount, and describe the term or program (for example "2026-27 Tuition - Grade 3").
- Pick the income account for tuition if one fits.`,
  statement: `This is a bank or credit card statement. List every transaction in its activity sections: deposits, withdrawals, checks, card purchases, fees, interest, transfers and payments.
- Include each transaction exactly once. Skip running balances, daily balance summaries, totals and lines carried over from the previous statement.
- Use each transaction's posting date. If dates are printed without a year, work out the year from the statement period.
- Keep the description as printed (payee, merchant or type of transaction). For checks, use "Check" and the check number, e.g. "Check 1042".`,
  classify: `Code each bank line with the customer / vendor it is with and the income or expense account it belongs to.
- Choose a customer / vendor only when the bank description clearly names one on the list; otherwise leave it empty.
- If the customer / vendor has a default account that fits, use it.
- Transfers between the organization's own accounts, credit card payments and loan payments aren't income or expenses: leave both fields empty.
- Add what you know about how your organization codes its activity, for example: "Caseys under $10 is staff snacks (Food); over $10 is Fuel", "Deposits from Square are Program Service Fees", "Payments to Kenneth Smith are payroll for the after-school program".`,
};

// ---------------------------------------------------------------------------
// Each organization's own Claude API key (Organization Settings). Stored encrypted in organization_claude_keys;
// never sent back to the browser. There is no server-wide key.
// ---------------------------------------------------------------------------
let injectedClient = null;
const clients = new Map(); // organization id -> { key, client }
/** Tests replace the Anthropic client with a fake (organizations still need a saved key). */
export function setAnthropicClient(client) { injectedClient = client; clients.clear(); }
export const extractionModel = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
export const NOT_SET_MESSAGE = 'Claude isn’t set up for this organization. An organization administrator can add a Claude API key under Organization Settings.';

async function orgKey(db, orgId) {
  if (!hasEncryptionKey()) return null;
  const { rows } = await db.query('SELECT api_key_enc FROM organization_claude_keys WHERE organization_id = $1', [orgId]);
  if (!rows.length) return null;
  try { return decrypt(rows[0].api_key_enc); } catch { return null; }
}

/** Whether the organization has a usable Claude API key. */
export async function extractionConfigured(db, orgId) {
  return Boolean(await orgKey(db, orgId));
}

/** The Anthropic client for an organization's key. */
export async function claudeFor(db, orgId) {
  const key = await orgKey(db, orgId);
  if (!key) throw new HttpError(503, NOT_SET_MESSAGE);
  if (injectedClient) return injectedClient;
  const cached = clients.get(orgId);
  if (cached?.key === key) return cached.client;
  const client = new Anthropic({ apiKey: key, authToken: null, timeout: 5 * 60 * 1000 });
  clients.set(orgId, { key, client });
  return client;
}

const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** Save (or replace) an organization's key after checking it with Anthropic. Returns the hint shown in settings. */
export async function saveOrgKey(db, orgId, apiKey) {
  if (!hasEncryptionKey()) throw new HttpError(503, 'Saving a Claude API key needs ENCRYPTION_KEY to be set on the server');
  const key = String(apiKey || '').trim();
  if (!KEY_PATTERN.test(key)) throw new HttpError(400, 'That doesn\u2019t look like a Claude API key (they start with sk-ant-)');
  const client = injectedClient || new Anthropic({ apiKey: key, authToken: null, timeout: 30 * 1000 });
  if (typeof client.models?.list === 'function') {
    try { await client.models.list({ limit: 1 }); } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err?.status === 401) throw new HttpError(400, 'Anthropic rejected that API key. Check it and try again.');
      if (err instanceof Anthropic.PermissionDeniedError || err?.status === 403) throw new HttpError(400, 'That API key doesn\u2019t have permission to use the Claude API.');
      // Anything else (network, Anthropic busy): save it anyway; problems show up when it's used.
    }
  }
  const hint = key.slice(-4);
  await db.query(
    `INSERT INTO organization_claude_keys (organization_id, api_key_enc, key_hint) VALUES ($1,$2,$3)
     ON CONFLICT (organization_id) DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, key_hint = EXCLUDED.key_hint`,
    [orgId, encrypt(key), hint]);
  clients.delete(orgId);
  return hint;
}

export async function removeOrgKey(db, orgId) {
  await db.query('DELETE FROM organization_claude_keys WHERE organization_id = $1', [orgId]);
  clients.delete(orgId);
}

export async function getPrompt(db, orgId, type) {
  const { rows } = await db.query('SELECT prompt FROM extraction_prompts WHERE organization_id = $1 AND txn_type = $2', [orgId, type]);
  return rows[0]?.prompt ?? DEFAULT_PROMPTS[type];
}

// ---------------------------------------------------------------------------
// Output schemas (structured outputs: every object lists all properties as required, no extras).
// ---------------------------------------------------------------------------
const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });
const str = (d) => nullable({ type: 'string' }, d);
const num = (d) => nullable({ type: 'number' }, d);
const id = (d) => nullable({ type: 'integer' }, d);
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const common = {
  date: str('Transaction date as YYYY-MM-DD'),
  memo: str('Short memo / description for the transaction'),
  notes: str('Anything the bookkeeper should double-check (unclear amounts, guesses), or null'),
};

const SCHEMAS = {
  income: obj({
    ...common,
    amount: num('Total amount received, in dollars'),
    companyId: id('Customer / donor id from the list, or null if not listed'),
    companyName: str('Name of the customer / donor as written on the document'),
    checkNumber: str('Check number, if paid by check'),
    refNumber: str('Receipt, invoice or other reference number'),
    bankAccountId: id('Bank account id the money was deposited to, only if the document says'),
    fundId: id('Fund id for the whole transaction, if one clearly applies'),
    lines: { type: 'array', items: obj({ accountId: id('Account id'), amount: num('Line amount in dollars'), memo: str('Line memo'), fundId: id('Fund id for this line') }) },
  }),
  transfer: obj({
    ...common,
    amount: num('Amount transferred, in dollars'),
    fromAccountId: id('Bank or credit card account id the money came from'),
    toAccountId: id('Bank or credit card account id the money went to'),
    fundId: id('Fund id, if one clearly applies'),
    refNumber: str('Confirmation or reference number'),
  }),
  journal: obj({
    ...common,
    fundId: id('Fund id for lines without their own fund, if one clearly applies'),
    lines: { type: 'array', items: obj({ accountId: id('Account id'), fundId: id('Fund id for this line'), memo: str('Line description'), debit: num('Debit amount in dollars, or null'), credit: num('Credit amount in dollars, or null') }) },
  }),
  tuition: obj({
    ...common,
    amount: num('Total tuition owed, in dollars'),
    companyId: id('Customer id from the list, or null if not listed'),
    companyName: str('Name of the customer (family / account holder) as written on the document'),
    description: str('Short description, e.g. the term and program'),
    incomeAccountId: id('Income account id for tuition'),
    fundId: id('Fund id, if one clearly applies'),
  }),
};
SCHEMAS.bill = obj({
  ...common,
  date: str('Invoice / bill date as YYYY-MM-DD'),
  dueDate: str('Payment due date as YYYY-MM-DD'),
  amount: num('Total amount due, in dollars'),
  companyId: id('Vendor id from the list, or null if not listed'),
  companyName: str('Name of the vendor as written on the document'),
  refNumber: str('Invoice / bill number'),
  fundId: id('Fund id for the whole bill, if one clearly applies'),
  lines: SCHEMAS.income.properties.lines,
});
SCHEMAS.expense = obj({
  ...SCHEMAS.income.properties,
  companyId: id('Vendor id from the list, or null if not listed'),
  companyName: str('Name of the vendor / payee as written on the document'),
  bankAccountId: id('Bank or credit card account id the payment came from, only if the document says (e.g. card ending)'),
  amount: num('Total amount paid, in dollars'),
});

const SYSTEM = `You read financial documents for a non-profit organization's accounting system and extract the details needed to record one transaction.

Rules:
- Use only information in the document. If a field isn't shown or can't be worked out reliably, return null for it.
- For account, fund and customer / vendor ids, use only ids from the lists provided. If nothing in a list fits, use null (and for customers / vendors, still give the name as written).
- Amounts are positive numbers in dollars (e.g. 1234.5), without currency symbols.
- Dates are YYYY-MM-DD. If the year is missing, assume the most recent past date.
- Follow the organization's instructions below about how to record this type of transaction.`;

async function contextLists(db, orgId, type) {
  const [{ rows: accounts }, { rows: funds }, { rows: companies }] = await Promise.all([
    db.query('SELECT id, account_number, name, account_type, is_undeposited_funds FROM accounts WHERE organization_id = $1 AND is_active ORDER BY account_number NULLS LAST, name', [orgId]),
    db.query('SELECT id, name FROM funds WHERE organization_id = $1 AND is_active ORDER BY name', [orgId]),
    type === 'transfer' || type === 'journal'
      ? { rows: [] }
      : db.query('SELECT id, name FROM companies WHERE organization_id = $1 AND is_active ORDER BY name LIMIT 5000', [orgId]),
  ]);
  return { accounts, funds, companies };
}

function listText({ accounts, funds, companies }, type) {
  const acct = (a) => `${a.id} | ${a.account_number ? `${a.account_number} ` : ''}${a.name} | ${TYPE_BY_KEY[a.account_type]?.label || a.account_type}`;
  const parts = [`Chart of accounts (id | number name | type):\n${accounts.map(acct).join('\n')}`];
  parts.push(`Funds (id | name):\n${funds.length ? funds.map((f) => `${f.id} | ${f.name}`).join('\n') : '(none)'}`);
  if (type !== 'transfer' && type !== 'journal') {
    const label = type === 'expense' || type === 'bill' ? 'Vendors' : 'Customers / donors';
    parts.push(`${label} (id | name):\n${companies.length ? companies.map((c) => `${c.id} | ${c.name}`).join('\n') : '(none)'}`);
  }
  return parts.join('\n\n');
}

function documentBlock(att) {
  const kind = typeInfo(att.file_name)?.claude;
  const data = att.data.toString('base64');
  if (kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: att.file_name };
  if (kind === 'image') return { type: 'image', source: { type: 'base64', media_type: att.content_type, data } };
  if (kind === 'text') return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: att.data.toString('utf8') }, title: att.file_name };
  throw new HttpError(400, 'Claude can read PDFs, images (JPEG, PNG, GIF, WebP) and text or CSV files. Save this document as a PDF to extract its data.');
}

// ---------------------------------------------------------------------------
// Clean up the model's answer: keep only ids that exist and fit the field, round amounts, check dates.
// ---------------------------------------------------------------------------
function sanitize(type, raw, lists) {
  const warnings = [];
  const acctById = new Map(lists.accounts.map((a) => [a.id, a]));
  const fundIds = new Set(lists.funds.map((f) => f.id));
  const companyIds = new Set(lists.companies.map((c) => c.id));
  const banking = (a) => a && (a.account_type === 'bank' || a.account_type === 'credit_card');
  const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? (Math.round(Math.abs(v) * 100) / 100).toFixed(2) : null);
  const text = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const account = (v, ok = () => true, label = 'account') => {
    if (v === null || v === undefined) return null;
    const a = acctById.get(v);
    if (!a || !ok(a)) { warnings.push(`The suggested ${label} isn't one you can use here, so it was left blank.`); return null; }
    return v;
  };
  const fund = (v) => (v !== null && v !== undefined && fundIds.has(v) ? v : null);
  const out = {};
  if (raw.date !== undefined) {
    out.date = isDate(raw.date) ? raw.date : null;
    if (raw.date && !out.date) warnings.push(`Couldn't read the date "${raw.date}".`);
  }
  out.memo = text(raw.memo);
  if ('amount' in raw) out.amount = money(raw.amount);
  if ('fundId' in raw) out.fundId = fund(raw.fundId);
  if ('refNumber' in raw) out.refNumber = text(raw.refNumber, 100);
  if ('companyId' in raw) {
    out.companyId = raw.companyId !== null && companyIds.has(raw.companyId) ? raw.companyId : null;
    out.companyName = text(raw.companyName, 200);
    if (!out.companyId && out.companyName) {
      warnings.push(`${type === 'expense' || type === 'bill' ? 'Vendor' : 'Customer'} “${out.companyName}” isn't in your list yet.`);
    }
  }
  if (type === 'bill') {
    out.dueDate = isDate(raw.dueDate) ? raw.dueDate : null;
    out.lines = (Array.isArray(raw.lines) ? raw.lines : [])
      .map((l) => ({ accountId: account(l.accountId, (a) => !banking(a) && a.account_type !== 'accounts_payable'), amount: money(l.amount), memo: text(l.memo), fundId: fund(l.fundId) }))
      .filter((l) => l.accountId || l.amount);
  } else if (type === 'income' || type === 'expense') {
    out.checkNumber = text(raw.checkNumber, 50);
    out.bankAccountId = account(raw.bankAccountId, (a) => banking(a) && (type === 'income' || !a.is_undeposited_funds), 'bank account');
    const isLineAccount = (a) => !banking(a);
    out.lines = (Array.isArray(raw.lines) ? raw.lines : [])
      .map((l) => ({ accountId: account(l.accountId, isLineAccount), amount: money(l.amount), memo: text(l.memo), fundId: fund(l.fundId) }))
      .filter((l) => l.accountId || l.amount);
  } else if (type === 'transfer') {
    const ok = (a) => banking(a) && !a.is_undeposited_funds;
    out.fromAccountId = account(raw.fromAccountId, ok, 'From account');
    out.toAccountId = account(raw.toAccountId, ok, 'To account');
    if (out.fromAccountId && out.fromAccountId === out.toAccountId) { out.toAccountId = null; warnings.push('From and To came out as the same account; choose the To account.'); }
  } else if (type === 'journal') {
    out.lines = (Array.isArray(raw.lines) ? raw.lines : [])
      .map((l) => ({ accountId: account(l.accountId), fundId: fund(l.fundId), memo: text(l.memo), debit: money(l.debit), credit: l.debit ? null : money(l.credit) }))
      .filter((l) => l.accountId || l.debit || l.credit);
    const total = (k) => out.lines.reduce((s, l) => s + Math.round(Number(l[k] || 0) * 100), 0);
    if (total('debit') !== total('credit')) warnings.push('The extracted lines don’t balance; adjust them before saving.');
  } else if (type === 'tuition') {
    out.description = text(raw.description, 200);
    out.incomeAccountId = account(raw.incomeAccountId, (a) => TYPE_BY_KEY[a.account_type]?.category === 'income', 'income account');
  }
  return { fields: out, warnings, notes: text(raw.notes, 1000) };
}

/**
 * Ask Claude for JSON matching `schema` about a document. Long answers (bank statements) stream, so a large
 * max_tokens can't hit request timeouts. Returns { raw, model }.
 */
export async function askClaude({ ai, system, content, schema, maxTokens = 16000, stream = false }) {
  const params = {
    model: extractionModel(),
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  };
  let response;
  try {
    response = stream ? await ai.beta.messages.stream(params).finalMessage() : await ai.beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'The organization\u2019s Claude API key was rejected. An organization administrator can update it under Organization Settings.');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Claude is busy right now. Try again in a minute.');
    if (err instanceof Anthropic.BadRequestError) throw new HttpError(422, `Claude couldn't read this document: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `The Claude API returned an error (${err.status ?? 'network'}). Try again.`);
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to read this document.');
  if (response.stop_reason === 'max_tokens') throw new HttpError(422, 'The document had too much to extract in one go. Try a shorter document.');
  const textBlock = response.content.findLast((b) => b.type === 'text');
  try { return { raw: JSON.parse(textBlock?.text ?? ''), model: response.model }; } catch { throw new HttpError(502, 'Claude returned an unreadable answer. Try again.'); }
}

/** Send an attachment to Claude with the organization's saved prompt for `type`; returns { fields, warnings, notes, model }. */
export async function extractFromAttachment(db, orgId, att, type) {
  if (!EXTRACTION_TYPES.includes(type)) throw new HttpError(400, 'Unknown transaction type');
  const ai = await claudeFor(db, orgId);
  const doc = documentBlock(att);
  const [prompt, lists] = await Promise.all([getPrompt(db, orgId, type), contextLists(db, orgId, type)]);
  const instructions = [
    `Transaction type: ${TYPE_LABELS[type]}`,
    `Today's date: ${todayStr()}`,
    `The organization's instructions for this type of transaction:\n${prompt}`,
    listText(lists, type),
    'Extract the transaction from the attached document.',
  ].join('\n\n');
  const { raw, model } = await askClaude({ ai, system: SYSTEM, content: [doc, { type: 'text', text: instructions }], schema: SCHEMAS[type] });
  return { ...sanitize(type, raw, lists), model };
}

// ---------------------------------------------------------------------------
// Bank statements -> bank feed lines
// ---------------------------------------------------------------------------
const STATEMENT_SCHEMA = obj({
  accountName: str('Account name or type as printed, e.g. "Business Checking"'),
  last4: str('Last 4 digits of the account number, if shown'),
  periodStart: str('First day of the statement period as YYYY-MM-DD'),
  periodEnd: str('Last day of the statement period as YYYY-MM-DD'),
  openingBalance: num('Balance at the start of the period, in dollars (for a credit card: the amount owed)'),
  closingBalance: num('Balance at the end of the period, in dollars (for a credit card: the amount owed)'),
  transactions: {
    type: 'array',
    items: obj({
      date: str('Posting date as YYYY-MM-DD'),
      description: str('Description as printed'),
      amount: num('Signed amount in dollars: positive = money into the account, negative = money out of the account'),
      kind: { type: 'string', enum: ['transaction', 'fee', 'interest'], description: 'fee = a bank service charge or fee (or, on a credit card, an interest / finance charge or fee); interest = interest earned and paid into the account; otherwise transaction' },
    }),
  },
  notes: str('Anything the bookkeeper should double-check (unreadable lines, pages that seem to be missing), or null'),
});

const STATEMENT_SYSTEM = `You read bank and credit card statements for a non-profit organization's accounting system and list their transactions so they can be imported into a bank feed and matched to the books.

Rules:
- Use only what the statement shows; never invent or estimate transactions.
- Amounts are signed numbers in dollars, from the point of view of the account: money in is positive, money out is negative.
  For a bank account, deposits and credits are positive; withdrawals, checks, debits and fees are negative.
  For a credit card, purchases, cash advances, fees and interest charged are negative; payments, refunds and credits are positive.
- Dates are YYYY-MM-DD.
- Mark each line's kind: "fee" for service charges and bank fees (and credit card interest or finance charges and fees), "interest" for interest earned, and "transaction" for everything else.
- Follow the organization's instructions below.`;

/**
 * Read a bank or credit card statement (PDF, image or text file) into bank feed lines for review before importing.
 * file: { fileName, contentType, data (Buffer) }; account: the ledger account the statement is for.
 * Returns { items: [{ date, description, amount }], statement, warnings, notes, model }.
 */
export async function extractStatement(db, orgId, file, account) {
  const ai = await claudeFor(db, orgId);
  const doc = documentBlock({ file_name: file.fileName, content_type: file.contentType, data: file.data });
  const card = account.account_type === 'credit_card';
  const prompt = await getPrompt(db, orgId, 'statement');
  const instructions = [
    `This statement is for the organization's ${card ? 'credit card' : 'bank account'} “${account.name}”.`,
    `Today's date: ${todayStr()}`,
    `The organization's instructions for reading statements:\n${prompt}`,
    'List every transaction on the attached statement.',
  ].join('\n\n');
  const { raw, model } = await askClaude({ ai, system: STATEMENT_SYSTEM, content: [doc, { type: 'text', text: instructions }], schema: STATEMENT_SCHEMA, maxTokens: 64000, stream: true });

  const warnings = [];
  const toCents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
  let dropped = 0;
  const items = [];
  for (const t of Array.isArray(raw.transactions) ? raw.transactions : []) {
    const cents = toCents(t.amount);
    if (!isDate(t.date) || !cents) { dropped += 1; continue; }
    items.push({ date: t.date, description: String(t.description || '').trim().slice(0, 500), amount: (cents / 100).toFixed(2), kind: ['fee', 'interest'].includes(t.kind) ? t.kind : 'transaction' });
  }
  if (dropped) warnings.push(`${dropped} line${dropped === 1 ? ' was' : 's were'} left out because the date or amount couldn’t be read.`);
  const periodStart = isDate(raw.periodStart) ? raw.periodStart : null;
  const periodEnd = isDate(raw.periodEnd) ? raw.periodEnd : null;
  if (periodStart && periodEnd) {
    const outside = items.filter((i) => i.date < periodStart || i.date > periodEnd).length;
    if (outside) warnings.push(`${outside} line${outside === 1 ? ' is' : 's are'} dated outside the statement period; check the dates.`);
  }
  // A bank balance rises with money in; a card balance (amount owed) rises with money out.
  const opening = toCents(raw.openingBalance);
  const closing = toCents(raw.closingBalance);
  const net = items.reduce((s, i) => s + Math.round(Number(i.amount) * 100), 0);
  let balanced = null;
  if (opening !== null && closing !== null) {
    const expected = card ? opening - net : opening + net;
    balanced = expected === closing;
    if (!balanced) {
      warnings.push(`The lines don’t add up to the statement’s balances: they change the balance by ${((card ? -net : net) / 100).toFixed(2)}, but the statement goes from ${(opening / 100).toFixed(2)} to ${(closing / 100).toFixed(2)} (a difference of ${((closing - expected) / 100).toFixed(2)}). Some lines may be missing or misread.`);
    }
  }
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return {
    items,
    statement: {
      accountName: text(raw.accountName, 200), last4: text(raw.last4, 10), periodStart, periodEnd,
      openingBalance: opening === null ? null : (opening / 100).toFixed(2), closingBalance: closing === null ? null : (closing / 100).toFixed(2), balanced,
    },
    warnings,
    notes: text(raw.notes, 1000),
    model,
  };
}
