import { HttpError, fromCents, idOrNull, loadOwned, toCents } from '../util.js';
import { BANKING_TYPES } from '../accountTypes.js';

// Bank feed rules set a line's customer / vendor and account from its description (and optionally its amount).
// The first active rule that matches (by sort order) wins. Lines someone assigned by hand on the Bank Feed are left
// alone, as are matched and ignored lines. When a rule sets a customer / vendor but no account, the name's default
// income account (money in) or expense account (money out) is used.

/** The account a customer / vendor defaults to for a line (money in: income account; money out: expense account). */
const DEFAULT_ACCOUNT_SQL = (amount) => `CASE WHEN ${amount} > 0 THEN c.default_income_account_id ELSE c.default_expense_account_id END`;

/**
 * (Re)apply the rules to the organization's unmatched lines that weren't assigned by hand.
 * `itemIds` limits it to those lines (e.g. ones just imported). Returns how many lines a rule now assigns.
 */
export async function applyRules(db, orgId, { itemIds = null } = {}) {
  const scope = itemIds ? 'AND b.id = ANY($2::int[])' : '';
  const params = itemIds ? [orgId, itemIds] : [orgId];
  if (itemIds && !itemIds.length) return 0;
  // Forget what rules set before, so a changed or deleted rule doesn't leave stale values.
  await db.query(
    `UPDATE bank_feed_items b SET company_id = NULL, assigned_account_id = NULL, assigned_by = NULL, rule_id = NULL
      WHERE b.organization_id = $1 AND b.status = 'unmatched' AND b.assigned_by = 'rule' ${scope}`, params);
  const { rowCount } = await db.query(
    `UPDATE bank_feed_items b
        SET company_id = m.company_id,
            assigned_account_id = COALESCE(m.account_id, ${DEFAULT_ACCOUNT_SQL('b.amount')}),
            assigned_by = 'rule', rule_id = m.id
       FROM bank_feed_items b2
       CROSS JOIN LATERAL (
         SELECT r.id, r.company_id, r.account_id FROM bank_feed_rules r
          WHERE r.organization_id = b2.organization_id AND r.is_active
            AND (r.bank_account_id IS NULL OR r.bank_account_id = b2.account_id)
            AND strpos(lower(b2.description), lower(r.match_text)) > 0
            AND (r.direction = 'any' OR (r.direction = 'in' AND b2.amount > 0) OR (r.direction = 'out' AND b2.amount < 0))
            AND (r.min_amount IS NULL OR abs(b2.amount) >= r.min_amount)
            AND (r.max_amount IS NULL OR abs(b2.amount) < r.max_amount)
          ORDER BY r.sort_order, r.id LIMIT 1) m
       LEFT JOIN companies c ON c.id = m.company_id
      WHERE b.id = b2.id AND b.organization_id = $1 AND b.status = 'unmatched' AND b.assigned_by IS NULL ${scope}`,
    params);
  return rowCount;
}

/** Validate and normalize a rule from the request body. */
export async function cleanRule(db, orgId, body) {
  const matchText = String(body.matchText || '').trim();
  if (!matchText) throw new HttpError(400, 'Enter the text the bank description contains');
  const direction = ['any', 'in', 'out'].includes(body.direction) ? body.direction : 'any';
  const amount = (v, label) => {
    if (v === '' || v === null || v === undefined) return null;
    const c = Math.abs(toCents(v));
    if (Number.isNaN(c)) throw new HttpError(400, `${label} isn’t a valid amount`);
    return c;
  };
  const min = amount(body.minAmount, 'Amount from');
  const max = amount(body.maxAmount, 'Amount under');
  if (max === 0) throw new HttpError(400, 'Amount under must be more than zero');
  if (min !== null && max !== null && max <= min) throw new HttpError(400, 'Amount under must be more than Amount from');
  const companyId = idOrNull(body.companyId);
  const accountId = idOrNull(body.accountId);
  const bankAccountId = idOrNull(body.bankAccountId);
  if (!companyId && !accountId) throw new HttpError(400, 'Choose the customer / vendor, the account, or both, that the rule sets');
  if (companyId) await loadOwned(db, 'companies', [companyId], orgId, 'customer / vendor');
  const ids = [accountId, bankAccountId].filter(Boolean);
  if (ids.length) {
    const accts = await loadOwned(db, 'accounts', ids, orgId, 'account');
    if (bankAccountId && !BANKING_TYPES.includes(accts[bankAccountId].account_type)) throw new HttpError(400, 'The bank account must be a Bank or Credit Card account');
  }
  return {
    name: String(body.name || '').trim().slice(0, 200) || null,
    matchText: matchText.slice(0, 200),
    direction,
    minAmount: min === null ? null : fromCents(min),
    maxAmount: max === null ? null : fromCents(max),
    bankAccountId,
    companyId,
    accountId,
    isActive: body.isActive !== false,
  };
}
