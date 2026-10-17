// List paging. A list request with ?page=N (1-based) gets one page of PAGE_SIZE rows plus the total count and any
// totals the screen shows (computed over every matching row, not just the page). Without ?page the endpoint returns
// its usual plain array (capped), so other callers are unaffected.
export const PAGE_SIZE = 500;

/** { page, size, offset } when the request asks for a page, otherwise null. */
export function pageParams(req) {
  if (req.query.page === undefined) return null;
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const size = Math.min(PAGE_SIZE, Math.max(1, Math.floor(Number(req.query.pageSize)) || PAGE_SIZE));
  return { page, size, offset: (page - 1) * size };
}

/**
 * The ORDER BY for ?sort=key&dir=asc|desc, when key is one of the list's sortable columns (sorts: { key: 'SQL' });
 * otherwise the list's usual order. Rows with no value sort last; idCol breaks ties so paging is stable.
 */
export function sortOrder(req, sorts, fallback, idCol) {
  const expr = sorts?.[String(req.query.sort || '')];
  if (!expr) return fallback;
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  return `${expr} ${dir} NULLS LAST, ${idCol} ${dir}`;
}

/**
 * Run a list query. sql is the SELECT ... FROM ... WHERE (no ORDER BY / LIMIT); orderBy is the usual ORDER BY clause,
 * and sorts the columns the user can sort by (?sort=&dir=); sums maps a total's name to an aggregate over the
 * query's output columns (as q.column), e.g. { amount: 'SUM(q.amount)' }.
 * Returns the plain array (up to cap rows) when not paging, otherwise { rows, total, page, pageSize, totals }.
 */
export async function listQuery(query, req, { sql, params, orderBy: usual, sorts, idCol = 't.id', cap = 1000, sums = {} }) {
  const orderBy = sortOrder(req, sorts, usual, idCol);
  const pg = pageParams(req);
  if (!pg) return (await query(`${sql} ORDER BY ${orderBy} LIMIT ${cap}`, params)).rows;
  const sumSql = Object.entries(sums).map(([k, expr]) => `, ${expr} AS "${k}"`).join('');
  const [{ rows }, { rows: [agg] }] = await Promise.all([
    query(`${sql} ORDER BY ${orderBy} LIMIT ${pg.size} OFFSET ${pg.offset}`, params),
    query(`SELECT COUNT(*)::int AS total${sumSql} FROM (${sql}) q`, params),
  ]);
  const totals = Object.fromEntries(Object.keys(sums).map((k) => [k, agg[k] === null ? '0.00' : String(agg[k])]));
  return { rows, total: agg.total, page: pg.page, pageSize: pg.size, totals };
}
