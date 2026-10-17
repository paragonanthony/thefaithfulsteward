import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin } from '../auth.js';
import { BANKING_TYPES } from '../accountTypes.js';
import { HttpError, ah, idOrNull, isDate, loadOwned } from '../util.js';
import { connect, isConfigured, loadConnection, loadSfAccount, removeConnection, syncConnection } from '../services/simplefin.js';

const r = Router();
r.use(requireAuth, requireOrg);

r.get('/status', ah(async (req, res) => {
  if (!isConfigured()) return res.json({ configured: false, connections: [] });
  const [conns, accts] = await Promise.all([
    query(`SELECT id, label, server_host, last_synced_at, error_message, created_at FROM simplefin_connections WHERE organization_id = $1 ORDER BY id`, [req.orgId]),
    query(`SELECT s.id, s.connection_id, s.institution_name, s.name, s.currency, s.balance, s.balance_date, s.account_id, s.is_enabled, s.sync_start_date,
                  s.last_synced_at, s.error_message, a.name AS ledger_account_name
             FROM simplefin_accounts s LEFT JOIN accounts a ON a.id = s.account_id
            WHERE s.organization_id = $1 ORDER BY s.institution_name, s.name, s.id`, [req.orgId]),
  ]);
  res.json({ configured: true, connections: conns.rows.map((c) => ({ ...c, accounts: accts.rows.filter((a) => a.connection_id === c.id) })) });
}));

/** Add a connection from a SimpleFIN setup token. The access URL it's exchanged for is stored encrypted. */
r.post('/connections', requireOrgAdmin, ah(async (req, res) => {
  const result = await withTransaction((db) => connect(db, req.orgId, { setupToken: req.body.setupToken, label: req.body.label }));
  res.status(201).json(result);
}));

r.put('/connections/:id', requireOrgAdmin, ah(async (req, res) => {
  const c = await loadConnection({ query }, req.orgId, Number(req.params.id));
  await query('UPDATE simplefin_connections SET label = $1 WHERE id = $2', [String(req.body.label || '').trim().slice(0, 200) || null, c.id]);
  res.json({ ok: true });
}));

/** Sync now (Bank Feed screen): every connection of the organization that has an imported account. */
r.post('/sync', ah(async (req, res) => {
  if (!isConfigured()) throw new HttpError(503, 'Live bank connections are not set up on this server');
  const { rows } = await query(
    `SELECT DISTINCT c.id, COALESCE(c.label, c.server_host) AS name FROM simplefin_connections c
       JOIN simplefin_accounts a ON a.connection_id = c.id AND a.is_enabled AND a.account_id IS NOT NULL
      WHERE c.organization_id = $1 ORDER BY c.id`, [req.orgId]);
  const total = { connections: rows.length, added: 0, updated: 0, skipped: 0, errors: [] };
  for (const c of rows) {
    const r2 = await syncConnection(c.id);
    if (r2.skipped) total.skipped += 1;
    else if (r2.error) total.errors.push(`${c.name}: ${r2.error.message}`);
    else {
      total.added += r2.added;
      total.updated += r2.updated;
      total.errors.push(...r2.errors.map((e) => (rows.length > 1 ? `${c.name}: ${e}` : e)));
    }
  }
  res.json(total);
}));

r.post('/connections/:id/sync', ah(async (req, res) => {
  const c = await loadConnection({ query }, req.orgId, Number(req.params.id));
  const result = await syncConnection(c.id);
  if (result.error) throw new HttpError(502, `Bank sync failed: ${result.error.message}`);
  res.json(result);
}));

r.delete('/connections/:id', requireOrgAdmin, ah(async (req, res) => {
  await removeConnection({ query }, req.orgId, Number(req.params.id));
  res.json({ ok: true });
}));

/** Map a bank account to a ledger account, enable / disable it, and set its start date. Reads its history from that date. */
r.put('/accounts/:id', requireOrgAdmin, ah(async (req, res) => {
  const sa = await loadSfAccount({ query }, req.orgId, Number(req.params.id));
  const accountId = idOrNull(req.body.accountId);
  const isEnabled = Boolean(req.body.isEnabled) && Boolean(accountId);
  if (accountId) {
    const accts = await loadOwned({ query }, 'accounts', [accountId], req.orgId, 'account');
    if (!BANKING_TYPES.includes(accts[accountId].account_type) || accts[accountId].is_undeposited_funds) {
      throw new HttpError(400, 'Choose a Bank or Credit Card account (not Undeposited Funds)');
    }
  }
  const start = req.body.syncStartDate || null;
  if (start && !isDate(start)) throw new HttpError(400, 'Invalid start date');
  try {
    await query('UPDATE simplefin_accounts SET account_id = $1, is_enabled = $2, sync_start_date = $3 WHERE id = $4', [accountId, isEnabled, start, sa.id]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'That ledger account is already fed by another bank connection');
    throw err;
  }
  res.json({ ok: true, sync: isEnabled ? await syncConnection(sa.connection_id, { onlyAccountId: sa.id }) : null });
}));

export default r;
