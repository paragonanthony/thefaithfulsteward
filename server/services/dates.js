// Date helpers operating on 'YYYY-MM-DD' strings (UTC math, no time zone drift).
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const parts = (s) => s.split('-').map(Number);
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const todayStr = () => new Date().toISOString().slice(0, 10);

/** Add months to a date; clamps day-of-month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s, n) {
  const [y, m, d] = parts(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDays(s, n) {
  const [y, m, d] = parts(s);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const monthStart = (s) => { const [y, m] = parts(s); return ymd(y, m, 1); };
export const monthEnd = (s) => { const [y, m] = parts(s); return ymd(y, m, daysInMonth(y, m)); };

/** First day of the fiscal year containing date s. */
export function fiscalYearStart(s, fyStartMonth = 1) {
  const [y, m] = parts(s);
  return m >= fyStartMonth ? ymd(y, fyStartMonth, 1) : ymd(y - 1, fyStartMonth, 1);
}
export const fiscalYearEnd = (s, fy = 1) => addDays(addMonths(fiscalYearStart(s, fy), 12), -1);

/** First day of the fiscal quarter containing s. */
export function fiscalQuarterStart(s, fy = 1) {
  const start = fiscalYearStart(s, fy);
  const [sy, sm] = parts(start);
  const [y, m] = parts(s);
  const monthsIn = (y * 12 + m) - (sy * 12 + sm);
  return addMonths(start, Math.floor(monthsIn / 3) * 3);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (s) => { const [y, m] = parts(s); return `${MONTHS[m - 1]} ${y}`; };
export const prettyDate = (s) => { const [y, m, d] = parts(s); return `${MONTHS[m - 1]} ${d}, ${y}`; };

export const minDate = (a, b) => (a < b ? a : b);
export const maxDate = (a, b) => (a > b ? a : b);

/** Resolve a named period to { from, to } relative to today. */
export function resolvePeriod(period, fy = 1, today = todayStr()) {
  switch (period) {
    case 'today': return { from: fiscalYearStart(today, fy), to: today };
    case 'this_month': return { from: monthStart(today), to: monthEnd(today) };
    case 'last_month': { const p = addMonths(monthStart(today), -1); return { from: p, to: monthEnd(p) }; }
    case 'this_quarter': { const q = fiscalQuarterStart(today, fy); return { from: q, to: addDays(addMonths(q, 3), -1) }; }
    case 'last_quarter': { const q = addMonths(fiscalQuarterStart(today, fy), -3); return { from: q, to: addDays(addMonths(q, 3), -1) }; }
    case 'last_fiscal_year': { const s = addMonths(fiscalYearStart(today, fy), -12); return { from: s, to: addDays(addMonths(s, 12), -1) }; }
    case 'fiscal_ytd': return { from: fiscalYearStart(today, fy), to: today };
    case 'all': return { from: '1900-01-01', to: today };
    case 'this_fiscal_year':
    default: return { from: fiscalYearStart(today, fy), to: fiscalYearEnd(today, fy) };
  }
}
