import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireOrg } from '../auth.js';
import { HttpError, ah, idOrNull } from '../util.js';
import { DEFAULT_TEMPLATE, normalizeTemplate } from '../services/receiptTemplates.js';
import { loadReceiptData, renderReceiptPdf } from '../services/receiptPdf.js';

const r = Router();
r.use(requireAuth, requireOrg);

/** The requested template, else the organization's default, else the built-in standard receipt. */
async function chooseTemplate(orgId, templateId) {
  if (templateId) {
    const { rows } = await query('SELECT id, template FROM receipt_templates WHERE id = $1 AND organization_id = $2', [templateId, orgId]);
    if (!rows.length) throw new HttpError(404, 'Receipt template not found');
    return { id: rows[0].id, template: normalizeTemplate(rows[0].template) };
  }
  const { rows } = await query('SELECT id, template FROM receipt_templates WHERE organization_id = $1 ORDER BY is_default DESC, id LIMIT 1', [orgId]);
  return rows.length ? { id: rows[0].id, template: normalizeTemplate(rows[0].template) } : { id: null, template: normalizeTemplate(DEFAULT_TEMPLATE) };
}

const pdfName = (data) => `Receipt-${data.receiptNumber}.pdf`;

/** An income receipt as a PDF (shown in the browser, or downloaded with ?download=1). */
r.get('/:id/pdf', ah(async (req, res) => {
  const data = await loadReceiptData({ query }, req.orgId, Number(req.params.id));
  const tpl = await chooseTemplate(req.orgId, idOrNull(req.query.templateId));
  const pdf = await renderReceiptPdf(tpl.template, data);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${pdfName(data)}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(pdf);
}));

export default r;
