// Money is handled as integer cents in application code to avoid floating point error.
export function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) throw new HttpError(400, `Invalid amount: ${value}`);
  return Math.round(n * 100);
}
export const fromCents = (c) => (c / 100).toFixed(2);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Wrap an async route handler so rejected promises reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function requireDate(value, label = 'Date') {
  if (!isDate(value)) throw new HttpError(400, `${label} is required (YYYY-MM-DD)`);
  return value;
}

export const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

export function idOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid id: ${v}`);
  return n;
}

const OWNED_TABLES = new Set(['accounts', 'funds', 'companies', 'account_groups', 'transactions', 'report_definitions', 'check_formats', 'tuition_records', 'budgets']);

/**
 * Verify that every given id belongs to the organization. Prevents a user from referencing
 * another tenant's records by id. Returns the loaded rows keyed by id.
 */
export async function loadOwned(db, table, ids, orgId, label = table) {
  if (!OWNED_TABLES.has(table)) throw new Error(`loadOwned: unsupported table ${table}`);
  const unique = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
  if (!unique.length) return {};
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE organization_id = $1 AND id = ANY($2::int[])`, [orgId, unique]);
  if (rows.length !== unique.length) throw new HttpError(400, `Invalid ${label} reference`);
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}
