import { HttpError } from '../util.js';
import { prettyDate, parts } from './dates.js';

// Tuition reports list tuition records (not GL balances). Definition format:
// {
//   type: 'tuition',
//   dateMode: 'as_of' | 'period',   // as_of: records dated on/before the date, payments through it
//                                   // period: records dated within the range, payments through its end
//   defaultPeriod, status: 'unpaid' | 'paid' | 'all',
//   customers: [id], funds: [id | 'none'], descriptionContains: '', minBalance: number | null,
//   columns: [column key, ...], groupBy: 'none' | 'customer' | 'fund' | 'description' | 'month',
//   showDetail, showSubtotals, showTotals, sortBy: column key, sortDir: 'asc' | 'desc'
// }

export const TUITION_COLUMNS = {
  date: { label: 'Date', type: 'date' },
  customer: { label: 'Customer', type: 'text' },
  description: { label: 'Description', type: 'text' },
  amount: { label: 'Tuition', type: 'money', total: true },
  paid: { label: 'Paid', type: 'money', total: true },
  balance: { label: 'Balance', type: 'money', total: true },
  percent_paid: { label: '% Paid', type: 'percent' },
  last_payment: { label: 'Last Payment', type: 'date' },
  payments: { label: 'Payments', type: 'number', total: true },
  days_outstanding: { label: 'Days Outstanding', type: 'number' },
  age_current: { label: '0–30 Days', type: 'money', total: true },
  age_31_60: { label: '31–60 Days', type: 'money', total: true },
  age_61_90: { label: '61–90 Days', type: 'money', total: true },
  age_over_90: { label: 'Over 90 Days', type: 'money', total: true },
  fund: { label: 'Fund', type: 'text' },
  income_account: { label: 'Income Account', type: 'text' },
  memo: { label: 'Memo', type: 'text' },
  email: { label: 'Email', type: 'text' },
  phone: { label: 'Phone', type: 'text' },
};
const GROUPS = ['none', 'customer', 'fund', 'description', 'month'];

export function tuitionBalancesDefinition() {
  return {
    type: 'tuition', dateMode: 'as_of', defaultPeriod: 'today', status: 'unpaid',
    customers: [], funds: [], descriptionContains: '', minBalance: null,
    columns: ['date', 'customer', 'description', 'amount', 'paid', 'balance', 'days_outstanding'],
    groupBy: 'customer', showDetail: true, showSubtotals: true, showTotals: true, sortBy: 'date', sortDir: 'asc',
  };
}

export function normalizeTuitionDefinition(def = {}) {
  const dateMode = def.dateMode === 'period' ? 'period' : 'as_of';
  const columns = (Array.isArray(def.columns) ? def.columns : []).filter((c, i, a) => TUITION_COLUMNS[c] && a.indexOf(c) === i);
  if (!columns.length) throw new HttpError(400, 'Choose at least one column');
  const minBalance = def.minBalance === null || def.minBalance === undefined || def.minBalance === '' ? null : Number(def.minBalance);
  return {
    type: 'tuition',
    dateMode,
    defaultPeriod: def.defaultPeriod || (dateMode === 'as_of' ? 'today' : 'this_fiscal_year'),
    status: ['unpaid', 'paid', 'all'].includes(def.status) ? def.status : 'unpaid',
    customers: (def.customers || []).map(Number).filter(Number.isInteger),
    funds: (def.funds || []).map((f) => (f === 'none' ? 'none' : Number(f))).filter((f) => f === 'none' || Number.isInteger(f)),
    descriptionContains: String(def.descriptionContains || '').slice(0, 100),
    minBalance: Number.isFinite(minBalance) ? minBalance : null,
    columns,
    groupBy: GROUPS.includes(def.groupBy) ? def.groupBy : 'none',
    showDetail: def.showDetail !== false,
    showSubtotals: def.showSubtotals !== false,
    showTotals: def.showTotals !== false,
    sortBy: TUITION_COLUMNS[def.sortBy] ? def.sortBy : 'date',
    sortDir: def.sortDir === 'desc' ? 'desc' : 'asc',
  };
}

const daysBetween = (a, b) => {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const round2 = (n) => Math.round(n * 100) / 100;

export async function runTuitionReport(db, orgId, rawDef, { from, to }) {
  const def = normalizeTuitionDefinition(rawDef);
  const { rows: [org] } = await db.query('SELECT name, tuition_enabled FROM organizations WHERE id = $1', [orgId]);
  if (!org?.tuition_enabled) throw new HttpError(403, 'Tuition tracking is not enabled for this organization');
  if (!to) throw new HttpError(400, 'Report date is required');
  const period = def.dateMode === 'period';
  if (period && !from) throw new HttpError(400, 'Report date range is required');

  const params = [orgId, to];
  let where = 'tr.organization_id = $1 AND tr.date <= $2';
  if (period) { params.push(from); where += ` AND tr.date >= $${params.length}`; }
  if (def.customers.length) { params.push(def.customers); where += ` AND tr.company_id = ANY($${params.length}::int[])`; }
  if (def.funds.length) {
    const ids = def.funds.filter((f) => f !== 'none');
    const fundParts = [];
    if (ids.length) { params.push(ids); fundParts.push(`tr.fund_id = ANY($${params.length}::int[])`); }
    if (def.funds.includes('none')) fundParts.push('tr.fund_id IS NULL');
    where += ` AND (${fundParts.join(' OR ')})`;
  }
  if (def.descriptionContains.trim()) { params.push(def.descriptionContains.trim()); where += ` AND tr.description ILIKE '%'||$${params.length}||'%'`; }

  // Payments count only when the income is dated on or before the report date.
  const { rows } = await db.query(
    `SELECT tr.id, tr.date, tr.description, tr.amount, tr.memo, c.name AS customer, c.email, c.phone1 AS phone,
            f.name AS fund, a.account_number, a.name AS account_name,
            COALESCE(p.paid, 0) AS paid, p.last_payment, COALESCE(p.payments, 0)::int AS payments
       FROM tuition_records tr
       JOIN companies c ON c.id = tr.company_id
       LEFT JOIN funds f ON f.id = tr.fund_id
       LEFT JOIN accounts a ON a.id = tr.income_account_id
       LEFT JOIN (
         SELECT d.tuition_id, SUM(d.amount) AS paid, MAX(t.date) AS last_payment, COUNT(DISTINCT t.id) AS payments
           FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id
          WHERE d.tuition_id IS NOT NULL AND t.organization_id = $1 AND t.date <= $2
          GROUP BY d.tuition_id) p ON p.tuition_id = tr.id
      WHERE ${where}`,
    params,
  );

  let records = rows.map((r) => {
    const amount = Number(r.amount);
    const paid = Number(r.paid);
    const balance = round2(amount - paid);
    const age = daysBetween(r.date, to);
    const due = balance > 0 ? balance : 0;
    return {
      id: r.id, date: r.date, customer: r.customer, description: r.description || '', amount, paid, balance,
      percent_paid: amount ? round2((paid / amount) * 100) : null,
      last_payment: r.last_payment || null, payments: r.payments,
      days_outstanding: balance > 0 ? age : null,
      age_current: age <= 30 ? due : 0, age_31_60: age > 30 && age <= 60 ? due : 0,
      age_61_90: age > 60 && age <= 90 ? due : 0, age_over_90: age > 90 ? due : 0,
      fund: r.fund || '', income_account: r.account_name ? `${r.account_number ? `${r.account_number} · ` : ''}${r.account_name}` : '',
      memo: r.memo || '', email: r.email || '', phone: r.phone || '',
    };
  });
  if (def.status === 'unpaid') records = records.filter((r) => r.balance > 0);
  if (def.status === 'paid') records = records.filter((r) => r.balance <= 0);
  if (def.minBalance !== null) records = records.filter((r) => r.balance >= def.minBalance);

  const dir = def.sortDir === 'desc' ? -1 : 1;
  const sortType = TUITION_COLUMNS[def.sortBy].type;
  const cmp = (a, b) => {
    const x = a[def.sortBy];
    const y = b[def.sortBy];
    if (x === y) return a.id - b.id;
    if (x === null || x === undefined || x === '') return 1;
    if (y === null || y === undefined || y === '') return -1;
    return (sortType === 'text' ? String(x).localeCompare(String(y)) : x < y ? -1 : 1) * dir;
  };
  records.sort(cmp);

  const totalKeys = def.columns.filter((c) => TUITION_COLUMNS[c].total);
  const totalOf = (list) => Object.fromEntries(totalKeys.map((k) => [k, round2(list.reduce((s, r) => s + (r[k] || 0), 0))]));
  const groupKey = (r) => {
    if (def.groupBy === 'customer') return r.customer;
    if (def.groupBy === 'fund') return r.fund || 'No Fund';
    if (def.groupBy === 'description') return r.description || '(No description)';
    if (def.groupBy === 'month') return r.date.slice(0, 7);
    return '';
  };
  let groups = [];
  if (def.groupBy === 'none') groups = [{ label: null, rows: records }];
  else {
    const map = new Map();
    for (const r of records) {
      const k = groupKey(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    groups = [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, list]) => ({ label: def.groupBy === 'month' ? `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : k, rows: list, count: list.length, subtotal: totalOf(list) }));
  }

  return {
    organization: org.name,
    type: 'tuition',
    subtitle: period ? `Tuition dated ${prettyDate(from)} – ${prettyDate(to)}` : `As of ${prettyDate(to)}`,
    columns: def.columns.map((k) => ({ key: k, ...TUITION_COLUMNS[k] })),
    groupBy: def.groupBy,
    showDetail: def.showDetail,
    showSubtotals: def.showSubtotals,
    showTotals: def.showTotals,
    groups,
    count: records.length,
    totals: totalOf(records),
  };
}
