import PDFDocument from 'pdfkit';
import { HttpError } from '../util.js';
import { applyMerge, formatMoney, formatReceiptDate, mergeValues, normalizeTemplate } from './receiptTemplates.js';

const IN = 72; // PDF points per inch
const PAGE_W = 8.5 * IN;
const PAGE_H = 11 * IN;
const M = { top: 0.75 * IN, left: 0.85 * IN, right: 0.85 * IN, bottom: 1 * IN };
const CONTENT_W = PAGE_W - M.left - M.right;
const SERIF = new Set(['Georgia', 'Times New Roman', 'Garamond']);
const GRAY = '#666666';

const addressLines = (x) => [x.address1, x.address2, [x.city, x.state, x.postal].filter(Boolean).join(', ')].filter(Boolean);

/** Load everything a receipt shows for one income transaction. */
export async function loadReceiptData(db, orgId, incomeId) {
  const { rows: [t] } = await db.query(
    `SELECT t.*, c.name AS company_name, c.email AS company_email, c.address1 AS c_address1, c.address2 AS c_address2,
            c.city AS c_city, c.state AS c_state, c.postal AS c_postal, f.name AS fund_name
       FROM transactions t LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN funds f ON f.id = t.fund_id
      WHERE t.id = $1 AND t.organization_id = $2 AND t.transaction_type = 'income'`,
    [incomeId, orgId],
  );
  if (!t) throw new HttpError(404, 'Income transaction not found');
  const { rows: lines } = await db.query(
    `SELECT d.amount, d.memo, a.account_number, a.name AS account_name, f.name AS fund_name
       FROM transaction_details d LEFT JOIN accounts a ON a.id = d.account_id LEFT JOIN funds f ON f.id = d.fund_id
      WHERE d.transaction_id = $1 ORDER BY d.sort_order, d.id`,
    [incomeId],
  );
  const { rows: [org] } = await db.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
  return {
    transactionId: t.id,
    companyId: t.company_id,
    donorEmail: t.company_email || '',
    receiptNumber: String(t.id),
    date: t.date,
    amount: Number(t.amount),
    donorName: t.company_name || '',
    donorAddress: addressLines({ address1: t.c_address1, address2: t.c_address2, city: t.c_city, state: t.c_state, postal: t.c_postal }),
    paymentMethod: t.transaction_method === 'check' ? `check${t.check_number ? ` ${t.check_number}` : ''}` : 'electronic',
    checkNumber: t.check_number || '',
    memo: t.memo || '',
    fundName: t.fund_name || '',
    lines: lines.map((l) => ({
      description: l.memo || t.memo || l.account_name || '',
      account: l.account_number ? `${l.account_number} · ${l.account_name}` : l.account_name || '',
      fund: l.fund_name || '',
      amount: Number(l.amount),
    })),
    org: { name: org.name, address: addressLines(org), phone: org.phone || '', email: org.email || '', ein: org.ein || '' },
  };
}

function imageBuffer(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

const paragraphs = (text) => String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** Render a receipt to a PDF Buffer, following the same template options as the printed receipt. */
export function renderReceiptPdf(rawTemplate, data) {
  const tpl = normalizeTemplate(rawTemplate);
  const serif = SERIF.has(tpl.fontFamily);
  const F = { regular: serif ? 'Times-Roman' : 'Helvetica', bold: serif ? 'Times-Bold' : 'Helvetica-Bold' };
  const size = tpl.fontSize;
  const accent = tpl.accentColor;
  const values = mergeValues(tpl, data);
  const date = formatReceiptDate(data.date, tpl.dateFormat);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: M,
    info: { Title: `${tpl.title} #${data.receiptNumber}`, Author: data.org.name, Subject: `Receipt for ${data.donorName}` },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const text = (str, x, y, opts = {}) => doc.text(str, x, y, { lineGap: size * 0.2, ...opts });
  const ensureSpace = (h) => { if (doc.y + h > PAGE_H - M.bottom) { doc.addPage(); doc.y = M.top; } };
  const writeParas = (str, opts = {}) => {
    for (const p of paragraphs(applyMerge(str, values))) {
      doc.font(F.regular).fontSize(opts.size || size).fillColor(opts.color || '#1a1a1a');
      ensureSpace(doc.heightOfString(p, { width: opts.width || CONTENT_W }));
      text(p, opts.x || M.left, doc.y, { width: opts.width || CONTENT_W });
      doc.moveDown(0.7);
    }
  };

  // ----- Header: logo + organization (left), title block (right) -----
  const top = M.top;
  let leftY = top;
  const logo = tpl.logo && imageBuffer(tpl.logo);
  if (logo) {
    try {
      const img = doc.openImage(logo);
      const w = Math.min(tpl.logoWidth * IN, CONTENT_W / 2);
      const h = Math.min(img.height * (w / img.width), 1.4 * IN);
      doc.image(img, M.left, leftY, { fit: [w, h] });
      leftY += h + 0.1 * IN;
    } catch { /* unreadable image: leave it out */ }
  }
  doc.font(F.bold).fontSize(size * 1.15 * 0.9).fillColor('#1a1a1a');
  text(data.org.name, M.left, leftY, { width: CONTENT_W / 2 });
  doc.font(F.regular).fontSize(size * 0.9);
  const orgLines = [
    ...(tpl.showOrgAddress ? data.org.address : []),
    ...(tpl.showOrgContact ? [[data.org.phone, data.org.email].filter(Boolean).join(' · ')].filter(Boolean) : []),
    ...(tpl.showEin && data.org.ein ? [`EIN ${data.org.ein}`] : []),
  ];
  for (const l of orgLines) text(l, M.left, doc.y, { width: CONTENT_W / 2 });
  leftY = doc.y;

  const rightX = M.left + CONTENT_W / 2;
  doc.font(F.bold).fontSize(size * 1.9).fillColor(accent);
  text(tpl.title, rightX, top, { width: CONTENT_W / 2, align: 'right' });
  doc.font(F.regular).fontSize(size).fillColor('#1a1a1a');
  text(date, rightX, doc.y, { width: CONTENT_W / 2, align: 'right' });
  if (tpl.showReceiptNumber) text(`Receipt #${data.receiptNumber}`, rightX, doc.y, { width: CONTENT_W / 2, align: 'right' });
  const rightY = doc.y;

  const donorLines = tpl.showDonorAddress ? data.donorAddress : [];
  let ruleY;
  if (tpl.windowEnvelope) {
    // Address sits where a #10 window envelope shows it (2.05" down, 0.9" in).
    doc.font(F.bold).fontSize(size).fillColor('#1a1a1a');
    text(data.donorName || '—', M.left + 0.05 * IN, top + 1.3 * IN, { width: 3.6 * IN });
    doc.font(F.regular);
    for (const l of donorLines) text(l, M.left + 0.05 * IN, doc.y, { width: 3.6 * IN });
    ruleY = Math.max(top + 2.75 * IN, doc.y + 0.1 * IN, leftY, rightY);
  } else {
    ruleY = Math.max(leftY, rightY) + 0.15 * IN;
  }
  doc.moveTo(M.left, ruleY).lineTo(M.left + CONTENT_W, ruleY).lineWidth(2.25).strokeColor(accent).stroke();
  doc.y = ruleY + (tpl.windowEnvelope ? 0.7 : 0.3) * IN;

  if (!tpl.windowEnvelope) {
    doc.font(F.regular).fontSize(size * 0.8).fillColor(GRAY);
    text('RECEIVED FROM', M.left, doc.y, { characterSpacing: 0.5 });
    doc.font(F.bold).fontSize(size).fillColor('#1a1a1a');
    text(data.donorName || '—', M.left, doc.y);
    doc.font(F.regular);
    for (const l of donorLines) text(l, M.left, doc.y);
    doc.moveDown(1.2);
  }

  writeParas(tpl.intro);

  // ----- Gift lines -----
  const amountW = 1.2 * IN;
  const cols = [{ key: 'description', label: 'DESCRIPTION' }];
  if (tpl.showAccount) cols.push({ key: 'account', label: 'ACCOUNT' });
  if (tpl.showFund) cols.push({ key: 'fund', label: 'FUND' });
  const textW = (CONTENT_W - amountW) / cols.length;
  const rule = (y, color, width) => doc.moveTo(M.left, y).lineTo(M.left + CONTENT_W, y).lineWidth(width).strokeColor(color).stroke();

  if (tpl.showLines) {
    ensureSpace(size * 4);
    let y = doc.y + 0.05 * IN;
    doc.font(F.regular).fontSize(size * 0.75).fillColor('#555555');
    cols.forEach((c, i) => text(c.label, M.left + 4 + i * textW, y, { width: textW - 8, characterSpacing: 0.4 }));
    text('AMOUNT', M.left + CONTENT_W - amountW, y, { width: amountW - 4, align: 'right', characterSpacing: 0.4 });
    y = doc.y + 3;
    rule(y, accent, 1.5);
    doc.font(F.regular).fontSize(size).fillColor('#1a1a1a');
    for (const l of data.lines) {
      const h = Math.max(...cols.map((c) => doc.heightOfString(l[c.key] || '', { width: textW - 8 }))) + 8;
      if (y + h > PAGE_H - M.bottom - size * 3) { doc.addPage(); y = M.top; }
      cols.forEach((c, i) => text(l[c.key] || '', M.left + 4 + i * textW, y + 4, { width: textW - 8 }));
      text(formatMoney(l.amount), M.left + CONTENT_W - amountW, y + 4, { width: amountW - 4, align: 'right' });
      y += h;
      rule(y, '#dddddd', 0.75);
    }
    rule(y, '#333333', 1.5);
    doc.font(F.bold);
    text('Total received', M.left + 4, y + 5, { width: CONTENT_W - amountW });
    text(formatMoney(data.amount), M.left + CONTENT_W - amountW, y + 5, { width: amountW - 4, align: 'right' });
    doc.y = y + size * 1.8;
  } else {
    ensureSpace(size * 3);
    const y = doc.y + 0.1 * IN;
    rule(y, accent, 1.5);
    doc.font(F.regular).fontSize(size * 1.1).fillColor('#1a1a1a');
    text('Total received', M.left + 4, y + 7, { width: CONTENT_W / 2 });
    doc.font(F.bold);
    text(formatMoney(data.amount), M.left + CONTENT_W / 2, y + 7, { width: CONTENT_W / 2 - 4, align: 'right' });
    rule(doc.y + 5, accent, 1.5);
    doc.y += 0.2 * IN;
  }
  if (tpl.showPaymentMethod) {
    doc.font(F.regular).fontSize(size * 0.9).fillColor('#555555');
    text(`Payment: ${data.paymentMethod}`, M.left, doc.y);
  }
  doc.moveDown(1.2);

  writeParas(tpl.closing);

  // ----- Tax acknowledgment (shaded box with accent bar) -----
  if (tpl.showTaxStatement && tpl.taxStatement.trim()) {
    const body = paragraphs(applyMerge(tpl.taxStatement, values)).join('\n\n');
    doc.font(F.regular).fontSize(size * 0.85);
    const w = CONTENT_W - 0.3 * IN;
    const h = doc.heightOfString(body, { width: w, lineGap: size * 0.2 }) + 0.12 * IN;
    ensureSpace(h + 0.2 * IN);
    const y = doc.y + 0.05 * IN;
    doc.rect(M.left, y, CONTENT_W, h).fill('#f7f7f5');
    doc.rect(M.left, y, 2.25, h).fill(accent);
    doc.fillColor('#333333');
    text(body, M.left + 0.15 * IN, y + 0.06 * IN, { width: w });
    doc.y = y + h + 0.2 * IN;
  }

  // ----- Signature -----
  if (tpl.showSignature) {
    ensureSpace(1.3 * IN);
    let y = doc.y + 0.15 * IN;
    const sig = tpl.signatureImage && imageBuffer(tpl.signatureImage);
    if (sig) {
      try { doc.image(sig, M.left, y, { fit: [2.8 * IN, 0.7 * IN] }); } catch { /* skip unreadable image */ }
      y += 0.72 * IN;
    } else {
      y += 0.55 * IN;
    }
    doc.moveTo(M.left, y).lineTo(M.left + 3 * IN, y).lineWidth(0.75).strokeColor('#333333').stroke();
    doc.font(F.regular).fontSize(size).fillColor('#1a1a1a');
    if (tpl.signatureName) text(tpl.signatureName, M.left, y + 3, { width: 3 * IN });
    if (tpl.signatureTitle) { doc.fillColor(GRAY).fontSize(size * 0.9); text(tpl.signatureTitle, M.left, doc.y, { width: 3 * IN }); }
  }

  // ----- Footer, pinned to the bottom of the last page -----
  if (tpl.footer.trim()) {
    const footer = paragraphs(applyMerge(tpl.footer, values)).join('\n');
    doc.font(F.regular).fontSize(size * 0.8).fillColor(GRAY);
    const h = doc.heightOfString(footer, { width: CONTENT_W, align: 'center' });
    const y = PAGE_H - 0.5 * IN - h;
    doc.moveTo(M.left, y - 6).lineTo(M.left + CONTENT_W, y - 6).lineWidth(0.75).strokeColor('#dddddd').stroke();
    // Write below the bottom margin without triggering an automatic page break.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    text(footer, M.left, y, { width: CONTENT_W, align: 'center' });
    doc.page.margins.bottom = saved;
  }

  doc.end();
  return done;
}
