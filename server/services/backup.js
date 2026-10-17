// Organization backups: one Excel workbook with a sheet per kind of record, readable in any spreadsheet program, and
// a restore that writes it back into a new organization or over the current one.
//
// The backup follows the database rather than a fixed list: every table that belongs to an organization (has an
// organization_id, or hangs off one that does) is included, with every column, so new features are backed up
// without changes here. The restore matches sheets and columns by name and rebuilds the links between records from
// the database's foreign keys, so a backup keeps restoring as the app changes:
//   - a column the app has since added gets its default (or stays empty);
//   - a column or sheet the app no longer has is ignored (and reported);
//   - record ids are new, and every reference to one is pointed at its new id.
// When a future change can't be handled that way (a column renamed or a value's meaning changed), add an entry to
// UPGRADES below: it rewrites the sheets of backups made before that migration, before they are restored.
//
// Never in a backup: sign-in and connection secrets (bank connection access, the Claude key, API tokens), user
// accounts and passwords, and records kept for features that have been removed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import writeXlsxFile from 'write-excel-file/node';
import readXlsxFile from 'read-excel-file/node';
import { unzipSync, zipSync } from 'fflate';
import { HttpError } from '../util.js';

export const FORMAT_VERSION = 1;
const APP_NAME = 'The Faithful Steward';
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')).version;

/** Tables never backed up: secrets, sign-ins, memberships, figures the restore recalculates, and removed features. */
const SKIP_TABLES = new Set([
  'users', 'user_organizations', 'session', 'schema_migrations', 'oauth_clients', 'oauth_codes', 'oauth_tokens',
  'organization_claude_keys', 'simplefin_connections', 'simplefin_accounts',
  'reconciled_totals', // recalculated from the restored ledger
  'plaid_items', 'plaid_accounts', 'fc_accounts', 'qbo_connections', 'qbo_imports', 'qbo_links', 'org_email_settings', 'receipt_emails',
]);
/** Columns never backed up, in any table (encrypted values, hashes, tokens, secrets). */
const SECRET_COLUMN = /(_enc$|_hash$|token|secret|password)/i;
const SKIP_COLUMNS = { organizations: new Set(['stripe_customer_id']) };

/**
 * Ids kept inside a value rather than in a foreign-key column: column -> fn(value, map) giving the value with ids
 * pointed at the restored records. map(table, oldId) returns the new id (or null).
 */
const EMBEDDED_IDS = {
  import_batches: {
    created_company_ids: (v, map) => v.map((id) => map('companies', id)).filter(Boolean),
    created_account_ids: (v, map) => v.map((id) => map('accounts', id)).filter(Boolean),
  },
  report_definitions: {
    definition: (def, map) => {
      if (!def || typeof def !== 'object') return def;
      const ids = (list, table) => (Array.isArray(list) ? list.map((id) => map(table, Number(id))).filter(Boolean) : list);
      const out = { ...def };
      if (Array.isArray(def.rows)) {
        out.rows = def.rows.map((r) => (r?.filter ? { ...r, filter: { ...r.filter, accounts: ids(r.filter.accounts, 'accounts'), groups: ids(r.filter.groups, 'account_groups') } } : r));
      }
      if (def.columns) {
        out.columns = { ...def.columns, funds: ids(def.columns.funds, 'funds') };
        if (def.columns.budgetId) out.columns.budgetId = map('budgets', Number(def.columns.budgetId));
      }
      if (Array.isArray(def.fundFilter)) out.fundFilter = def.fundFilter.map((f) => (f === 'none' ? f : map('funds', Number(f)))).filter(Boolean);
      return out;
    },
  },
};

/**
 * Changes to backups made before a migration, applied in order before restoring: { before: '0NN_name.sql',
 * upgrade(tables) } where tables is { tableName: { rows: [{ column: value }] } }. None are needed yet.
 */
const UPGRADES = [];

const AUDIT_COLUMNS = new Set(['created_at', 'created_by_user_id', 'updated_at', 'updated_by_user_id']);
const MAX_SHEET_ROWS = 1_000_000; // Excel holds 1,048,576 rows per sheet; larger tables continue on more sheets
const q = (name) => `"${name.replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------------------------------------------------
// The database's structure
// ---------------------------------------------------------------------------------------------------------------

/** Tables, columns, keys and links, read from the database itself. */
async function loadSchema(db) {
  const { rows: cols } = await db.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable = 'YES' AS nullable, column_default IS NOT NULL AS has_default
       FROM information_schema.columns c
      WHERE table_schema = current_schema()
        AND EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE')
      ORDER BY table_name, ordinal_position`);
  const { rows: fks } = await db.query(
    `SELECT cl.relname AS table_name, a.attname AS column_name, fcl.relname AS ref_table, fa.attname AS ref_column, con.confdeltype AS on_delete
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_class fcl ON fcl.oid = con.confrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND cardinality(con.conkey) = 1 AND cl.relnamespace = current_schema()::regnamespace`);
  const { rows: pks } = await db.query(
    `SELECT cl.relname AS table_name, array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'p' AND cl.relnamespace = current_schema()::regnamespace GROUP BY cl.relname`);
  const tables = {};
  for (const c of cols) {
    const t = (tables[c.table_name] ||= { name: c.table_name, columns: [], byName: {}, fks: {}, pk: [] });
    const col = { name: c.column_name, type: c.data_type, udt: c.udt_name, nullable: c.nullable, hasDefault: c.has_default };
    t.columns.push(col);
    t.byName[col.name] = col;
  }
  for (const f of fks) if (tables[f.table_name]) tables[f.table_name].fks[f.column_name] = { table: f.ref_table, column: f.ref_column, onDelete: f.on_delete };
  for (const p of pks) if (tables[p.table_name]) tables[p.table_name].pk = p.columns;
  for (const t of Object.values(tables)) {
    // A plain numbered id: restored records get new numbers from the table's sequence.
    t.serialId = t.pk.length === 1 && t.pk[0] === 'id' && t.byName.id?.hasDefault && ['integer', 'bigint'].includes(t.byName.id.type);
  }
  return tables;
}

/**
 * The tables in a backup, in an order that can be restored (each after the tables it points to), each with the
 * SQL condition that picks one organization's rows ($1 = organization id).
 */
function backupTables(schema) {
  const set = new Map(); // name -> { table, scope }
  set.set('organizations', { table: schema.organizations, scope: 'id = $1' });
  for (const t of Object.values(schema)) {
    if (t.fks.organization_id?.table === 'organizations' && !SKIP_TABLES.has(t.name)) set.set(t.name, { table: t, scope: 'organization_id = $1' });
  }
  // Records that belong to another organization record (transaction lines, ledger lines, reconciliations, budget
  // lines...): reached through a required link, preferring the one they're deleted with.
  for (let added = true; added;) {
    added = false;
    for (const t of Object.values(schema)) {
      if (set.has(t.name) || SKIP_TABLES.has(t.name)) continue;
      const links = Object.entries(t.fks).filter(([c, f]) => set.has(f.table) && f.table !== 'organizations' && !t.byName[c].nullable);
      if (!links.length) continue;
      links.sort((a, b) => (b[1].onDelete === 'c') - (a[1].onDelete === 'c'));
      const [col, f] = links[0];
      const parent = set.get(f.table);
      set.set(t.name, { table: t, scope: `${q(col)} IN (SELECT ${q(f.column)} FROM ${q(f.table)} WHERE ${parent.scope})` });
      added = true;
    }
  }
  // Restore order: a table after everything it points to, where it can be (a link back to a table not yet restored,
  // or to its own table, is filled in afterwards).
  const order = [];
  const done = new Set();
  const remaining = new Set(set.keys());
  const deps = (name) => Object.entries(set.get(name).table.fks).filter(([, f]) => f.table !== name && set.has(f.table));
  while (remaining.size) {
    let next = [...remaining].find((n) => deps(n).every(([, f]) => done.has(f.table)));
    // A loop between tables: take one whose missing links can all be filled in later.
    if (!next) next = [...remaining].find((n) => deps(n).every(([c, f]) => done.has(f.table) || set.get(n).table.byName[c].nullable));
    if (!next) throw new Error(`Backup tables can't be ordered: ${[...remaining].join(', ')}`);
    order.push(set.get(next));
    done.add(next);
    remaining.delete(next);
  }
  return order;
}

/** The columns of a table that go in a backup. */
const backupColumns = (t) => t.columns.filter((c) => !SECRET_COLUMN.test(c.name) && !SKIP_COLUMNS[t.name]?.has(c.name));

const kindOf = (col) => {
  if (col.type === 'ARRAY') return 'array';
  if (['integer', 'bigint', 'smallint'].includes(col.type)) return 'int';
  if (['numeric', 'real', 'double precision'].includes(col.type)) return 'number';
  if (col.type === 'boolean') return 'bool';
  if (col.type === 'date') return 'date';
  if (col.type.startsWith('timestamp')) return 'timestamp';
  if (col.type === 'json' || col.type === 'jsonb') return 'json';
  if (col.type === 'bytea') return 'bytes';
  return 'text';
};

// ---------------------------------------------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------------------------------------------

const safeFile = (s) => String(s || '').replace(/[^\w.\- ]+/g, '_').trim().slice(0, 80) || 'file';

function toCell(v, col, filePath) {
  if (v === null || v === undefined) return null;
  switch (kindOf(col)) {
    case 'int': case 'number': return Number(v);
    case 'bool': return Boolean(v);
    case 'date': return { value: new Date(`${String(v).slice(0, 10)}T00:00:00Z`), format: 'yyyy-mm-dd' };
    case 'timestamp': return (v instanceof Date ? v : new Date(v)).toISOString();
    case 'json': case 'array': return JSON.stringify(v);
    case 'bytes': return filePath;
    default: return String(v);
  }
}

const header = (labels) => labels.map((l) => ({ value: l, fontWeight: 'bold' }));

/**
 * Build an organization's backup. Returns { fileName, contentType, data: Buffer }: an .xlsx workbook, or a .zip
 * holding the workbook and the attached files when withFiles is set.
 */
export async function createBackup(db, orgId, { withFiles = false, userName = null } = {}) {
  const schema = await loadSchema(db);
  const tables = backupTables(schema);
  const { rows: [org] } = await db.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  if (!org) throw new HttpError(404, 'Organization not found');
  const { rows: [{ name: schemaVersion }] } = await db.query('SELECT max(name) AS name FROM schema_migrations');
  const files = {};
  const sheets = [];
  const contents = [];
  const userIds = new Set();
  for (const { table: t, scope } of tables) {
    const cols = backupColumns(t);
    const order = t.pk.length ? t.pk.map(q).join(', ') : '1';
    const { rows } = await db.query(`SELECT ${cols.map((c) => q(c.name)).join(', ')} FROM ${q(t.name)} WHERE ${scope} ORDER BY ${order}`, [orgId]);
    const userCols = cols.filter((c) => t.fks[c.name]?.table === 'users');
    const data = rows.map((row) => cols.map((c) => {
      if (userCols.includes(c) && row[c.name] != null) userIds.add(row[c.name]);
      let filePath = null;
      if (kindOf(c) === 'bytes' && row[c.name] != null && withFiles) {
        const key = t.pk.map((k) => row[k]).join('-');
        filePath = `files/${t.name}/${key}-${c.name}${row.file_name ? `-${safeFile(row.file_name)}` : ''}`;
        files[filePath] = new Uint8Array(row[c.name]);
      }
      return toCell(row[c.name], c, filePath);
    }));
    const parts = Math.max(1, Math.ceil(data.length / MAX_SHEET_ROWS));
    for (let i = 0; i < parts; i++) {
      const sheet = (parts > 1 ? `${t.name} ${i + 1}` : t.name).slice(0, 31);
      sheets.push({ sheet, data: [header(cols.map((c) => c.name)), ...data.slice(i * MAX_SHEET_ROWS, (i + 1) * MAX_SHEET_ROWS)], stickyRowsCount: 1, columns: cols.map((c) => ({ width: Math.min(40, Math.max(10, c.name.length + 2)) })) });
      contents.push([sheet, t.name, Math.min(MAX_SHEET_ROWS, data.length - i * MAX_SHEET_ROWS)]);
    }
  }
  // Who created and changed the records, so a restore can credit them to the same people where they have accounts.
  const { rows: users } = await db.query(
    `SELECT u.id, u.username, u.display_name, u.email, uo.role FROM users u
       LEFT JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = $1
      WHERE uo.user_id IS NOT NULL OR u.id = ANY ($2::int[]) ORDER BY u.id`, [orgId, [...userIds]]);
  sheets.push({ sheet: 'users', data: [header(['id', 'username', 'display_name', 'email', 'role']), ...users.map((u) => [u.id, u.username, u.display_name, u.email, u.role])], stickyRowsCount: 1, columns: [{ width: 8 }, { width: 20 }, { width: 24 }, { width: 28 }, { width: 10 }] });
  contents.push(['users', 'users', users.length]);
  // A readable general ledger for use in other software (not used by a restore).
  const { rows: gl } = await db.query(
    `SELECT h.date, h.entry_kind, t.transaction_type, t.ref_number, t.check_number, c.name AS company, a.account_number, a.name AS account,
            f.name AS fund, COALESCE(td.memo, t.memo, h.description) AS memo, d.debit, d.credit
       FROM gl_headers h JOIN gl_details d ON d.gl_header_id = h.id JOIN accounts a ON a.id = d.account_id
       LEFT JOIN funds f ON f.id = d.fund_id LEFT JOIN transactions t ON t.id = h.transaction_id
       LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN transaction_details td ON td.id = d.transaction_detail_id
      WHERE h.organization_id = $1 ORDER BY h.date, h.id, d.id`, [orgId]);
  const money = (v) => (Number(v) ? { value: Number(v), format: '#,##0.00' } : null);
  sheets.unshift({
    sheet: 'General Ledger', stickyRowsCount: 1,
    columns: [12, 12, 12, 10, 10, 28, 10, 30, 18, 40, 12, 12].map((width) => ({ width })),
    data: [header(['Date', 'Entry', 'Type', 'Ref #', 'Check #', 'Name', 'Account #', 'Account', 'Fund', 'Memo', 'Debit', 'Credit']),
      ...gl.map((r) => [{ value: new Date(`${r.date}T00:00:00Z`), format: 'yyyy-mm-dd' }, r.entry_kind, r.transaction_type, r.ref_number, r.check_number, r.company,
        r.account_number, r.account, r.fund, r.memo, money(r.debit), money(r.credit)])],
  });
  contents.unshift(['General Ledger', '(report)', gl.length]);
  const created = new Date();
  const about = [
    [{ value: `${APP_NAME} backup`, fontWeight: 'bold', fontSize: 14 }],
    [],
    ['Organization', org.name],
    ['Created', created.toISOString()],
    ['Created by', userName || ''],
    ['Format version', FORMAT_VERSION],
    ['App version', APP_VERSION],
    ['Schema version', schemaVersion],
    ['Includes attachments', withFiles ? 'yes' : 'no'],
    [],
    ['This workbook is a complete copy of the organization’s records: the General Ledger sheet is a readable report, and each other sheet holds one kind of record with its database columns. Ids link the sheets together (for example, transactions.account_id is an id on the accounts sheet).'],
    ['To restore it, use Backup & Restore in the app. Sign-in details and connection secrets (bank connections, the Claude key) are not included and need to be set up again.'],
    [],
    header(['Sheet', 'Table', 'Rows']),
    ...contents,
  ];
  sheets.unshift({ sheet: 'About', data: about, columns: [{ width: 24 }, { width: 28 }, { width: 10 }] });
  const workbook = await writeXlsxFile(sheets).toBuffer();
  const base = `${safeFile(org.name)} backup ${created.toISOString().slice(0, 10)}`;
  if (!withFiles) return { fileName: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: workbook };
  const zip = zipSync({ [`${base}.xlsx`]: new Uint8Array(workbook), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 0 }]])) });
  return { fileName: `${base}.zip`, contentType: 'application/zip', data: Buffer.from(zip) };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a backup file
// ---------------------------------------------------------------------------------------------------------------

/**
 * Read a backup (.xlsx, or .zip with the workbook and files). Returns { about, tables: { name: { columns, rows } },
 * files, warnings }. Rows are objects keyed by column name, with values as the spreadsheet holds them.
 */
export async function readBackup(buffer) {
  let workbook = buffer;
  let files = {};
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    let entries;
    try { entries = unzipSync(new Uint8Array(buffer)); } catch { throw new HttpError(400, 'This file isn’t a backup (it couldn’t be opened)'); }
    if (!entries['xl/workbook.xml']) {
      const name = Object.keys(entries).find((n) => /\.xlsx$/i.test(n) && !n.includes('/'));
      if (!name) throw new HttpError(400, 'This zip file doesn’t contain a backup workbook');
      workbook = Buffer.from(entries[name]);
      files = Object.fromEntries(Object.entries(entries).filter(([n]) => n.startsWith('files/')));
    }
  }
  let sheets;
  try { sheets = await readXlsxFile(workbook); } catch { throw new HttpError(400, 'This file isn’t a backup (it couldn’t be read as an Excel workbook)'); }
  const aboutSheet = sheets.find((s) => s.sheet === 'About');
  if (!aboutSheet || !String(aboutSheet.data[0]?.[0] || '').includes('backup')) throw new HttpError(400, `This file isn’t a ${APP_NAME} backup (it has no About sheet)`);
  const about = {};
  let contents = null;
  for (const row of aboutSheet.data) {
    const key = String(row[0] ?? '').trim();
    if (contents) { if (key) contents.push({ sheet: key, table: String(row[1] ?? '').trim() }); continue; }
    if (key === 'Sheet' && String(row[1] ?? '').trim() === 'Table') { contents = []; continue; }
    if (key && row.length > 1) about[key] = row[1];
  }
  const version = Number(about['Format version']);
  if (!(version >= 1)) throw new HttpError(400, 'This backup has no format version, so it can’t be restored');
  if (version > FORMAT_VERSION) throw new HttpError(400, `This backup was made by a newer version of ${APP_NAME} (format ${version}); update the app to restore it`);
  const sheetTable = new Map((contents || []).map((c) => [c.sheet, c.table]));
  const tables = {};
  for (const s of sheets) {
    if (s.sheet === 'About') continue;
    const table = sheetTable.get(s.sheet) ?? s.sheet;
    if (!table || table.startsWith('(')) continue; // readable reports
    const [head = [], ...body] = s.data;
    const columns = head.map((h) => String(h ?? '').trim());
    const t = (tables[table] ||= { columns, rows: [], sheet: s.sheet });
    for (let i = 0; i < body.length; i++) {
      const r = body[i];
      if (!r.some((v) => v !== null && v !== '')) continue;
      const obj = { __row: i + 2, __sheet: s.sheet };
      columns.forEach((c, j) => { if (c) obj[c] = r[j] ?? null; });
      t.rows.push(obj);
    }
  }
  return { about, tables, files, version };
}

/** A summary of a backup file for the confirmation before restoring. */
export async function inspectBackup(db, buffer) {
  const b = await readBackup(buffer);
  const counts = Object.fromEntries(Object.entries(b.tables).map(([k, v]) => [k, v.rows.length]));
  return {
    organization: b.about.Organization || '',
    created: b.about.Created || null,
    createdBy: b.about['Created by'] || null,
    appVersion: b.about['App version'] ?? null,
    includesAttachments: Object.keys(b.files).length > 0,
    counts: {
      transactions: counts.transactions || 0, accounts: counts.accounts || 0, companies: counts.companies || 0,
      funds: counts.funds || 0, attachments: counts.attachments || 0, ledgerLines: counts.gl_details || 0,
    },
    warnings: planWarnings(await loadSchema(db), b),
  };
}

/** What in the file this version of the app doesn't have (it's left out of a restore). */
function planWarnings(schema, b) {
  const tables = new Set(backupTables(schema).map((x) => x.table.name));
  const warnings = [];
  for (const [name, t] of Object.entries(b.tables)) {
    if (name === 'users') continue;
    if (!tables.has(name)) { if (t.rows.length) warnings.push(`The “${t.sheet}” sheet isn’t used by this version of the app and will be skipped.`); continue; }
    const known = new Set(backupColumns(schema[name]).map((c) => c.name));
    const extra = t.columns.filter((c) => c && !known.has(c));
    if (extra.length) warnings.push(`On the “${t.sheet}” sheet, ${extra.join(', ')} ${extra.length === 1 ? 'isn’t' : 'aren’t'} used by this version of the app and will be skipped.`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------------------------

function fromCell(v, col, where) {
  if (v === null || v === undefined || v === '') return null;
  const bad = (what) => new HttpError(400, `${where}: “${v}” isn’t ${what} (column ${col.name})`);
  switch (kindOf(col)) {
    case 'int': { const n = Number(v); if (!Number.isInteger(n)) throw bad('a whole number'); return n; }
    case 'number': { const n = Number(typeof v === 'string' ? v.replace(/[,$\s]/g, '') : v); if (!Number.isFinite(n)) throw bad('a number'); return n; }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(s)) return true;
      if (['false', 'no', 'n', '0'].includes(s)) return false;
      throw bad('true or false');
    }
    case 'date': {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw bad('a date (YYYY-MM-DD)');
      return s.slice(0, 10);
    }
    case 'timestamp': {
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) throw bad('a date and time');
      return d.toISOString();
    }
    case 'json': {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { throw bad('valid JSON'); }
    }
    case 'array': {
      let a;
      try { a = typeof v === 'string' ? JSON.parse(v) : v; } catch { throw bad('a list'); }
      if (!Array.isArray(a)) throw bad('a list');
      return a;
    }
    default: return v instanceof Date ? v.toISOString() : String(v);
  }
}

/** Delete an organization's records (those a backup holds), keeping the organization, its users and connections. */
async function clearOrganization(db, orgId, tables) {
  await db.query(`SELECT set_config('app.deleting_organization', $1, true)`, [String(orgId)]);
  for (const { table: t, scope } of [...tables].reverse()) {
    if (t.name === 'organizations') continue;
    for (const [col, f] of Object.entries(t.fks)) {
      if (f.table === t.name && t.byName[col].nullable) await db.query(`UPDATE ${q(t.name)} SET ${q(col)} = NULL WHERE ${scope} AND ${q(col)} IS NOT NULL`, [orgId]);
    }
    await db.query(`DELETE FROM ${q(t.name)} WHERE ${scope}`, [orgId]);
  }
  await db.query(`SELECT set_config('app.deleting_organization', '', true)`);
}

/**
 * Restore a backup. mode 'new' creates an organization (named `name`, or after the one backed up) and makes userId
 * its administrator; mode 'replace' replaces everything in organization orgId with the backup, keeping its name,
 * users, bank connections and Claude key. Runs inside the caller's transaction (db). Returns { organizationId,
 * name, counts, warnings }.
 */
export async function restoreBackup(db, buffer, { mode, orgId = null, name = null, userId }) {
  const b = await readBackup(buffer);
  const fileSchema = String(b.about['Schema version'] || '');
  for (const u of UPGRADES) if (fileSchema < u.before) u.upgrade(b.tables);
  const schema = await loadSchema(db);
  const tables = backupTables(schema);
  const warnings = planWarnings(schema, b);
  const counts = {};

  // Users: credit records to the same people by username where they have an account here.
  const userMap = new Map();
  const fileUsers = b.tables.users?.rows || [];
  if (fileUsers.length) {
    const { rows } = await db.query('SELECT id, lower(username) AS u FROM users WHERE lower(username) = ANY ($1::text[])', [fileUsers.map((u) => String(u.username || '').toLowerCase())]);
    const byName = new Map(rows.map((r) => [r.u, r.id]));
    for (const u of fileUsers) { const id = byName.get(String(u.username || '').toLowerCase()); if (id && u.id != null) userMap.set(Number(u.id), id); }
  }

  // The organization itself
  const orgRow = b.tables.organizations?.rows?.[0];
  if (!orgRow) throw new HttpError(400, 'This backup has no organization record');
  const orgCols = backupColumns(schema.organizations).filter((c) => c.name !== 'id' && c.name !== 'name' && !AUDIT_COLUMNS.has(c.name) && b.tables.organizations.columns.includes(c.name));
  const orgVals = orgCols.map((c) => fromCell(orgRow[c.name], c, 'organizations sheet'));
  let targetOrg = orgId;
  let restoredName;
  if (mode === 'new') {
    restoredName = String(name || orgRow.name || 'Restored organization').trim();
    const { rows: [o] } = await db.query(
      `INSERT INTO organizations (name${orgCols.map((c) => `, ${q(c.name)}`).join('')}) VALUES ($1${orgCols.map((c, i) => `, $${i + 2}`).join('')}) RETURNING id`,
      [restoredName, ...orgVals]);
    targetOrg = o.id;
    await db.query(`INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1,$2,'admin')`, [userId, targetOrg]);
    await db.query(`SELECT set_config('app.restoring_organization', $1, true)`, [String(targetOrg)]);
  } else {
    // Bank connections and other records kept with the organization point at its accounts: note which account each
    // used (by number or name) so it can be pointed at the restored account.
    const keptLinks = [];
    for (const t of Object.values(schema)) {
      if (!SKIP_TABLES.has(t.name) || !t.byName.organization_id || !t.serialId) continue;
      for (const [col, f] of Object.entries(t.fks)) {
        if (f.table !== 'accounts') continue;
        const { rows } = await db.query(
          `SELECT x.id, a.account_number, a.name FROM ${q(t.name)} x JOIN accounts a ON a.id = x.${q(col)} WHERE x.organization_id = $1`, [targetOrg]);
        for (const r of rows) keptLinks.push({ table: t.name, col, ...r });
      }
    }
    const { rows: [cur] } = await db.query('SELECT name FROM organizations WHERE id = $1 FOR UPDATE', [targetOrg]);
    if (!cur) throw new HttpError(404, 'Organization not found');
    restoredName = cur.name;
    await clearOrganization(db, targetOrg, tables);
    await db.query(`SELECT set_config('app.restoring_organization', $1, true)`, [String(targetOrg)]);
    if (orgCols.length) await db.query(`UPDATE organizations SET ${orgCols.map((c, i) => `${q(c.name)} = $${i + 2}`).join(', ')} WHERE id = $1`, [targetOrg, ...orgVals]);
    b.keptLinks = keptLinks;
  }

  // New ids, by table: old id -> new id
  const idMap = new Map(tables.map((x) => [x.table.name, new Map()]));
  idMap.set('organizations', new Map([[Number(orgRow.id), targetOrg]]));
  const mapId = (table, old) => (old == null ? null : idMap.get(table)?.get(Number(old)) ?? null);
  // Records outside the backup that a restored record may point to (the organization's own, in a replace).
  const outsideIds = new Map();
  const outside = async (table) => {
    if (!outsideIds.has(table)) {
      const t = schema[table];
      const ids = t?.byName.organization_id && t.serialId && mode === 'replace'
        ? (await db.query(`SELECT id FROM ${q(table)} WHERE organization_id = $1`, [targetOrg])).rows.map((r) => r.id) : [];
      outsideIds.set(table, new Set(ids));
    }
    return outsideIds.get(table);
  };

  const later = []; // links filled in once their records exist: { table, col, ref, rows: [[newKey, oldRef]] }
  const embedded = []; // { table, col, fn, rows: [[newId, value]] }
  const restored = new Set(['organizations']);
  for (const { table: t } of tables) {
    if (t.name === 'organizations') continue;
    const sheet = b.tables[t.name];
    restored.add(t.name);
    if (!sheet?.rows.length) continue;
    const cols = backupColumns(t).filter((c) => sheet.columns.includes(c.name));
    const skipped = { missingLink: 0, missingFile: 0 };
    const deferred = cols.filter((c) => t.fks[c.name] && (t.fks[c.name].table === t.name || (idMap.has(t.fks[c.name].table) && !restored.has(t.fks[c.name].table))));
    const deferRows = new Map(deferred.map((c) => [c.name, []]));
    const embeddedCols = Object.entries(EMBEDDED_IDS[t.name] || {}).filter(([c]) => cols.some((x) => x.name === c));
    const embRows = new Map(embeddedCols.map(([c]) => [c, []]));
    const insertCols = t.serialId ? ['id', ...cols.filter((c) => c.name !== 'id').map((c) => c.name)] : cols.map((c) => c.name);
    if (t.byName.organization_id && !insertCols.includes('organization_id')) insertCols.push('organization_id');
    const values = [];
    let newIds = [];
    if (t.serialId) {
      const { rows } = await db.query(`SELECT nextval(pg_get_serial_sequence($1, 'id'))::int AS id FROM generate_series(1, $2)`, [t.name, sheet.rows.length]);
      newIds = rows.map((r) => r.id);
    }
    let n = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      const where = `${row.__sheet} sheet, row ${row.__row}`;
      const rec = {};
      let skip = false;
      for (const c of cols) {
        if (c.name === 'id' && t.serialId) continue;
        let v = fromCell(row[c.name], c, where);
        const f = t.fks[c.name];
        if (kindOf(c) === 'bytes') {
          v = v == null ? null : b.files[String(v)] ? Buffer.from(b.files[String(v)]) : null;
          if (v == null && !c.nullable) { skip = true; skipped.missingFile += 1; break; }
        } else if (f && v != null) {
          if (f.table === 'organizations') v = targetOrg;
          else if (f.table === 'users') v = userMap.get(Number(v)) ?? (c.nullable ? null : userId);
          else if (deferRows.has(c.name)) { deferRows.get(c.name).push([i, v]); v = null; }
          else if (idMap.has(f.table)) {
            const m = mapId(f.table, v);
            if (m == null && !c.nullable) { skip = true; skipped.missingLink += 1; break; }
            v = m;
          } else {
            v = (await outside(f.table)).has(Number(v)) ? Number(v) : null;
            if (v == null && !c.nullable) { skip = true; skipped.missingLink += 1; break; }
          }
        }
        if (embRows.has(c.name) && v != null) embRows.get(c.name).push([i, v]);
        rec[c.name] = v;
      }
      if (skip) {
        for (const list of [...deferRows.values(), ...embRows.values()]) if (list.at(-1)?.[0] === i) list.pop();
        continue;
      }
      if (t.serialId) {
        rec.id = newIds[i];
        if (row.id != null) idMap.get(t.name).set(Number(row.id), rec.id);
      }
      if (t.byName.organization_id) rec.organization_id = targetOrg;
      for (const c of cols) if (kindOf(c) === 'json' && rec[c.name] != null) rec[c.name] = JSON.stringify(rec[c.name]);
      // A blank required cell gets the column's default (undefined = DEFAULT).
      values.push(insertCols.map((c) => (rec[c] == null && !t.byName[c].nullable && t.byName[c].hasDefault ? undefined : rec[c] ?? null)));
      n += 1;
    }
    // Columns missing from the sheet aren't inserted, so they get the database default.
    for (let start = 0; start < values.length;) {
      const per = Math.max(1, Math.floor(30000 / insertCols.length));
      const chunk = values.slice(start, start + per);
      const params = [];
      const tuples = chunk.map((vals) => `(${vals.map((v) => { if (v === undefined) return 'DEFAULT'; params.push(v); return `$${params.length}`; }).join(',')})`);
      await db.query(`INSERT INTO ${q(t.name)} (${insertCols.map(q).join(',')}) VALUES ${tuples.join(',')}`, params);
      start += per;
    }
    counts[t.name] = n;
    if (skipped.missingLink) warnings.push(`${skipped.missingLink} row(s) on the “${sheet.sheet}” sheet point to records that aren’t in the backup and were skipped.`);
    if (skipped.missingFile) warnings.push(`${skipped.missingFile} row(s) on the “${sheet.sheet}” sheet need files that aren’t in the backup (restore from the .zip backup that includes attachments) and were skipped.`);
    // Fill in after all tables: keyed by this table's new id (only numbered tables can have these links).
    if (t.serialId) {
      for (const c of deferred) later.push({ table: t.name, col: c.name, ref: t.fks[c.name].table, rows: deferRows.get(c.name).map(([i, v]) => [newIds[i], v]) });
      for (const [c, fn] of embeddedCols) embedded.push({ table: t.name, col: c, fn, kind: kindOf(t.byName[c]), rows: embRows.get(c).map(([i, v]) => [newIds[i], v]) });
    }
  }

  for (const l of later) {
    const pairs = l.rows.map(([id, old]) => [id, mapId(l.ref, old)]).filter(([, v]) => v != null);
    if (pairs.length) {
      await db.query(`UPDATE ${q(l.table)} x SET ${q(l.col)} = u.v FROM unnest($1::int[], $2::int[]) AS u(id, v) WHERE x.id = u.id`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])]);
    }
  }
  for (const e of embedded) {
    for (const [id, v] of e.rows) {
      const nv = e.fn(v, mapId);
      await db.query(`UPDATE ${q(e.table)} SET ${q(e.col)} = $1 WHERE id = $2`, [e.kind === 'json' ? JSON.stringify(nv) : nv, id]);
    }
  }
  for (const k of b.keptLinks || []) {
    const { rows: [a] } = await db.query(
      `SELECT id FROM accounts WHERE organization_id = $1 AND (CASE WHEN $2::text IS NOT NULL THEN account_number = $2 ELSE account_number IS NULL AND name = $3 END) LIMIT 1`,
      [targetOrg, k.account_number, k.name]);
    if (a) await db.query(`UPDATE ${q(k.table)} SET ${q(k.col)} = $1 WHERE id = $2`, [a.id, k.id]);
  }

  // Checks before committing: every ledger entry balances, and completed reconciliations lock their totals again.
  const { rows: unbalanced } = await db.query(
    `SELECT h.id, h.date FROM gl_headers h LEFT JOIN gl_details d ON d.gl_header_id = h.id WHERE h.organization_id = $1
      GROUP BY h.id HAVING COALESCE(SUM(d.debit), 0) <> COALESCE(SUM(d.credit), 0) LIMIT 5`, [targetOrg]);
  if (unbalanced.length) {
    throw new HttpError(400, `The backup’s general ledger doesn’t balance (entries dated ${unbalanced.map((u) => u.date).join(', ')}), so nothing was restored`);
  }
  await db.query(
    `SELECT snapshot_reconciled_totals(r.transaction_id) FROM reconciliations r JOIN transactions t ON t.id = r.transaction_id
      WHERE t.organization_id = $1 AND r.is_complete`, [targetOrg]);
  return { organizationId: targetOrg, name: restoredName, counts, warnings };
}
