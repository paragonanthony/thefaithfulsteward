import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone drift).
pg.types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/npacct';
const useSsl = process.env.PGSSL === 'true' || /sslmode=require/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
});

/**
 * The signed-in user for the current request. Database triggers record it in created_by_user_id /
 * updated_by_user_id, via the transaction-local setting app.user_id.
 */
export const requestContext = new AsyncLocalStorage();
export const currentUserId = () => requestContext.getStore()?.userId ?? null;

/** Tag the current transaction on `client` with the request's user (call right after BEGIN). */
export async function applyUserContext(client) {
  const uid = currentUserId();
  if (uid) await client.query("SELECT set_config('app.user_id', $1, true)", [String(uid)]);
}

const WRITE_SQL = /^\s*(insert|update|delete|with)\b/i;

/** Run a query. Writes made during a request run in a short transaction tagged with the user. */
export async function query(text, params) {
  if (!currentUserId() || !WRITE_SQL.test(text)) return pool.query(text, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyUserContext(client);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn(client) inside a transaction (tagged with the request's user). */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyUserContext(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
