import { Router } from 'express';
import { hasEncryptionKey } from '../crypto.js';
import { query, withTransaction } from '../db.js';
import { requireAuth, requireOrg, requireOrgAdmin } from '../auth.js';
import { HttpError, ah, idOrNull } from '../util.js';
import {
  ACCEPTED_EXTENSIONS, MAX_ATTACHMENT_BYTES, fileHeaders, linkAttachments, listAttachments, loadAttachment, resolveOwner, saveAttachment,
} from '../services/attachments.js';
import {
  DEFAULT_PROMPTS, PROMPT_TYPES, TYPE_LABELS, extractFromAttachment, extractionConfigured, extractionModel, removeOrgKey, saveOrgKey,
} from '../services/extraction.js';

const r = Router();
r.use(requireAuth, requireOrg);

const ctx = (req) => ({ orgId: req.orgId, userId: req.user.id });

/** Upload limits and whether Claude extraction is available, for the attachment panel. */
r.get('/config', ah(async (req, res) => {
  res.json({ maxBytes: MAX_ATTACHMENT_BYTES, extensions: ACCEPTED_EXTENSIONS, extractionEnabled: await extractionConfigured({ query }, req.orgId) });
}));

// ----- The organization's Claude API key (Organization Settings). The key itself is never returned. -----
r.get('/claude-key', ah(async (req, res) => {
  const { rows: [k] } = await query(
    `SELECT k.key_hint, k.updated_at, u.display_name AS updated_by FROM organization_claude_keys k
       LEFT JOIN users u ON u.id = k.updated_by_user_id WHERE k.organization_id = $1`, [req.orgId]);
  res.json({
    configured: await extractionConfigured({ query }, req.orgId), saved: Boolean(k), hint: k?.key_hint || null,
    updated_at: k?.updated_at || null, updated_by: k?.updated_by || null, encryptionAvailable: hasEncryptionKey(), model: extractionModel(),
  });
}));
r.put('/claude-key', requireOrgAdmin, ah(async (req, res) => {
  const hint = await saveOrgKey({ query }, req.orgId, req.body.apiKey);
  res.json({ ok: true, hint });
}));
r.delete('/claude-key', requireOrgAdmin, ah(async (req, res) => {
  await removeOrgKey({ query }, req.orgId);
  res.json({ ok: true });
}));

// ----- Saved extraction prompts (one per transaction type) -----
r.get('/prompts', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT p.txn_type, p.prompt, p.updated_at, u.display_name AS updated_by FROM extraction_prompts p
       LEFT JOIN users u ON u.id = p.updated_by_user_id WHERE p.organization_id = $1`, [req.orgId]);
  const saved = Object.fromEntries(rows.map((p) => [p.txn_type, p]));
  res.json({
    extractionEnabled: await extractionConfigured({ query }, req.orgId),
    model: extractionModel(),
    prompts: PROMPT_TYPES.map((type) => ({
      type, label: TYPE_LABELS[type], prompt: saved[type]?.prompt ?? DEFAULT_PROMPTS[type], defaultPrompt: DEFAULT_PROMPTS[type],
      isDefault: !saved[type], updated_at: saved[type]?.updated_at ?? null, updated_by: saved[type]?.updated_by ?? null,
    })),
  });
}));

const promptType = (req) => {
  if (!PROMPT_TYPES.includes(req.params.type)) throw new HttpError(404, 'Unknown transaction type');
  return req.params.type;
};
r.put('/prompts/:type', requireOrgAdmin, ah(async (req, res) => {
  const type = promptType(req);
  const prompt = String(req.body.prompt ?? '').trim();
  if (!prompt) throw new HttpError(400, 'The prompt can’t be empty (use Reset to go back to the standard prompt)');
  if (prompt.length > 8000) throw new HttpError(400, 'The prompt can be at most 8,000 characters');
  await query(
    `INSERT INTO extraction_prompts (organization_id, txn_type, prompt) VALUES ($1,$2,$3)
     ON CONFLICT (organization_id, txn_type) DO UPDATE SET prompt = EXCLUDED.prompt`, [req.orgId, type, prompt]);
  res.json({ ok: true });
}));
r.delete('/prompts/:type', requireOrgAdmin, ah(async (req, res) => {
  await query('DELETE FROM extraction_prompts WHERE organization_id = $1 AND txn_type = $2', [req.orgId, promptType(req)]);
  res.json({ ok: true });
}));

// ----- Attachments -----
/** Files on a transaction (?transactionId=), a tuition record (?tuitionId=), or pending uploads (?ids=1,2). */
r.get('/', ah(async (req, res) => {
  if (req.query.ids !== undefined) {
    const ids = String(req.query.ids).split(',').map(idOrNull).filter(Boolean);
    return res.json(ids.length ? await listAttachments({ query }, req.orgId, 'a.id = ANY($2::int[]) AND a.transaction_id IS NULL AND a.tuition_id IS NULL', [ids]) : []);
  }
  const owner = await resolveOwner({ query }, req.orgId, req.query);
  if (owner.transactionId) return res.json(await listAttachments({ query }, req.orgId, 'a.transaction_id = $2', [owner.transactionId]));
  if (owner.tuitionId) return res.json(await listAttachments({ query }, req.orgId, 'a.tuition_id = $2', [owner.tuitionId]));
  throw new HttpError(400, 'Choose a transaction or tuition record');
}));

/** Upload: { fileName, data (base64), transactionId? | tuitionId? }. Without an owner the file is pending until linked. */
r.post('/', ah(async (req, res) => {
  res.status(201).json(await withTransaction((db) => saveAttachment(db, ctx(req), req.body)));
}));

r.post('/link', ah(async (req, res) => {
  const linked = await withTransaction((db) => linkAttachments(db, req.orgId, req.body));
  res.json({ linked });
}));

r.get('/:id/file', ah(async (req, res) => {
  const att = await loadAttachment({ query }, req.orgId, req.params.id, true);
  res.set(fileHeaders(att, req.query.download === '1')).send(att.data);
}));

r.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', [Number(req.params.id), req.orgId]);
  if (!rowCount) throw new HttpError(404, 'Attachment not found');
  res.json({ ok: true });
}));

/** Read the document with Claude using the saved prompt for { type }; returns suggested field values (nothing is saved to the transaction). */
r.post('/:id/extract', ah(async (req, res) => {
  const att = await loadAttachment({ query }, req.orgId, req.params.id, true);
  const type = String(req.body.type || '');
  const result = await extractFromAttachment({ query }, req.orgId, att, type);
  await query('UPDATE attachments SET extracted_at = now(), extraction = $1 WHERE id = $2', [JSON.stringify({ type, ...result }), att.id]);
  res.json(result);
}));

export default r;
