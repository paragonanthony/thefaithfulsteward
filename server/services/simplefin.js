import { applyUserContext, pool } from '../db.js';
import { decrypt, encrypt, hasEncryptionKey } from '../crypto.js';
import { HttpError, fromCents, toCents } from '../util.js';
import { addDays, maxDate, todayStr } from './dates.js';
import { applyRules } from './bankFeedRules.js';

// Live bank feeds through SimpleFIN (https://www.simplefin.org/protocol.html).
// An organization administrator creates a Setup Token at a SimpleFIN server (e.g. the SimpleFIN Bridge) and pastes it
// here. The token is claimed once for an Access URL, which holds the credentials for reading the accounts. The Access
// URL is stored encrypted per organization (simplefin_connections) and never sent to the browser.
// New posted transactions land in bank_feed_items like statement imports.
// Needs ENCRYPTION_KEY. SIMPLEFIN_ALLOWED_HOSTS limits which servers tokens may point at.

let injectedFetch = null;
/** Tests replace fetch with a fake SimpleFIN server. */
export function setSimplefinFetch(fn) { injectedFetch = fn; }
const doFetch = (...args) => (injectedFetch || fetch)(...args);

export const isConfigured = () => hasEncryptionKey();
const DEFAULT_HOSTS = 'bridge.simplefin.org,beta-bridge.simplefin.org';
const allowedHosts = () => String(process.env.SIMPLEFIN_ALLOWED_HOSTS || DEFAULT_HOSTS).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

// The SimpleFIN Bridge returns at most about 90 days per request, so longer ranges are read in pieces.
const WINDOW_DAYS = 60;
// Each sync re-reads a few days before the last one, so late-posting transactions aren't missed.
const OVERLAP_DAYS = 10;

/** Only https URLs on an allowed SimpleFIN server (tokens are user input, so they must not reach internal hosts). */
function checkServerUrl(raw, what) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, `The ${what} isn’t a valid URL`); }
  if (url.protocol !== 'https:') throw new HttpError(400, `The ${what} must use https`);
  const host = url.hostname.toLowerCase();
  if (!allowedHosts().includes(host)) throw new HttpError(400, `The ${what} points at ${host}, which isn’t an allowed SimpleFIN server`);
  return url;
}

/** Split an Access URL into its base URL and a Basic auth header (fetch refuses URLs with credentials). */
function accessParts(accessUrl) {
  const url = checkServerUrl(accessUrl, 'access URL');
  if (!url.username) throw new HttpError(502, 'The SimpleFIN access URL has no credentials');
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
  url.username = '';
  url.password = '';
  return { base: url.toString().replace(/\/+$/, ''), auth, host: url.hostname.toLowerCase() };
}

const HTTP_MESSAGES = {
  403: 'SimpleFIN refused the access (it may have been revoked). Remove this connection and add a new setup token.',
  402: 'The SimpleFIN subscription needs attention (payment required). Check your SimpleFIN account.',
};

/** GET /accounts. Returns { accounts, errors } where errors are messages SimpleFIN reported (some banks may fail). */
async function getAccounts(accessUrl, params = {}) {
  const { base, auth } = accessParts(accessUrl);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x)); else if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  let res;
  try {
    res = await doFetch(`${base}/accounts?${qs}`, { headers: { Authorization: auth, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  } catch (err) {
    throw new HttpError(502, `Couldn’t reach SimpleFIN: ${err.message}`);
  }
  if (!res.ok) throw new HttpError(502, HTTP_MESSAGES[res.status] || `SimpleFIN returned an error (HTTP ${res.status})`);
  let body;
  try { body = await res.json(); } catch { throw new HttpError(502, 'SimpleFIN returned something that isn’t account data'); }
  // Protocol v1 reports errors as strings; v2 as { code, msg }.
  const errors = [...(body.errors || []), ...(body.errlist || []).map((e) => e?.msg || e?.code)].filter(Boolean).map(String);
  // v2 lists institutions under connections; v1 puts them on each account as org.
  const conns = Object.fromEntries((body.connections || []).map((c) => [c.conn_id, c]));
  const accounts = (body.accounts || []).map((a) => ({
    ...a,
    institution: a.org?.name || a.org?.domain || conns[a.conn_id]?.name || conns[a.conn_id]?.org_name || 'Bank',
  }));
  return { accounts, errors };
}

const isoDate = (unix) => new Date(Number(unix) * 1000).toISOString().slice(0, 10);
const unix = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 1000);

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/** Turn a Setup Token into an Access URL (a token can be claimed only once). */
async function claimSetupToken(token) {
  const clean = String(token || '').trim();
  if (!clean) throw new HttpError(400, 'Paste the SimpleFIN setup token');
  let claimUrl;
  try { claimUrl = Buffer.from(clean, 'base64').toString('utf8').trim(); } catch { claimUrl = ''; }
  if (!/^https?:\/\//i.test(claimUrl)) throw new HttpError(400, 'That doesn’t look like a SimpleFIN setup token');
  checkServerUrl(claimUrl, 'setup token');
  let res;
  try {
    res = await doFetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new HttpError(502, `Couldn’t reach SimpleFIN: ${err.message}`);
  }
  if (res.status === 403) throw new HttpError(400, 'SimpleFIN says this setup token was already used or has expired. Create a new one and try again.');
  if (!res.ok) throw new HttpError(502, `SimpleFIN couldn’t claim the setup token (HTTP ${res.status})`);
  const accessUrl = String(await res.text()).trim();
  accessParts(accessUrl); // validates it
  return accessUrl;
}

/** Save or refresh the organization's accounts from an /accounts response. Returns ids by SimpleFIN account id. */
async function upsertAccounts(db, orgId, connectionId, accounts) {
  const start = addDays(todayStr(), -30);
  const ids = {};
  for (const a of accounts) {
    if (!a?.id) continue;
    const balance = a.balance !== undefined && a.balance !== null && a.balance !== '' ? fromCents(toCents(a.balance)) : null;
    const balanceDate = a['balance-date'] ? new Date(Number(a['balance-date']) * 1000) : null;
    const { rows: [row] } = await db.query(
      `INSERT INTO simplefin_accounts (organization_id, connection_id, simplefin_account_id, institution_name, name, currency, balance, balance_date, sync_start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (connection_id, simplefin_account_id) DO UPDATE
         SET institution_name = EXCLUDED.institution_name, name = EXCLUDED.name, currency = EXCLUDED.currency,
             balance = COALESCE(EXCLUDED.balance, simplefin_accounts.balance), balance_date = COALESCE(EXCLUDED.balance_date, simplefin_accounts.balance_date)
       RETURNING id`,
      [orgId, connectionId, String(a.id), String(a.institution).slice(0, 200), String(a.name || 'Account').slice(0, 200), a.currency ? String(a.currency).slice(0, 100) : null,
        balance, balanceDate, start]);
    ids[a.id] = row.id;
  }
  return ids;
}

/** Claim a setup token, store the encrypted Access URL and list the accounts it can see (not yet mapped to the ledger). */
export async function connect(db, orgId, { setupToken, label }) {
  if (!isConfigured()) throw new HttpError(503, 'Bank connections need ENCRYPTION_KEY to be set on the server');
  const accessUrl = await claimSetupToken(setupToken);
  const { host } = accessParts(accessUrl);
  const { accounts, errors } = await getAccounts(accessUrl, { 'balances-only': 1 });
  const { rows: [conn] } = await db.query(
    `INSERT INTO simplefin_connections (organization_id, label, access_url_enc, server_host, error_message) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [orgId, String(label || '').trim().slice(0, 200) || null, encrypt(accessUrl), host, errors.join(' · ').slice(0, 1000) || null]);
  await upsertAccounts(db, orgId, conn.id, accounts);
  return { id: conn.id, accounts: accounts.length, errors };
}

export async function loadConnection(db, orgId, id) {
  const { rows } = await db.query('SELECT * FROM simplefin_connections WHERE id = $1 AND organization_id = $2', [id, orgId]);
  if (!rows.length) throw new HttpError(404, 'Bank connection not found');
  return rows[0];
}

export async function loadSfAccount(db, orgId, id) {
  const { rows } = await db.query('SELECT * FROM simplefin_accounts WHERE id = $1 AND organization_id = $2', [id, orgId]);
  if (!rows.length) throw new HttpError(404, 'Bank account not found');
  return rows[0];
}

/** Forget a connection and its stored Access URL. Imported lines stay in the bank feed. */
export async function removeConnection(db, orgId, id) {
  const conn = await loadConnection(db, orgId, id);
  await db.query('DELETE FROM simplefin_connections WHERE id = $1 AND organization_id = $2', [conn.id, orgId]);
}

// ---------------------------------------------------------------------------
// Transaction sync
// ---------------------------------------------------------------------------

/** Where an account's next sync starts: a few days before its last sync, never before its Import from date. */
function accountStart(a) {
  const from = a.sync_start_date || addDays(todayStr(), -30);
  if (!a.last_synced_at) return from;
  return maxDate(from, addDays(new Date(a.last_synced_at).toISOString().slice(0, 10), -OVERLAP_DAYS));
}

/**
 * Import new / changed posted transactions for every enabled account on a connection, and pick up accounts added at
 * SimpleFIN since the last sync. One request reads all of them (SimpleFIN servers limit how many requests a day they
 * answer). Pending transactions wait until they post.
 * SimpleFIN amounts are positive for money in, like bank feed amounts. Lines already matched are never changed.
 * `onlyAccountId` re-reads one account from its Import from date (after it's mapped or its date changes).
 */
export async function syncConnection(connectionId, { onlyAccountId = null } = {}) {
  const conn = await pool.connect();
  try {
    const { rows: [lock] } = await conn.query('SELECT pg_try_advisory_lock(727102, $1) AS ok', [connectionId]);
    if (!lock.ok) return { skipped: true };
    try {
      const { rows: [c] } = await conn.query('SELECT * FROM simplefin_connections WHERE id = $1', [connectionId]);
      if (!c) return { skipped: true };
      const { rows: accts } = await conn.query(
        `SELECT * FROM simplefin_accounts WHERE connection_id = $1 AND is_enabled AND account_id IS NOT NULL ${onlyAccountId ? 'AND id = $2' : ''}`,
        onlyAccountId ? [c.id, onlyAccountId] : [c.id]);
      const fromFor = (a) => (onlyAccountId ? a.sync_start_date || addDays(todayStr(), -30) : accountStart(a));
      let found = [];
      const errors = [];
      try {
        const accessUrl = decrypt(c.access_url_enc);
        if (!accts.length) {
          // Nothing to import: just refresh the list of accounts and balances.
          const r = await getAccounts(accessUrl, { 'balances-only': 1 });
          found = r.accounts;
          errors.push(...r.errors);
        } else {
          const start = accts.map(fromFor).sort()[0];
          const end = addDays(todayStr(), 1);
          const byId = new Map();
          for (let from = start; from < end; from = addDays(from, WINDOW_DAYS)) {
            const to = addDays(from, WINDOW_DAYS) < end ? addDays(from, WINDOW_DAYS) : end;
            // A full sync reads every account, so banks added at SimpleFIN later show up on Bank Feed Setup.
            // Re-reading one newly mapped account asks for just that one.
            const r = await getAccounts(accessUrl, { 'start-date': unix(from), 'end-date': unix(to), account: onlyAccountId ? accts.map((a) => a.simplefin_account_id) : undefined });
            errors.push(...r.errors);
            for (const a of r.accounts) {
              const prev = byId.get(a.id);
              byId.set(a.id, prev ? { ...a, transactions: [...(prev.transactions || []), ...(a.transactions || [])] } : a);
            }
          }
          found = [...byId.values()];
        }
      } catch (err) {
        const message = String(err.message || err).slice(0, 1000);
        await conn.query('UPDATE simplefin_connections SET error_message = $1 WHERE id = $2', [message, c.id]);
        return { error: { message } };
      }
      await conn.query('BEGIN');
      await applyUserContext(conn); // "Sync now" records the user; background syncs record none
      await upsertAccounts(conn, c.organization_id, c.id, found);
      let added = 0;
      let updated = 0;
      const changed = [];
      const seen = new Set(found.map((a) => String(a.id)));
      for (const a of accts) {
        const data = found.find((x) => String(x.id) === a.simplefin_account_id);
        if (!data) continue;
        const from = a.sync_start_date || null;
        for (const t of data.transactions || []) {
          if (!t?.id || t.pending || !Number(t.posted) || !Number.isFinite(Number(t.amount))) continue;
          const date = isoDate(t.posted);
          if (from && date < from) continue;
          const description = [t.description, t.payee && !String(t.description || '').includes(t.payee) ? t.payee : null].filter(Boolean).join(' · ') || t.memo || '';
          const { rows } = await conn.query(
            `INSERT INTO bank_feed_items (organization_id, account_id, date, description, amount, external_id, source, simplefin_account_id)
             VALUES ($1,$2,$3,$4,$5,$6,'simplefin',$7)
             ON CONFLICT (account_id, external_id) WHERE external_id IS NOT NULL
             DO UPDATE SET date = EXCLUDED.date, description = EXCLUDED.description, amount = EXCLUDED.amount
               WHERE bank_feed_items.status <> 'matched'
                 AND (bank_feed_items.date, bank_feed_items.description, bank_feed_items.amount) IS DISTINCT FROM (EXCLUDED.date, EXCLUDED.description, EXCLUDED.amount)
             RETURNING id, (xmax = 0) AS inserted`,
            [c.organization_id, a.account_id, date, String(description).slice(0, 500), fromCents(toCents(t.amount)), `simplefin:${a.simplefin_account_id}:${t.id}`, a.id]);
          if (rows[0]?.inserted) added += 1; else if (rows.length) updated += 1;
          if (rows.length) changed.push(rows[0].id);
        }
        await conn.query('UPDATE simplefin_accounts SET last_synced_at = now(), error_message = NULL WHERE id = $1', [a.id]);
      }
      for (const a of accts) {
        if (!seen.has(a.simplefin_account_id)) {
          await conn.query('UPDATE simplefin_accounts SET error_message = $1 WHERE id = $2', ['SimpleFIN didn’t return this account on the last sync.', a.id]);
        }
      }
      await applyRules(conn, c.organization_id, { itemIds: changed }); // new lines, or changed descriptions
      await conn.query('UPDATE simplefin_connections SET last_synced_at = now(), error_message = $1 WHERE id = $2', [[...new Set(errors)].join(' · ').slice(0, 1000) || null, c.id]);
      await conn.query('COMMIT');
      return { added, updated, errors: [...new Set(errors)] };
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await conn.query('SELECT pg_advisory_unlock(727102, $1)', [connectionId]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

/** Background sync of every connection with an enabled account (all organizations). */
export async function syncAllConnections() {
  const { rows } = await pool.query(
    'SELECT DISTINCT connection_id AS id FROM simplefin_accounts WHERE is_enabled AND account_id IS NOT NULL ORDER BY connection_id');
  for (const r of rows) {
    try { await syncConnection(r.id); } catch (err) { console.error(`SimpleFIN sync failed for connection ${r.id}:`, err.message); }
  }
}
