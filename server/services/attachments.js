import { HttpError, idOrNull } from '../util.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_RECORD = 25;

/** Transaction types that can carry attachments (tuition records use tuition_id instead). */
export const ATTACHABLE_TYPES = ['income', 'expense', 'bill', 'transfer', 'journal', 'reconciliation'];

// Accepted files by extension. `inline` files are shown in the browser; others always download.
// `claude` is how the file is sent for data extraction (null = Claude can't read it).
const TYPES = {
  pdf: { type: 'application/pdf', inline: true, claude: 'pdf' },
  jpg: { type: 'image/jpeg', inline: true, claude: 'image' },
  jpeg: { type: 'image/jpeg', inline: true, claude: 'image' },
  png: { type: 'image/png', inline: true, claude: 'image' },
  gif: { type: 'image/gif', inline: true, claude: 'image' },
  webp: { type: 'image/webp', inline: true, claude: 'image' },
  heic: { type: 'image/heic', inline: false, claude: null },
  heif: { type: 'image/heif', inline: false, claude: null },
  txt: { type: 'text/plain', inline: false, claude: 'text' },
  csv: { type: 'text/csv', inline: false, claude: 'text' },
  // Bank statement downloads (OFX; QFX and QBO are OFX for Quicken / QuickBooks), read without Claude.
  ofx: { type: 'application/x-ofx', inline: false, claude: null },
  qfx: { type: 'application/x-ofx', inline: false, claude: null },
  qbo: { type: 'application/x-ofx', inline: false, claude: null },
  doc: { type: 'application/msword', inline: false, claude: null },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false, claude: null },
  xls: { type: 'application/vnd.ms-excel', inline: false, claude: null },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false, claude: null },
};
export const ACCEPTED_EXTENSIONS = Object.keys(TYPES);

const ext = (name) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase();
export const typeInfo = (fileName) => TYPES[ext(fileName)] || null;

// Files shown inline must really be what their extension says (so e.g. an HTML file renamed .png can't run in the browser).
const MAGIC = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** Validate an upload ({ fileName, data: base64 }) and return the cleaned file. */
export function parseUpload(body) {
  const fileName = String(body.fileName ?? '').replace(/[\\/\0\r\n"]/g, '_').trim().slice(-200);
  if (!fileName) throw new HttpError(400, 'File name is required');
  const info = typeInfo(fileName);
  if (!info) throw new HttpError(400, `This type of file can't be attached. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`);
  const b64 = String(body.data ?? '').replace(/^data:[^,]*,/, '');
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new HttpError(400, 'File data is missing or invalid');
  const data = Buffer.from(b64, 'base64');
  if (!data.length) throw new HttpError(400, 'The file is empty');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  const check = MAGIC[info.type];
  if (check && !check(data)) throw new HttpError(400, `${fileName} doesn't look like a valid ${ext(fileName).toUpperCase()} file`);
  return { fileName, contentType: info.type, data };
}

/** Resolve and check the record an attachment belongs to. Returns { transactionId, tuitionId, txnType } (all null = pending). */
export async function resolveOwner(db, orgId, { transactionId, tuitionId }) {
  const txnId = idOrNull(transactionId);
  const tuitId = idOrNull(tuitionId);
  if (txnId && tuitId) throw new HttpError(400, 'An attachment belongs to a transaction or a tuition record, not both');
  if (txnId) {
    const { rows } = await db.query('SELECT transaction_type FROM transactions WHERE id = $1 AND organization_id = $2', [txnId, orgId]);
    if (!rows.length) throw new HttpError(404, 'Transaction not found');
    if (!ATTACHABLE_TYPES.includes(rows[0].transaction_type)) throw new HttpError(400, 'Files can be attached to income, expenses, bills, bank transfers, journal entries and reconciliations');
    return { transactionId: txnId, tuitionId: null, txnType: rows[0].transaction_type };
  }
  if (tuitId) {
    const { rows } = await db.query('SELECT 1 FROM tuition_records WHERE id = $1 AND organization_id = $2', [tuitId, orgId]);
    if (!rows.length) throw new HttpError(404, 'Tuition record not found');
    return { transactionId: null, tuitionId: tuitId, txnType: 'tuition' };
  }
  return { transactionId: null, tuitionId: null, txnType: null };
}

const META = `a.id, a.transaction_id, a.tuition_id, a.file_name, a.content_type, a.size_bytes, a.extracted_at,
               a.created_at, u.display_name AS created_by`;

export const attachmentMeta = (row) => ({ ...row, can_extract: Boolean(typeInfo(row.file_name)?.claude) });

export async function listAttachments(db, orgId, where, params) {
  const { rows } = await db.query(
    `SELECT ${META} FROM attachments a LEFT JOIN users u ON u.id = a.created_by_user_id
      WHERE a.organization_id = $1 AND ${where} ORDER BY a.created_at, a.id`, [orgId, ...params]);
  return rows.map(attachmentMeta);
}

export async function saveAttachment(db, ctx, body) {
  const file = parseUpload(body);
  const owner = await resolveOwner(db, ctx.orgId, body);
  // Forms that were never saved leave pending files behind; clear out old ones.
  await db.query(
    `DELETE FROM attachments WHERE organization_id = $1 AND transaction_id IS NULL AND tuition_id IS NULL AND created_at < now() - interval '1 day'`,
    [ctx.orgId]);
  if (owner.transactionId || owner.tuitionId) {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM attachments WHERE organization_id = $1 AND (transaction_id = $2 OR tuition_id = $3)',
      [ctx.orgId, owner.transactionId, owner.tuitionId]);
    if (rows[0].n >= MAX_ATTACHMENTS_PER_RECORD) throw new HttpError(400, `At most ${MAX_ATTACHMENTS_PER_RECORD} files can be attached to one record`);
  }
  const { rows } = await db.query(
    `INSERT INTO attachments (organization_id, transaction_id, tuition_id, file_name, content_type, size_bytes, data, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.orgId, owner.transactionId, owner.tuitionId, file.fileName, file.contentType, file.data.length, file.data, ctx.userId]);
  return (await listAttachments(db, ctx.orgId, 'a.id = $2', [rows[0].id]))[0];
}

/** Attach pending files (uploaded before the record was first saved) to the saved record. */
export async function linkAttachments(db, orgId, body) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(idOrNull).filter(Boolean);
  if (!ids.length) return 0;
  const owner = await resolveOwner(db, orgId, body);
  if (!owner.transactionId && !owner.tuitionId) throw new HttpError(400, 'Choose the transaction or tuition record to attach the files to');
  const { rowCount } = await db.query(
    `UPDATE attachments SET transaction_id = $1, tuition_id = $2
      WHERE organization_id = $3 AND id = ANY($4::int[]) AND transaction_id IS NULL AND tuition_id IS NULL`,
    [owner.transactionId, owner.tuitionId, orgId, ids]);
  return rowCount;
}

export async function loadAttachment(db, orgId, id, withData = false) {
  const { rows } = await db.query(
    `SELECT ${META}${withData ? ', a.data' : ''} FROM attachments a
       LEFT JOIN users u ON u.id = a.created_by_user_id WHERE a.id = $1 AND a.organization_id = $2`, [Number(id), orgId]);
  if (!rows.length) throw new HttpError(404, 'Attachment not found');
  return rows[0];
}

/** HTTP headers for downloading or viewing a stored file. */
export function fileHeaders(att, download) {
  const info = typeInfo(att.file_name);
  const inline = !download && info?.inline;
  const ascii = att.file_name.replace(/[^\x20-\x7e]/g, '_');
  return {
    'Content-Type': att.content_type,
    'Content-Length': String(att.size_bytes),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(att.file_name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  };
}
