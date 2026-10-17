import { addDays } from './dates.js';

// Match the lines of a bank statement to the transactions waiting to be cleared in a reconciliation.

const cents = (v) => Math.round(Number(v || 0) * 100);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const checkNumber = (description) => {
  const d = String(description || '').trim();
  const m = /\b(?:check|chk|ck)\s*(?:no\.?|#)?\s*(\d{2,8})\b/i.exec(d);
  if (m) return m[1].replace(/^0+/, '');
  return /^\d{3,8}$/.test(d) ? d.replace(/^0+/, '') : null;
};

/**
 * items: statement lines [{ date, description, amount (signed: + money in), kind: transaction | fee | interest }].
 * candidates: reconciliation candidates [{ id, date, amount (positive), direction: in | out, check_number }].
 * A line matches a transaction with the same signed amount: a matching check number first, then the closest date
 * (within 10 days, or 90 for checks, which can take a while to clear). Each transaction matches at most one line.
 * Fee and interest lines that match nothing become the reconciliation's service charge and interest.
 * Returns { matched: [{ index, transactionId }], missing: [index], notOnStatement: [transactionId], serviceCharge, interest }.
 */
export function matchStatement(items, candidates, { statementEnd = null } = {}) {
  const lines = (items || []).map((it, index) => ({ index, cents: cents(it.amount), date: it.date, kind: it.kind || 'transaction', check: checkNumber(it.description) }));
  const signed = (c) => (c.direction === 'out' ? -1 : 1) * cents(c.amount);
  const pairs = [];
  for (const l of lines) {
    if (!l.cents || !l.date) continue;
    for (const c of candidates) {
      if (signed(c) !== l.cents) continue;
      const days = Math.abs(dayDiff(c.date, l.date));
      const sameCheck = Boolean(l.check && c.check_number && String(c.check_number).replace(/^0+/, '') === l.check);
      if (!sameCheck && days > (c.check_number ? 90 : 10)) continue;
      pairs.push({ l, c, score: (sameCheck ? 0 : 1000) + (l.kind === 'transaction' ? 0 : 100) + days });
    }
  }
  pairs.sort((a, b) => a.score - b.score || a.l.index - b.l.index || a.c.id - b.c.id);
  const usedLines = new Set();
  const usedTxns = new Set();
  const matched = [];
  for (const p of pairs) {
    if (usedLines.has(p.l.index) || usedTxns.has(p.c.id)) continue;
    usedLines.add(p.l.index);
    usedTxns.add(p.c.id);
    matched.push({ index: p.l.index, transactionId: p.c.id });
  }
  matched.sort((a, b) => a.index - b.index);
  const unmatched = lines.filter((l) => !usedLines.has(l.index));
  const total = (kind) => unmatched.filter((l) => l.kind === kind).reduce((s, l) => s + Math.abs(l.cents), 0) / 100;
  const end = statementEnd ? addDays(statementEnd, 0) : null;
  return {
    matched,
    missing: unmatched.filter((l) => l.kind === 'transaction').map((l) => l.index),
    notOnStatement: candidates.filter((c) => !usedTxns.has(c.id) && (!end || c.date <= end)).map((c) => c.id),
    serviceCharge: total('fee').toFixed(2),
    interest: total('interest').toFixed(2),
  };
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : (Math.round(Number(v) * 100) / 100).toFixed(2));

/** A statement extract as stored on a reconciliation: { fileName, items, statement, warnings, notes, missing }. */
export function cleanExtract(x) {
  if (!x || typeof x !== 'object') return null;
  const items = (Array.isArray(x.items) ? x.items : []).slice(0, 3000)
    .filter((i) => isDay(i?.date) && money(i.amount) !== null)
    .map((i) => ({ date: i.date, description: str(i.description, 500) || '', amount: money(i.amount), kind: ['fee', 'interest'].includes(i.kind) ? i.kind : 'transaction' }));
  const st = x.statement || {};
  return {
    fileName: str(x.fileName, 200),
    items,
    statement: {
      accountName: str(st.accountName, 200), last4: str(st.last4, 10), periodStart: isDay(st.periodStart) ? st.periodStart : null, periodEnd: isDay(st.periodEnd) ? st.periodEnd : null,
      openingBalance: money(st.openingBalance), closingBalance: money(st.closingBalance), balanced: typeof st.balanced === 'boolean' ? st.balanced : null,
    },
    warnings: (Array.isArray(x.warnings) ? x.warnings : []).slice(0, 20).map((w) => str(w, 600)).filter(Boolean),
    notes: str(x.notes, 1000),
    // Lines that had no transaction when last saved, so ones created since can be cleared automatically.
    missing: (Array.isArray(x.missing) ? x.missing : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < items.length),
  };
}
