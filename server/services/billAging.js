import { HttpError } from '../util.js';
import { prettyDate } from './dates.js';

// Unpaid Bills Aging (accounts payable aging) as of a date: each vendor's unpaid bills, split into aging columns.
// A bill's balance as of the date = its amount less payments dated on or before the date.
//
// Definition: { type: 'bill_aging', defaultPeriod, fundFilter: [id | 'none'],
//               options: { showBills, agingBasis: 'due_date' | 'bill_date', interval (days), periods } }

const NO_FUND = 'none';

export function billAgingDefinition() {
  return { type: 'bill_aging', defaultPeriod: 'today', fundFilter: [], options: { showBills: true, agingBasis: 'due_date', interval: 30, periods: 3 } };
}

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

export function normalizeBillAgingDefinition(def = {}) {
  return {
    type: 'bill_aging',
    defaultPeriod: def.defaultPeriod || 'today',
    fundFilter: (def.fundFilter || []).map((f) => (f === NO_FUND ? NO_FUND : String(Number(f)))).filter((f) => f === NO_FUND || Number(f) > 0),
    options: {
      showBills: def.options?.showBills !== false,
      agingBasis: def.options?.agingBasis === 'bill_date' ? 'bill_date' : 'due_date',
      interval: clampInt(def.options?.interval, 1, 365, 30),
      periods: clampInt(def.options?.periods, 1, 8, 3),
    },
  };
}

const dayDiff = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const shortDate = (s) => { const [y, m, d] = s.split('-'); return `${m}/${d}/${y}`; };

export async function runBillAging(db, orgId, rawDef, { to }) {
  const def = normalizeBillAgingDefinition(rawDef);
  if (!to) throw new HttpError(400, 'Report date is required');
  const { interval, periods, agingBasis, showBills } = def.options;
  const { rows: [org] } = await db.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const { rows: funds } = await db.query('SELECT id, name FROM funds WHERE organization_id = $1', [orgId]);

  const params = [orgId, to];
  let fundSql = '';
  if (def.fundFilter.length) {
    const ids = def.fundFilter.filter((f) => f !== NO_FUND).map(Number);
    const parts = [];
    if (ids.length) { params.push(ids); parts.push(`b.fund_id = ANY($${params.length}::int[])`); }
    if (def.fundFilter.includes(NO_FUND)) parts.push('b.fund_id IS NULL');
    fundSql = ` AND (${parts.join(' OR ')})`;
  }
  const { rows } = await db.query(
    `SELECT b.id, b.date, b.due_date, b.ref_number, b.company_id, c.name AS company_name,
            ROUND(b.amount * 100)::bigint - COALESCE((
              SELECT SUM(ROUND(d.amount * 100)) FROM transaction_details d JOIN transactions p ON p.id = d.transaction_id
               WHERE d.bill_id = b.id AND p.date <= $2), 0)::bigint AS balance
       FROM transactions b LEFT JOIN companies c ON c.id = b.company_id
      WHERE b.organization_id = $1 AND b.transaction_type = 'bill' AND b.date <= $2${fundSql}
      ORDER BY c.name, b.company_id, COALESCE(b.due_date, b.date), b.id`,
    params,
  );

  // Columns: by due date, "Current" (not yet due) then days past due; by bill date, days since the bill.
  const labels = [];
  if (agingBasis === 'due_date') labels.push('Current');
  for (let i = 0; i < periods; i += 1) {
    const lo = i * interval + (agingBasis === 'due_date' || i > 0 ? 1 : 0);
    labels.push(`${lo}–${(i + 1) * interval}`);
  }
  labels.push(`Over ${periods * interval}`);
  const n = labels.length;
  const bucketOf = (bill) => {
    if (agingBasis === 'due_date') {
      const late = dayDiff(bill.due_date || bill.date, to); // no due date = due on the bill date
      if (late <= 0) return 0;
      return Math.min(1 + Math.floor((late - 1) / interval), n - 1);
    }
    const age = Math.max(0, dayDiff(bill.date, to));
    return Math.min(age === 0 ? 0 : Math.floor((age - 1) / interval), n - 1);
  };
  const empty = () => Array(n + 1).fill(0); // aging columns + Total
  const addTo = (vals, bucket, amt) => { vals[bucket] += amt; vals[n] += amt; };

  const vendors = new Map();
  for (const b of rows) {
    const bal = Number(b.balance);
    if (bal <= 0) continue;
    const key = b.company_id ?? 0;
    if (!vendors.has(key)) vendors.set(key, { name: b.company_name || '(No vendor)', bills: [], totals: empty() });
    const v = vendors.get(key);
    const values = empty();
    addTo(values, bucketOf(b), bal);
    v.bills.push({ bill: b, values });
    addTo(v.totals, bucketOf(b), bal);
  }

  const lines = [];
  const grand = empty();
  for (const v of vendors.values()) {
    v.totals.forEach((x, i) => { grand[i] += x; });
    if (!showBills) { lines.push({ type: 'account', label: v.name, level: 0, values: v.totals }); continue; }
    lines.push({ type: 'subheader', label: v.name, level: 0 });
    for (const { bill: b, values } of v.bills) {
      const due = b.due_date ? ` · due ${shortDate(b.due_date)}` : '';
      lines.push({ type: 'account', label: `${shortDate(b.date)} · ${b.ref_number ? `Bill ${b.ref_number}` : 'Bill'}${due}`, level: 1, values, link: `/bills/${b.id}` });
    }
    lines.push({ type: 'subtotal', label: `Total ${v.name}`, level: 0, values: v.totals });
  }
  if (!vendors.size) lines.push({ type: 'line', label: 'No unpaid bills', level: 0, values: empty() });
  lines.push({ type: 'spacer' });
  lines.push({ type: 'formula', style: 'grand', label: 'Total Unpaid Bills', level: 0, values: grand });

  const fundNames = Object.fromEntries(funds.map((f) => [String(f.id), f.name]));
  return {
    organization: org.name,
    type: 'bill_aging',
    from: null,
    to,
    subtitle: `As of ${prettyDate(to)} · aged by ${agingBasis === 'due_date' ? 'days past due' : 'days since the bill date'}`,
    fundFilter: def.fundFilter.length ? def.fundFilter.map((k) => (k === NO_FUND ? 'No Fund' : fundNames[k] || k)) : null,
    hasPercent: false,
    columns: [
      ...labels.map((label, i) => ({ key: `c${i}`, label, from: null, to, funds: null, kind: 'amount', noDrill: true })),
      { key: `c${n}`, label: 'Total', from: null, to, funds: null, kind: 'amount', isTotal: true, noDrill: true },
    ],
    lines,
  };
}
