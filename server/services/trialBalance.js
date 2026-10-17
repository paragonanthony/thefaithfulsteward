import { ACCOUNT_TYPES, TYPE_BY_KEY } from '../accountTypes.js';
import { HttpError } from '../util.js';
import { addDays, fiscalYearStart, prettyDate } from './dates.js';

// Trial balance as of a date: every account's balance in a Debit or Credit column.
// Balance sheet accounts show their cumulative balance; income and expense accounts show the current fiscal year,
// and earlier years' net activity appears on one "Net Assets – Prior Years' Activity" line (there are no closing
// entries), so total debits equal total credits.
//
// Definition: { type: 'trial_balance', defaultPeriod, fundFilter: [id | 'none'],
//               options: { showZeroRows, showAccountNumbers, groupByType } }

const NO_FUND = 'none';

export function trialBalanceDefinition() {
  return { type: 'trial_balance', defaultPeriod: 'today', fundFilter: [], options: { showZeroRows: false, showAccountNumbers: true, groupByType: false } };
}

export function normalizeTrialBalanceDefinition(def = {}) {
  return {
    type: 'trial_balance',
    defaultPeriod: def.defaultPeriod || 'today',
    fundFilter: (def.fundFilter || []).map((f) => (f === NO_FUND ? NO_FUND : String(Number(f)))).filter((f) => f === NO_FUND || Number(f) > 0),
    options: {
      showZeroRows: Boolean(def.options?.showZeroRows),
      showAccountNumbers: def.options?.showAccountNumbers !== false,
      groupByType: Boolean(def.options?.groupByType),
    },
  };
}

export async function runTrialBalance(db, orgId, rawDef, { to }) {
  const def = normalizeTrialBalanceDefinition(rawDef);
  if (!to) throw new HttpError(400, 'Report date is required');
  const { rows: [org] } = await db.query('SELECT name, fiscal_year_start_month FROM organizations WHERE id = $1', [orgId]);
  const fyStart = fiscalYearStart(to, org.fiscal_year_start_month || 1);
  const { rows: accounts } = await db.query('SELECT id, account_number, name, account_type, is_active FROM accounts WHERE organization_id = $1', [orgId]);
  const { rows: funds } = await db.query('SELECT id, name FROM funds WHERE organization_id = $1', [orgId]);

  const params = [orgId, to, fyStart];
  let fundSql = '';
  if (def.fundFilter.length) {
    const ids = def.fundFilter.filter((f) => f !== NO_FUND).map(Number);
    const parts = [];
    if (ids.length) { params.push(ids); parts.push(`d.fund_id = ANY($${params.length}::int[])`); }
    if (def.fundFilter.includes(NO_FUND)) parts.push('d.fund_id IS NULL');
    fundSql = ` AND (${parts.join(' OR ')})`;
  }
  // Per account: all activity through the date, and the part dated in the current fiscal year (cents, debit - credit).
  const { rows: balances } = await db.query(
    `SELECT d.account_id,
            SUM(ROUND(d.debit * 100) - ROUND(d.credit * 100))::bigint AS total,
            SUM(CASE WHEN h.date >= $3 THEN ROUND(d.debit * 100) - ROUND(d.credit * 100) ELSE 0 END)::bigint AS current_year
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
      WHERE h.organization_id = $1 AND h.date <= $2${fundSql}
      GROUP BY d.account_id`,
    params,
  );
  const byAccount = new Map(balances.map((b) => [b.account_id, { total: Number(b.total), current: Number(b.current_year) }]));

  const typeOrder = Object.fromEntries(ACCOUNT_TYPES.map((t, i) => [t.key, i]));
  const sorted = [...accounts].sort((a, b) => (typeOrder[a.account_type] - typeOrder[b.account_type])
    || (a.account_number || '').localeCompare(b.account_number || '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const label = (a) => (def.options.showAccountNumbers && a.account_number ? `${a.account_number} · ${a.name}` : a.name);
  const split = (raw) => [raw > 0 ? raw : 0, raw < 0 ? -raw : 0];

  let priorYears = 0;
  const groups = new Map(); // account type -> lines
  for (const a of sorted) {
    const b = byAccount.get(a.id) || { total: 0, current: 0 };
    const category = TYPE_BY_KEY[a.account_type]?.category;
    const pl = category === 'income' || category === 'expense';
    const raw = pl ? b.current : b.total;
    if (pl) priorYears += b.total - b.current;
    if (!raw && !(def.options.showZeroRows && a.is_active)) continue;
    if (!groups.has(a.account_type)) groups.set(a.account_type, []);
    groups.get(a.account_type).push({
      type: 'account', label: label(a), level: def.options.groupByType ? 1 : 0, values: split(raw), accountIds: [a.id],
      ...(pl ? { drillFrom: fyStart } : {}),
    });
  }

  const lines = [];
  const add = (vals, l) => [vals[0] + l.values[0], vals[1] + l.values[1]];
  let totals = [0, 0];
  for (const t of ACCOUNT_TYPES) {
    const list = groups.get(t.key);
    if (!list) continue;
    if (def.options.groupByType) lines.push({ type: 'subheader', label: t.label, level: 0 });
    let sub = [0, 0];
    for (const l of list) { lines.push(l); sub = add(sub, l); totals = add(totals, l); }
    if (def.options.groupByType) lines.push({ type: 'subtotal', label: `Total ${t.label}`, level: 0, values: sub, accountIds: list.flatMap((l) => l.accountIds) });
    // Prior years' activity belongs with net assets.
    if (t.key === 'equity' && priorYears) {
      const l = { type: 'line', label: "Net Assets – Prior Years' Activity", level: def.options.groupByType ? 1 : 0, values: split(priorYears) };
      lines.push(l);
      totals = add(totals, l);
    }
  }
  if (priorYears && !groups.has('equity')) {
    const l = { type: 'line', label: "Net Assets – Prior Years' Activity", level: 0, values: split(priorYears) };
    // Insert before the first income/expense line, where the equity section would be.
    const firstPl = lines.findIndex((x) => x.accountIds && ['income', 'other_income', 'expense', 'other_expense'].includes(accounts.find((a) => a.id === x.accountIds[0])?.account_type));
    lines.splice(firstPl < 0 ? lines.length : (def.options.groupByType ? firstPl - 1 : firstPl), 0, l);
    totals = add(totals, l);
  }
  lines.push({ type: 'spacer' });
  lines.push({ type: 'formula', style: 'grand', label: 'Total', level: 0, values: totals });
  if (totals[0] !== totals[1]) {
    lines.push({ type: 'line', label: 'Out of balance', level: 0, values: split(totals[0] - totals[1]) });
  }

  const fundNames = Object.fromEntries(funds.map((f) => [String(f.id), f.name]));
  return {
    organization: org.name,
    type: 'trial_balance',
    from: null,
    to,
    subtitle: `As of ${prettyDate(to)} · income and expenses since ${prettyDate(fyStart)}`,
    fundFilter: def.fundFilter.length ? def.fundFilter.map((k) => (k === NO_FUND ? 'No Fund' : fundNames[k] || k)) : null,
    hasPercent: false,
    columns: [
      { key: 'c0', label: 'Debit', from: null, to, funds: null, kind: 'amount' },
      { key: 'c1', label: 'Credit', from: null, to, funds: null, kind: 'amount' },
    ],
    lines,
    priorYearsThrough: addDays(fyStart, -1),
  };
}
