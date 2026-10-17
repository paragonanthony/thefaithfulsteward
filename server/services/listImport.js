import { ACCOUNT_TYPES, TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError } from '../util.js';

// Imports customers / vendors and the chart of accounts from a file (one record per row). Like transaction imports,
// rows are checked first (prepareListImport) and saved only when the user confirms (runListImport).
// Names, accounts, funds and groups are matched ignoring case and extra spaces. A row that matches an existing record
// is skipped, or updated when "update existing" is chosen (blank cells leave the existing value alone).

export const MAX_LIST_ROWS = 5000;
export const LIST_KINDS = ['companies', 'accounts'];

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (v, max = 200) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};
const has = (v) => String(v ?? '').trim() !== '';

/** Yes / no columns: blank means "not given". */
function parseFlag(v) {
  const s = squash(v);
  if (!s) return null;
  if (['yes', 'y', 'true', '1', 'active', 'x'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'inactive'].includes(s)) return false;
  return undefined;
}

// Account type names, including the ones QuickBooks and other systems use.
const TYPE_ALIASES = {
  ...Object.fromEntries(ACCOUNT_TYPES.flatMap((t) => [[squash(t.key), t.key], [squash(t.label), t.key]])),
  checking: 'bank', savings: 'bank', cash: 'bank', bankaccount: 'bank',
  accountsreceivable: 'current_asset', ar: 'current_asset', othercurrentasset: 'current_asset', othercurrentassets: 'current_asset',
  currentassets: 'current_asset', otherasset: 'current_asset', otherassets: 'current_asset', asset: 'current_asset',
  fixedassets: 'fixed_asset', propertyandequipment: 'fixed_asset',
  ap: 'accounts_payable', payable: 'accounts_payable',
  creditcards: 'credit_card',
  othercurrentliability: 'current_liability', othercurrentliabilities: 'current_liability', currentliabilities: 'current_liability', liability: 'current_liability',
  loans: 'loan', notepayable: 'loan', longtermliabilities: 'long_term_liability',
  netassets: 'equity', fundbalance: 'equity',
  revenue: 'income', revenues: 'income', support: 'income',
  expenses: 'expense', costofgoodssold: 'expense', cogs: 'expense',
  otherexpenses: 'other_expense', otherrevenue: 'other_income',
};
export const parseAccountType = (v) => TYPE_ALIASES[squash(v)] || null;

function indexBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

async function lists(db, orgId) {
  const { rows: accounts } = await db.query('SELECT * FROM accounts WHERE organization_id = $1', [orgId]);
  const { rows: companies } = await db.query('SELECT * FROM companies WHERE organization_id = $1', [orgId]);
  const { rows: funds } = await db.query('SELECT id, name FROM funds WHERE organization_id = $1', [orgId]);
  const { rows: groups } = await db.query('SELECT id, name, account_type FROM account_groups WHERE organization_id = $1', [orgId]);
  // Accounts Payable accounts with bills must stay Accounts Payable.
  const { rows: billed } = await db.query(`SELECT DISTINCT account_id FROM transactions WHERE organization_id = $1 AND transaction_type = 'bill'`, [orgId]);
  return { accounts, companies, funds, groups, billed: new Set(billed.map((b) => b.account_id)) };
}

/** Find an account by name, or by number. */
function accountFinder(accounts) {
  const byName = indexBy(accounts, (a) => norm(a.name));
  const byNumber = indexBy(accounts, (a) => norm(a.account_number));
  return (text) => {
    const k = norm(text);
    const n = byName.get(k);
    if (n?.length === 1) return { account: n[0] };
    if (n?.length > 1) return { error: `More than one account is named "${text}"` };
    const m = byNumber.get(k);
    if (m?.length === 1) return { account: m[0] };
    return { error: `Account "${text}" was not found` };
  };
}

// ---------------------------------------------------------------------------
// Customers / vendors
// ---------------------------------------------------------------------------
// [column in companies, field in the file, label]
const COMPANY_TEXT = [['address1', 'address1', 'Address 1'], ['address2', 'address2', 'Address 2'], ['city', 'city', 'City'], ['state', 'state', 'State'],
  ['postal', 'postal', 'Postal'], ['phone1', 'phone', 'Phone'], ['phone2', 'phone2', 'Phone 2'], ['email', 'email', 'Email']];

function checkCompanies(raws, l, updateExisting) {
  const findAccount = accountFinder(l.accounts);
  const byName = indexBy(l.companies, (c) => norm(c.name));
  const seen = new Map();
  return raws.map((raw, i) => {
    const errors = [];
    const warnings = [];
    const name = clean(raw.name);
    if (!name) errors.push('Name is required');
    else if (seen.has(norm(name))) errors.push(`"${name}" is also on row ${seen.get(norm(name))} of the file`);
    else seen.set(norm(name), i + 1);
    const p = { name };
    for (const [k, field, label] of COMPANY_TEXT) {
      p[k] = clean(raw[field]);
      if (k === 'email' && p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) warnings.push(`${label} "${p.email}" doesn’t look like an email address`);
    }
    p.notes = has(raw.notes) ? String(raw.notes).trim().slice(0, 2000) : null;
    const defaultAccount = (field, label, types) => {
      if (!has(raw[field])) return null;
      const r = findAccount(raw[field]);
      if (r.error) { errors.push(`${label}: ${r.error}`); return null; }
      if (!types.includes(r.account.account_type)) { errors.push(`${label} "${r.account.name}" must be an ${types[0] === 'income' ? 'Income or Other Income' : 'Expense or Other Expense'} account`); return null; }
      return r.account;
    };
    const inc = defaultAccount('defaultIncomeAccount', 'Default Income Account', ['income', 'other_income']);
    const exp = defaultAccount('defaultExpenseAccount', 'Default Expense Account', ['expense', 'other_expense']);
    p.default_income_account_id = inc?.id ?? null;
    p.default_expense_account_id = exp?.id ?? null;
    p.defaultIncomeAccount = inc?.name ?? null;
    p.defaultExpenseAccount = exp?.name ?? null;
    p.is_active = parseFlag(raw.active);
    if (p.is_active === undefined) { errors.push(`Active "${raw.active}" must be Yes or No`); p.is_active = null; }

    const matches = name ? byName.get(norm(name)) : null;
    if (matches?.length > 1) errors.push(`More than one existing customer / vendor is named "${name}"`);
    const existing = matches?.length === 1 ? matches[0] : null;
    let action = 'create';
    if (existing) {
      action = updateExisting ? 'update' : 'skip';
      if (!updateExisting) warnings.push('Already exists; it will be left as it is (tick "Update existing records" to update it)');
    }
    return { row: i + 1, status: errors.length ? 'error' : action, errors, warnings, parsed: p, existingId: existing?.id ?? null };
  });
}

async function saveCompany(db, orgId, r) {
  const p = r.parsed;
  if (r.status === 'create') {
    await db.query(
      `INSERT INTO companies (organization_id, name, address1, address2, city, state, postal, phone1, phone2, email, notes,
                              default_income_account_id, default_expense_account_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [orgId, p.name, p.address1, p.address2, p.city, p.state, p.postal, p.phone1, p.phone2, p.email, p.notes,
        p.default_income_account_id, p.default_expense_account_id, p.is_active !== false]);
  } else {
    // Update: only the cells that have a value.
    await db.query(
      `UPDATE companies SET address1 = COALESCE($1, address1), address2 = COALESCE($2, address2), city = COALESCE($3, city), state = COALESCE($4, state),
              postal = COALESCE($5, postal), phone1 = COALESCE($6, phone1), phone2 = COALESCE($7, phone2), email = COALESCE($8, email),
              notes = COALESCE($9, notes), default_income_account_id = COALESCE($10, default_income_account_id),
              default_expense_account_id = COALESCE($11, default_expense_account_id), is_active = COALESCE($12, is_active)
        WHERE id = $13 AND organization_id = $14`,
      [p.address1, p.address2, p.city, p.state, p.postal, p.phone1, p.phone2, p.email, p.notes,
        p.default_income_account_id, p.default_expense_account_id, p.is_active, r.existingId, orgId]);
  }
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------
const SWITCHABLE = ['current_liability', 'accounts_payable'];

function checkAccounts(raws, l, updateExisting) {
  const byName = indexBy(l.accounts, (a) => norm(a.name));
  const byNumber = indexBy(l.accounts, (a) => norm(a.account_number));
  const fundByName = indexBy(l.funds, (f) => norm(f.name));
  const seenName = new Map();
  const seenNumber = new Map();
  return raws.map((raw, i) => {
    const errors = [];
    const warnings = [];
    const name = clean(raw.name);
    const number = clean(raw.number, 30);
    if (!name) errors.push('Account Name is required');
    else if (seenName.has(norm(name))) errors.push(`"${name}" is also on row ${seenName.get(norm(name))} of the file`);
    else seenName.set(norm(name), i + 1);
    if (number) {
      if (seenNumber.has(norm(number))) errors.push(`Account number ${number} is also on row ${seenNumber.get(norm(number))} of the file`);
      else seenNumber.set(norm(number), i + 1);
    }
    // The existing account: same number (when given), otherwise same name.
    const numberMatches = number ? byNumber.get(norm(number)) : null;
    const nameMatches = name ? byName.get(norm(name)) : null;
    let existing = null;
    if (numberMatches?.length === 1) existing = numberMatches[0];
    else if (numberMatches?.length > 1) errors.push(`More than one existing account has number ${number}`);
    else if (nameMatches?.length === 1) {
      existing = nameMatches[0];
      if (number && existing.account_number && norm(existing.account_number) !== norm(number)) {
        errors.push(`An account named "${existing.name}" already exists with number ${existing.account_number}`);
      }
    } else if (nameMatches?.length > 1) errors.push(`More than one existing account is named "${name}"`);
    if (existing && name && numberMatches?.length === 1 && norm(existing.name) !== norm(name)) {
      if (nameMatches?.some((a) => a.id !== existing.id)) errors.push(`Another account is already named "${name}"`);
    }

    let type = null;
    if (!has(raw.type)) { if (!existing) errors.push('Account Type is required'); } else {
      type = parseAccountType(raw.type);
      if (!type) errors.push(`Account Type "${raw.type}" isn’t one of: ${ACCOUNT_TYPES.map((t) => t.label).join(', ')}`);
    }
    if (existing && type && type !== existing.account_type && !(SWITCHABLE.includes(type) && SWITCHABLE.includes(existing.account_type))) {
      errors.push(`"${existing.name}" is already a ${TYPE_BY_KEY[existing.account_type].label} account; its type can’t be changed to ${TYPE_BY_KEY[type].label}`);
    }
    if (existing && type === 'current_liability' && existing.account_type === 'accounts_payable' && l.billed.has(existing.id)) {
      errors.push(`"${existing.name}" has bills, so it must stay an Accounts Payable account`);
    }
    const finalType = type || existing?.account_type || null;

    let fund = null;
    if (has(raw.fund)) {
      const m = fundByName.get(norm(raw.fund));
      if (!m) errors.push(`Default Fund "${raw.fund}" was not found`);
      else if (m.length > 1) errors.push(`More than one fund is named "${raw.fund}"`);
      else fund = m[0];
    }
    const group = clean(raw.group);
    const isActive = parseFlag(raw.active);
    if (isActive === undefined) errors.push(`Active "${raw.active}" must be Yes or No`);
    const undeposited = parseFlag(raw.undeposited);
    if (undeposited === undefined) errors.push(`Undeposited Funds "${raw.undeposited}" must be Yes or No`);
    else if (undeposited && finalType && finalType !== 'bank') errors.push('Only a Bank account can be the Undeposited Funds account');

    let action = 'create';
    if (existing) {
      action = updateExisting ? 'update' : 'skip';
      if (!updateExisting) warnings.push('Already exists; it will be left as it is (tick "Update existing records" to update it)');
    }
    return {
      row: i + 1, status: errors.length ? 'error' : action, errors, warnings, existingId: existing?.id ?? null,
      parsed: {
        number: number ?? (existing && !updateExisting ? existing.account_number : null), name, type: finalType, typeLabel: finalType ? TYPE_BY_KEY[finalType].label : null,
        description: has(raw.description) ? String(raw.description).trim().slice(0, 500) : null,
        group, fund: fund?.name ?? null, fundId: fund?.id ?? null, isActive: isActive ?? null, undeposited: undeposited ?? null,
      },
    };
  });
}

async function saveAccount(db, orgId, r, groupIds) {
  const p = r.parsed;
  // Account groups are created as needed (one per name and account type).
  let groupId = null;
  if (p.group) {
    const key = `${p.type}|${norm(p.group)}`;
    groupId = groupIds.get(key);
    if (!groupId) {
      const { rows: [g] } = await db.query('INSERT INTO account_groups (organization_id, name, account_type) VALUES ($1,$2,$3) RETURNING id', [orgId, p.group, p.type]);
      groupId = g.id;
      groupIds.set(key, groupId);
    }
  }
  if (r.status === 'create') {
    await db.query(
      `INSERT INTO accounts (organization_id, account_type, account_number, name, description, account_group_id, default_fund_id, is_undeposited_funds, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, p.type, p.number, p.name, p.description, groupId, p.fundId, p.type === 'bank' && p.undeposited === true, p.isActive !== false]);
  } else {
    await db.query(
      `UPDATE accounts SET account_type = $1, account_number = COALESCE($2, account_number), name = COALESCE($3, name), description = COALESCE($4, description),
              account_group_id = COALESCE($5, account_group_id), default_fund_id = COALESCE($6, default_fund_id),
              is_undeposited_funds = COALESCE($7, is_undeposited_funds), is_active = COALESCE($8, is_active)
        WHERE id = $9 AND organization_id = $10`,
      [p.type, p.number, p.name, p.description, groupId, p.fundId, p.undeposited === null ? null : p.type === 'bank' && p.undeposited, p.isActive, r.existingId, orgId]);
  }
}

// ---------------------------------------------------------------------------

function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return { total: results.length, create: count('create'), update: count('update'), skip: count('skip'), errors: count('error') };
}

/** Check rows without saving. kind: 'companies' | 'accounts'. */
export async function prepareListImport(db, orgId, kind, rows, { updateExisting = false } = {}) {
  if (!LIST_KINDS.includes(kind)) throw new HttpError(404, 'Unknown import');
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'The file has no rows to import');
  if (rows.length > MAX_LIST_ROWS) throw new HttpError(400, `Import at most ${MAX_LIST_ROWS.toLocaleString()} rows at a time`);
  const l = await lists(db, orgId);
  const results = kind === 'companies' ? checkCompanies(rows, l, updateExisting) : checkAccounts(rows, l, updateExisting);
  return { results, summary: summarize(results) };
}

/** Check again and save the rows without errors (inside a transaction). */
export async function runListImport(db, orgId, kind, rows, opts) {
  const { results, summary } = await prepareListImport(db, orgId, kind, rows, opts);
  const groupIds = new Map();
  if (kind === 'accounts') {
    const { rows: groups } = await db.query('SELECT id, name, account_type FROM account_groups WHERE organization_id = $1', [orgId]);
    for (const g of groups) if (!groupIds.has(`${g.account_type}|${norm(g.name)}`)) groupIds.set(`${g.account_type}|${norm(g.name)}`, g.id);
  }
  for (const r of results) {
    if (r.status !== 'create' && r.status !== 'update') continue;
    if (kind === 'companies') await saveCompany(db, orgId, r); else await saveAccount(db, orgId, r, groupIds);
  }
  return { created: summary.create, updated: summary.update, skipped: summary.skip, errors: summary.errors };
}
