import { BANKING_TYPES } from '../accountTypes.js';
import { HttpError, fromCents, isDate } from '../util.js';
import { deleteTransaction, saveIncomeExpense } from './ledger.js';

// Imports single-line income / expense transactions. Each row:
//   { date, type, headerAccount, detailAccount, amount, fund, description, customer }
// Accounts are matched by name (account number accepted as a fallback), funds by name, customers/vendors by name
// (created when missing). All matching ignores case and surrounding spaces.

export const MAX_IMPORT_ROWS = 2000;

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Accepts YYYY-MM-DD, M/D/YYYY, M/D/YY, M-D-YYYY and ISO timestamps. */
export function parseImportDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return isDate(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d) ? d : null;
  }
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return isDate(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d) ? d : null;
  }
  return null;
}

function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = Number(s.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(n) ? Math.round((neg ? -n : n) * 100) : NaN;
}

/** Name lookup that reports ambiguity instead of guessing. */
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

/**
 * Validate rows against the organization's accounts, funds and names.
 * Returns per-row results plus the customer/vendor names that would be created.
 */
export async function prepareImport(db, orgId, rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) throw new HttpError(400, 'The file has no transactions to import');
  if (rawRows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time`);

  // Sequential: inside an import this runs on a single transaction connection.
  const { rows: accounts } = await db.query('SELECT id, account_number, name, account_type, is_active FROM accounts WHERE organization_id = $1', [orgId]);
  const { rows: funds } = await db.query('SELECT id, name FROM funds WHERE organization_id = $1', [orgId]);
  const { rows: companies } = await db.query('SELECT id, name FROM companies WHERE organization_id = $1', [orgId]);
  const { rows: [org] } = await db.query('SELECT period_closing_date FROM organizations WHERE id = $1', [orgId]);
  const closed = org?.period_closing_date || null;
  const acctByName = indexBy(accounts, (a) => norm(a.name));
  const acctByNumber = indexBy(accounts, (a) => norm(a.account_number));
  const fundByName = indexBy(funds, (f) => norm(f.name));
  const companyByName = indexBy(companies, (c) => norm(c.name));

  const findAccount = (name) => {
    const k = norm(name);
    const byName = acctByName.get(k);
    if (byName?.length === 1) return { account: byName[0] };
    if (byName?.length > 1) return { error: `More than one account is named "${name}"` };
    const byNumber = acctByNumber.get(k);
    if (byNumber?.length === 1) return { account: byNumber[0] };
    return { error: `Account "${name}" was not found` };
  };

  const newCompanies = new Map(); // normalized -> display name
  const results = rawRows.map((raw, i) => {
    const errors = [];
    const warnings = [];
    const date = parseImportDate(raw.date);
    if (!date) errors.push(raw.date ? `Date "${raw.date}" is not a valid date` : 'Date is required');
    else if (closed && date <= closed) errors.push(`Date ${date} is in a closed period (closed through ${closed})`);

    const typeText = norm(raw.type);
    const type = typeText === 'income' ? 'income' : typeText === 'expense' ? 'expense' : null;
    if (!type) errors.push(raw.type ? `Transaction Type "${raw.type}" must be Income or Expense` : 'Transaction Type is required');

    const cents = parseAmount(raw.amount);
    if (Number.isNaN(cents)) errors.push(raw.amount === undefined || raw.amount === '' ? 'Amount is required' : `Amount "${raw.amount}" is not a number`);
    else if (cents <= 0) errors.push('Amount must be greater than zero (use Transaction Type for money in or out)');

    let header = null;
    if (!String(raw.headerAccount ?? '').trim()) errors.push('Header Account is required');
    else {
      const r = findAccount(raw.headerAccount);
      if (r.error) errors.push(`Header ${r.error.charAt(0).toLowerCase()}${r.error.slice(1)}`);
      else if (!BANKING_TYPES.includes(r.account.account_type)) errors.push(`Header Account "${r.account.name}" must be a Bank or Credit Card account`);
      else header = r.account;
    }
    let detail = null;
    if (!String(raw.detailAccount ?? '').trim()) errors.push('Detail Account is required');
    else {
      const r = findAccount(raw.detailAccount);
      if (r.error) errors.push(`Detail ${r.error.charAt(0).toLowerCase()}${r.error.slice(1)}`);
      else detail = r.account;
    }
    for (const a of [header, detail]) if (a && !a.is_active) warnings.push(`Account "${a.name}" is inactive`);

    let fund = null;
    if (String(raw.fund ?? '').trim()) {
      const matches = fundByName.get(norm(raw.fund));
      if (!matches) errors.push(`Fund "${raw.fund}" was not found`);
      else if (matches.length > 1) errors.push(`More than one fund is named "${raw.fund}"`);
      else fund = matches[0];
    }

    let company = null;
    let createCompany = null;
    const customer = String(raw.customer ?? '').trim().replace(/\s+/g, ' ');
    if (customer) {
      const matches = companyByName.get(norm(customer));
      if (matches?.length) company = matches[0];
      else {
        createCompany = customer.slice(0, 200);
        if (!errors.length) newCompanies.set(norm(customer), newCompanies.get(norm(customer)) || createCompany);
      }
    }

    return {
      row: i + 1,
      status: errors.length ? 'error' : 'ok',
      errors,
      warnings,
      parsed: errors.length ? null : {
        date, type, amount: cents, headerAccountId: header.id, headerAccount: header.name, detailAccountId: detail.id, detailAccount: detail.name,
        fundId: fund?.id || null, fund: fund?.name || '', companyId: company?.id || null, customer: company?.name || createCompany || '',
        createCompany: Boolean(createCompany), description: String(raw.description ?? '').trim().slice(0, 1000),
      },
    };
  });

  // Possible duplicates of transactions already in the books (same type, date, amount, bank account and name).
  const valid = results.filter((r) => r.parsed);
  if (valid.length) {
    const dates = [...new Set(valid.map((r) => r.parsed.date))];
    const { rows: existing } = await db.query(
      `SELECT t.transaction_type, t.date, ROUND(t.amount * 100)::bigint AS cents, t.account_id, lower(COALESCE(c.name, '')) AS name
         FROM transactions t LEFT JOIN companies c ON c.id = t.company_id
        WHERE t.organization_id = $1 AND t.transaction_type IN ('income', 'expense') AND t.date = ANY($2::date[])`,
      [orgId, dates],
    );
    const seen = new Set(existing.map((e) => [e.transaction_type, e.date, Number(e.cents), e.account_id, norm(e.name)].join('|')));
    for (const r of valid) {
      const p = r.parsed;
      if (seen.has([p.type, p.date, p.amount, p.headerAccountId, norm(p.customer)].join('|'))) {
        r.status = 'duplicate';
        r.warnings.push('A transaction with the same date, type, amount, account and name already exists');
      }
    }
  }

  return {
    results,
    newCompanies: [...newCompanies.values()],
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      errors: results.filter((r) => r.status === 'error').length,
      income: results.filter((r) => r.parsed?.type === 'income').reduce((s, r) => s + r.parsed.amount, 0) / 100,
      expense: results.filter((r) => r.parsed?.type === 'expense').reduce((s, r) => s + r.parsed.amount, 0) / 100,
    },
  };
}

/** Import the valid rows (and duplicates unless skipped) as one batch. Rows with errors are skipped. */
export async function runImport(db, ctx, rawRows, { fileName = null, skipDuplicates = true } = {}) {
  const prepared = await prepareImport(db, ctx.orgId, rawRows);
  const toImport = prepared.results.filter((r) => r.status === 'ok' || (r.status === 'duplicate' && !skipDuplicates));
  if (!toImport.length) throw new HttpError(400, 'There are no valid rows to import');

  // Create missing customers/vendors (once per name).
  const createdIds = [];
  const createdByName = new Map();
  for (const r of toImport) {
    const p = r.parsed;
    if (!p.createCompany) continue;
    const k = norm(p.customer);
    if (!createdByName.has(k)) {
      const { rows } = await db.query('INSERT INTO companies (organization_id, name) VALUES ($1, $2) RETURNING id', [ctx.orgId, p.customer]);
      createdByName.set(k, rows[0].id);
      createdIds.push(rows[0].id);
    }
    p.companyId = createdByName.get(k);
  }

  const { rows: [batch] } = await db.query(
    `INSERT INTO import_batches (organization_id, file_name, row_count, created_company_ids, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ctx.orgId, fileName ? String(fileName).slice(0, 200) : null, toImport.length, createdIds, ctx.userId],
  );
  for (const r of toImport) {
    const p = r.parsed;
    const id = await saveIncomeExpense(db, ctx, p.type, {
      date: p.date, amount: fromCents(p.amount), accountId: p.headerAccountId, fundId: p.fundId, companyId: p.companyId,
      memo: p.description, method: 'electronic',
      lines: [{ accountId: p.detailAccountId, amount: fromCents(p.amount), fundId: p.fundId, memo: p.description }],
    });
    await db.query('UPDATE transactions SET import_batch_id = $1 WHERE id = $2', [batch.id, id]);
  }
  return {
    batchId: batch.id,
    imported: toImport.length,
    skippedErrors: prepared.summary.errors,
    skippedDuplicates: skipDuplicates ? prepared.summary.duplicates : 0,
    createdCompanies: createdIds.length,
  };
}

/** Delete every transaction an import created (and the names it created, if no longer used). */
export async function undoImport(db, ctx, batchId) {
  const { rows: [batch] } = await db.query('SELECT * FROM import_batches WHERE id = $1 AND organization_id = $2 FOR UPDATE', [batchId, ctx.orgId]);
  if (!batch) throw new HttpError(404, 'Import not found');
  if (batch.undone_at) throw new HttpError(409, 'This import has already been undone');
  const { rows: txns } = await db.query(
    'SELECT id, transaction_type, date FROM transactions WHERE import_batch_id = $1 AND organization_id = $2 ORDER BY id', [batchId, ctx.orgId]);
  for (const t of txns) {
    try {
      await deleteTransaction(db, ctx.orgId, t.id, t.transaction_type);
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(409, `Can't undo: the ${t.transaction_type} dated ${t.date} (#${t.id}) can't be deleted. ${err.message}`);
      throw err;
    }
  }
  let removedCompanies = 0;
  if (batch.created_company_ids.length) {
    const res = await db.query(
      `DELETE FROM companies c WHERE c.organization_id = $1 AND c.id = ANY($2::int[])
         AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.company_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM tuition_records tr WHERE tr.company_id = c.id)`,
      [ctx.orgId, batch.created_company_ids],
    );
    removedCompanies = res.rowCount;
  }
  // Accounts a QuickBooks export import created, if nothing uses them any more.
  let removedAccounts = 0;
  if (batch.created_account_ids?.length) {
    const res = await db.query(
      `DELETE FROM accounts a WHERE a.organization_id = $1 AND a.id = ANY($2::int[])
         AND NOT EXISTS (SELECT 1 FROM gl_details g WHERE g.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM transaction_details d WHERE d.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.default_income_account_id = a.id OR c.default_expense_account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM reconciliations r WHERE r.service_charge_account_id = a.id OR r.interest_account_id = a.id)`,
      [ctx.orgId, batch.created_account_ids],
    );
    removedAccounts = res.rowCount;
  }
  await db.query('UPDATE import_batches SET undone_at = now(), undone_by_user_id = $1 WHERE id = $2', [ctx.userId, batchId]);
  return { deleted: txns.length, removedCompanies, removedAccounts };
}

