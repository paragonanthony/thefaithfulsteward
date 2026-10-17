import { TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError, emptyToNull, fromCents, idOrNull, loadOwned, requireDate, toCents } from '../util.js';
import { addMonths, maxDate, minDate, monthEnd, monthStart } from './dates.js';

export const MAX_BUDGET_MONTHS = 60;

/** First day of each month a budget covers (partial first / last months included). */
export function budgetMonths(start, end) {
  const out = [];
  for (let m = monthStart(start); m <= end; m = addMonths(m, 1)) out.push(m);
  return out;
}

const days = (from, to) => (Date.parse(to) - Date.parse(from)) / 86400000 + 1;

/**
 * Budgeted amount per account (cents, normal-balance sign) for the part of [from, to] the budget covers.
 * from = null means "from the start of the budget". A month that is only partly in range is prorated by day.
 */
export function budgetAmounts(budget, lines, from, to) {
  const out = new Map();
  for (const l of lines) {
    const mFrom = maxDate(l.month, budget.start_date);
    const mTo = minDate(monthEnd(l.month), budget.end_date);
    const oFrom = from ? maxDate(mFrom, from) : mFrom;
    const oTo = minDate(mTo, to);
    if (oFrom > oTo) continue;
    out.set(l.account_id, (out.get(l.account_id) || 0) + (l.cents * days(oFrom, oTo)) / days(mFrom, mTo));
  }
  for (const [k, v] of out) out.set(k, Math.round(v));
  return out;
}

export async function loadBudget(db, orgId, id) {
  const { rows } = await db.query(
    `SELECT b.*, f.name AS fund_name FROM budgets b LEFT JOIN funds f ON f.id = b.fund_id
      WHERE b.id = $1 AND b.organization_id = $2`, [Number(id), orgId]);
  if (!rows.length) throw new HttpError(404, 'Budget not found');
  const { rows: lines } = await db.query(
    'SELECT account_id, month, amount, ROUND(amount * 100)::bigint AS cents FROM budget_lines WHERE budget_id = $1 ORDER BY account_id, month',
    [rows[0].id]);
  return { ...rows[0], lines: lines.map((l) => ({ account_id: l.account_id, month: l.month, amount: l.amount, cents: Number(l.cents) })) };
}

/** The budget a report uses when none is chosen: one covering the report date, else the most recent. */
export async function defaultBudgetId(db, orgId, to) {
  const { rows } = await db.query(
    `SELECT id FROM budgets WHERE organization_id = $1
      ORDER BY ($2::date BETWEEN start_date AND end_date) DESC, end_date DESC, id DESC LIMIT 1`, [orgId, to]);
  return rows[0]?.id ?? null;
}

const monthKey = (v) => {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
  if (!m) throw new HttpError(400, `Invalid budget month: ${s}`);
  return `${m[1]}-${m[2]}-01`;
};

/** Create or update a budget and (when lines are given) replace its amounts. */
export async function saveBudget(db, ctx, body, id = null) {
  const { orgId } = ctx;
  const name = String(body.name ?? '').trim().slice(0, 200);
  if (!name) throw new HttpError(400, 'Budget name is required');
  const start = requireDate(body.startDate, 'Start date');
  const end = requireDate(body.endDate, 'End date');
  if (end < start) throw new HttpError(400, 'End date must be on or after the start date');
  const months = budgetMonths(start, end);
  if (months.length > MAX_BUDGET_MONTHS) throw new HttpError(400, `A budget can cover at most ${MAX_BUDGET_MONTHS} months`);
  const fundId = idOrNull(body.fundId);
  if (fundId) await loadOwned(db, 'funds', [fundId], orgId, 'fund');
  const description = emptyToNull(String(body.description ?? '').trim().slice(0, 1000));

  let lines = null;
  if (Array.isArray(body.lines)) {
    const inRange = new Set(months);
    const seen = new Set();
    lines = [];
    for (const l of body.lines) {
      const accountId = idOrNull(l.accountId);
      if (!accountId) throw new HttpError(400, 'Each budget amount needs an account');
      const month = monthKey(l.month);
      if (!inRange.has(month)) throw new HttpError(400, `${month.slice(0, 7)} is outside the budget dates`);
      const key = `${accountId}|${month}`;
      if (seen.has(key)) throw new HttpError(400, `Duplicate amount for ${month.slice(0, 7)}`);
      seen.add(key);
      const cents = toCents(l.amount);
      if (cents) lines.push({ accountId, month, cents });
    }
    await loadOwned(db, 'accounts', lines.map((l) => l.accountId), orgId, 'account');
  }

  let budgetId = id;
  try {
    if (id) {
      const { rowCount } = await db.query(
        'UPDATE budgets SET name=$1, description=$2, start_date=$3, end_date=$4, fund_id=$5 WHERE id=$6 AND organization_id=$7',
        [name, description, start, end, fundId, id, orgId]);
      if (!rowCount) throw new HttpError(404, 'Budget not found');
    } else {
      const { rows } = await db.query(
        `INSERT INTO budgets (organization_id, name, description, start_date, end_date, fund_id, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, name, description, start, end, fundId, ctx.userId]);
      budgetId = rows[0].id;
    }
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `A budget named "${name}" already exists`);
    throw err;
  }

  if (lines) {
    await db.query('DELETE FROM budget_lines WHERE budget_id = $1', [budgetId]);
    if (lines.length) {
      await db.query(
        `INSERT INTO budget_lines (budget_id, account_id, month, amount)
         SELECT $1, a, m, c FROM unnest($2::int[], $3::date[], $4::numeric[]) AS x(a, m, c)`,
        [budgetId, lines.map((l) => l.accountId), lines.map((l) => l.month), lines.map((l) => fromCents(l.cents))]);
    }
  } else {
    // Dates changed without new amounts: drop months the budget no longer covers.
    await db.query('DELETE FROM budget_lines WHERE budget_id = $1 AND (month < $2 OR month > $3)', [budgetId, months[0], months[months.length - 1]]);
  }
  return budgetId;
}

/** Copy a budget, optionally moving it to a new start date (every month shifts by the same number of months). */
export async function copyBudget(db, ctx, id, body) {
  const src = await loadBudget(db, ctx.orgId, id);
  const startDate = body.startDate ? requireDate(body.startDate, 'Start date') : src.start_date;
  const [sy, sm] = src.start_date.split('-').map(Number);
  const [ny, nm] = startDate.split('-').map(Number);
  const shift = (ny - sy) * 12 + (nm - sm);
  const shifted = addMonths(src.end_date, shift);
  let endDate = src.end_date === monthEnd(src.end_date) ? monthEnd(shifted) : shifted;
  if (endDate < startDate) endDate = startDate;
  return saveBudget(db, ctx, {
    name: body.name || `${src.name} (Copy)`,
    description: src.description,
    startDate,
    endDate,
    fundId: body.fundId === undefined ? src.fund_id : body.fundId,
    lines: src.lines
      .map((l) => ({ accountId: l.account_id, month: addMonths(l.month, shift), amount: fromCents(l.cents) }))
      .filter((l) => l.month >= monthStart(startDate) && l.month <= endDate),
  });
}

/**
 * Actual monthly activity `yearsBack` years before each budget month, in normal-balance sign, returned
 * as budget lines for the budget's months. Used to start a budget from last year's numbers.
 */
export async function actualsForBudget(db, orgId, { startDate, endDate, fundId = null, yearsBack = 1 }) {
  const start = requireDate(startDate, 'Start date');
  const end = requireDate(endDate, 'End date');
  if (end < start) throw new HttpError(400, 'End date must be on or after the start date');
  const months = budgetMonths(start, end);
  if (months.length > MAX_BUDGET_MONTHS) throw new HttpError(400, `A budget can cover at most ${MAX_BUDGET_MONTHS} months`);
  const back = Math.max(1, Math.min(10, Number(yearsBack) || 1)) * 12;
  const fund = idOrNull(fundId);
  const params = [orgId, addMonths(months[0], -back), monthEnd(addMonths(months[months.length - 1], -back))];
  let fundSql = '';
  if (fund) { params.push(fund); fundSql = ` AND d.fund_id = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT d.account_id, a.account_type, date_trunc('month', h.date)::date AS month,
            SUM(ROUND(d.debit * 100) - ROUND(d.credit * 100))::bigint AS net
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id JOIN accounts a ON a.id = d.account_id
      WHERE h.organization_id = $1 AND h.date BETWEEN $2 AND $3${fundSql}
      GROUP BY d.account_id, a.account_type, date_trunc('month', h.date)`, params);
  return rows
    .map((r) => {
      const net = Number(r.net);
      const cents = TYPE_BY_KEY[r.account_type]?.normal === 'credit' ? -net : net;
      return { accountId: r.account_id, month: addMonths(r.month, back), cents };
    })
    .filter((l) => l.cents !== 0)
    .map(({ cents, ...l }) => ({ ...l, amount: fromCents(cents) }));
}
