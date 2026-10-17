// Auto Classify: Claude suggests a customer / vendor and an income or expense account for unassigned bank feed lines.
import { askClaude, claudeFor, getPrompt } from './extraction.js';

const IN_TYPES = ['income', 'other_income'];
const OUT_TYPES = ['expense', 'other_expense'];
const BATCH = 40; // lines per request
const MAX_LINES = 200; // lines per Auto Classify run
const MAX_COMPANIES = 1500;
const MAX_EXAMPLES = 120;

const SYSTEM = `You help a non-profit organization's bookkeeper code bank feed lines. For each bank line you choose the customer / vendor it is with and the income or expense account it belongs to, from the organization's own lists.

Rules:
- Use only ids from the lists provided. Never invent names or accounts.
- Money in (positive amounts) can only use the income accounts; money out (negative amounts) can only use the expense accounts.
- Leave a field null when you are not reasonably confident. A blank is better than a wrong guess: the bookkeeper fills in what you leave.
- Bank descriptions are terse: allow for abbreviations, store or location numbers, card-processor prefixes (SQ *, TST*, PAYPAL *, POS, ACH, DEBIT CARD PURCHASE) and truncated names when matching a customer / vendor.
- The organization's past bank lines show how it codes similar activity; follow them where they apply.
- Give a short reason (a few words) for each line.
- Follow the organization's instructions below.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lineId', 'companyId', 'accountId', 'reason'],
        properties: {
          lineId: { type: 'integer', description: 'The bank line id' },
          companyId: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Customer / vendor id from the list, or null' },
          accountId: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Account id from the list for the line’s direction, or null' },
          reason: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A few words on why' },
        },
      },
    },
  },
};

const acctLabel = (a) => (a.account_number ? `${a.account_number} ${a.name}` : a.name);

/** The organization's lists and past coding, shared by every batch. */
async function context(db, orgId, bankAccountId) {
  const [accounts, companies, examples] = await Promise.all([
    db.query(`SELECT id, account_number, name, account_type, description FROM accounts
               WHERE organization_id = $1 AND is_active AND account_type = ANY($2::text[]) ORDER BY account_number NULLS LAST, name`,
      [orgId, [...IN_TYPES, ...OUT_TYPES]]),
    db.query(`SELECT id, name, default_income_account_id, default_expense_account_id FROM companies
               WHERE organization_id = $1 AND is_active ORDER BY name LIMIT ${MAX_COMPANIES}`, [orgId]),
    // Lines already matched to income / expenses: how this organization codes its bank activity.
    db.query(
      `SELECT b.description, b.amount, c.name AS company, a.account_number, a.name AS account
         FROM bank_feed_items b JOIN transactions t ON t.id = b.transaction_id
         LEFT JOIN companies c ON c.id = t.company_id
         LEFT JOIN LATERAL (SELECT d.account_id FROM transaction_details d WHERE d.transaction_id = t.id ORDER BY d.sort_order, d.id LIMIT 1) d ON true
         LEFT JOIN accounts a ON a.id = d.account_id
        WHERE b.organization_id = $1 AND b.status = 'matched' AND t.transaction_type IN ('income', 'expense')
        ORDER BY (b.account_id = $2) DESC, b.date DESC LIMIT ${MAX_EXAMPLES}`, [orgId, bankAccountId]),
  ]);
  return { accounts: accounts.rows, companies: companies.rows, examples: examples.rows };
}

function contextText(ctx, bankAccount) {
  const byId = Object.fromEntries(ctx.accounts.map((a) => [a.id, a]));
  const acct = (types) => ctx.accounts.filter((a) => types.includes(a.account_type))
    .map((a) => `${a.id}: ${acctLabel(a)}${a.description ? ` (${a.description})` : ''}`).join('\n') || '(none)';
  const companies = ctx.companies.map((c) => {
    const defs = [byId[c.default_income_account_id] && `income ${acctLabel(byId[c.default_income_account_id])}`, byId[c.default_expense_account_id] && `expense ${acctLabel(byId[c.default_expense_account_id])}`].filter(Boolean);
    return `${c.id}: ${c.name}${defs.length ? ` [default ${defs.join('; ')}]` : ''}`;
  }).join('\n') || '(none)';
  const examples = ctx.examples.map((e) => `"${e.description}" ${Number(e.amount).toFixed(2)} → ${e.company || '(no name)'} / ${e.account ? `${e.account_number ? `${e.account_number} ` : ''}${e.account}` : '(no account)'}`).join('\n');
  return [
    `Bank account: ${bankAccount.name}${bankAccount.account_type === 'credit_card' ? ' (a credit card)' : ''}`,
    `Income accounts (for money in):\n${acct(IN_TYPES)}`,
    `Expense accounts (for money out):\n${acct(OUT_TYPES)}`,
    `Customers / vendors (with their default accounts, if any):\n${companies}`,
    examples ? `Past bank lines and how they were coded:\n${examples}` : 'There are no past coded bank lines yet.',
  ].join('\n\n');
}

/**
 * Classify the bank account's unmatched lines that nobody (and no rule) has assigned yet, newest first, up to
 * MAX_LINES. Claude's choices are checked against the organization's lists; a customer / vendor without an account
 * gets its default account. Returns { classified, total, remaining, model }.
 */
export async function classifyFeedLines(db, orgId, bankAccount) {
  const ai = await claudeFor(db, orgId); // the organization's own Claude API key
  const { rows: lines } = await db.query(
    `SELECT id, date, description, amount FROM bank_feed_items
      WHERE organization_id = $1 AND account_id = $2 AND status = 'unmatched' AND assigned_by IS NULL
      ORDER BY date DESC, id DESC LIMIT ${MAX_LINES + 1}`, [orgId, bankAccount.id]);
  const todo = lines.slice(0, MAX_LINES);
  if (!todo.length) return { classified: 0, total: 0, remaining: 0, model: null };

  const ctx = await context(db, orgId, bankAccount.id);
  const prompt = await getPrompt(db, orgId, 'classify');
  const shared = contextText(ctx, bankAccount);
  const accountsById = Object.fromEntries(ctx.accounts.map((a) => [a.id, a]));
  const companiesById = Object.fromEntries(ctx.companies.map((c) => [c.id, c]));
  let classified = 0;
  let model = null;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const ids = new Set(batch.map((l) => l.id));
    const list = batch.map((l) => `${l.id}: ${l.date} ${Number(l.amount) > 0 ? 'money in' : 'money out'} ${Number(l.amount).toFixed(2)} "${l.description}"`).join('\n');
    const { raw, model: m } = await askClaude({
      ai,
      system: SYSTEM,
      content: [
        // The lists are the same for every batch; caching them makes later batches cheaper and faster.
        { type: 'text', text: shared, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `The organization's instructions:\n${prompt}\n\nBank lines to code:\n${list}` },
      ],
      schema: SCHEMA,
      maxTokens: 8000,
    });
    model = m;
    for (const out of Array.isArray(raw?.lines) ? raw.lines : []) {
      if (!ids.has(out.lineId)) continue;
      ids.delete(out.lineId); // one answer per line
      const line = batch.find((l) => l.id === out.lineId);
      const types = Number(line.amount) > 0 ? IN_TYPES : OUT_TYPES;
      const company = companiesById[out.companyId] || null;
      let account = accountsById[out.accountId];
      if (account && !types.includes(account.account_type)) account = null;
      // A name without an account: its default account for the direction.
      const def = company && (Number(line.amount) > 0 ? company.default_income_account_id : company.default_expense_account_id);
      const accountId = account?.id || def || null;
      if (!company && !accountId) continue;
      const note = typeof out.reason === 'string' ? out.reason.trim().slice(0, 300) || null : null;
      const res = await db.query(
        `UPDATE bank_feed_items SET company_id = $1, assigned_account_id = $2, assigned_by = 'claude', rule_id = NULL, assign_note = $3
          WHERE id = $4 AND status = 'unmatched' AND assigned_by IS NULL`, [company?.id || null, accountId, note, line.id]);
      classified += res.rowCount;
    }
  }
  // Lines still unassigned on this account (Claude wasn't sure, or there were more than one run takes).
  const { rows: [left] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM bank_feed_items WHERE organization_id = $1 AND account_id = $2 AND status = 'unmatched' AND assigned_by IS NULL`,
    [orgId, bankAccount.id]);
  return { classified, total: todo.length, remaining: left.n, model };
}
