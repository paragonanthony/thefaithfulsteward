// Income / donation receipt templates. Text fields may contain merge fields such as {{donor_name}}.

export const MERGE_FIELDS = {
  donor_name: 'Donor / customer name',
  amount: 'Amount received',
  date: 'Date received',
  receipt_number: 'Receipt number',
  payment_method: 'Payment method (e.g. "check 1042")',
  check_number: 'Check number',
  memo: 'Transaction memo',
  fund: 'Fund',
  org_name: 'Organization name',
  ein: 'Organization EIN',
};

export const FONTS = ['Georgia', 'Times New Roman', 'Arial', 'Helvetica', 'Verdana', 'Garamond'];
export const DATE_FORMATS = ['Month D, YYYY', 'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
// PNG/JPEG only: these are the formats PDF receipts can embed (the editor converts uploads to them).
const IMAGE_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_CHARS = 700 * 1024; // ~500 KB image

export const DEFAULT_TEMPLATE = {
  title: 'Donation Receipt',
  accentColor: '#0e2a46', // The Faithful Steward navy
  fontFamily: 'Georgia',
  fontSize: 11,
  dateFormat: 'Month D, YYYY',
  logo: null,                 // data URL
  logoWidth: 1.6,             // inches
  showOrgAddress: true,
  showOrgContact: true,
  showEin: true,
  showReceiptNumber: true,
  showDonorAddress: true,
  windowEnvelope: false,      // place the donor address for a #10 window envelope
  showLines: true,
  showAccount: false,
  showFund: true,
  showPaymentMethod: true,
  intro: 'Dear {{donor_name}},\n\nThank you for your generous gift of {{amount}}, received on {{date}}.',
  closing: 'Your support makes our work possible. We are grateful for your partnership.',
  showTaxStatement: true,
  taxStatement: 'No goods or services were provided in exchange for this contribution. Please keep this receipt for your tax records.',
  showSignature: false,
  signatureName: '',
  signatureTitle: '',
  signatureImage: null,       // data URL
  footer: '',
  emailSubject: 'Your receipt from {{org_name}}',
  emailBody: 'Dear {{donor_name}},\n\nThank you for your gift of {{amount}}, received on {{date}}. Your receipt is attached.\n\nWith gratitude,\n{{org_name}}',
};

const text = (v, dflt, max) => (v === undefined || v === null ? dflt : String(v).slice(0, max));
const bool = (v, dflt) => (v === undefined ? dflt : Boolean(v));
const num = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 100) / 100 : dflt;
};
const image = (v) => (typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMAGE_DATA_URL.test(v) ? v : null);

/** Fill in defaults and validate every value. Images must be small PNG/JPEG/GIF/WebP data URLs. */
export function normalizeTemplate(input = {}) {
  const d = DEFAULT_TEMPLATE;
  return {
    title: text(input.title, d.title, 100),
    accentColor: /^#[0-9a-fA-F]{6}$/.test(input.accentColor || '') ? input.accentColor : d.accentColor,
    fontFamily: FONTS.includes(input.fontFamily) ? input.fontFamily : d.fontFamily,
    fontSize: num(input.fontSize, 8, 16, d.fontSize),
    dateFormat: DATE_FORMATS.includes(input.dateFormat) ? input.dateFormat : d.dateFormat,
    logo: image(input.logo),
    logoWidth: num(input.logoWidth, 0.5, 4, d.logoWidth),
    showOrgAddress: bool(input.showOrgAddress, d.showOrgAddress),
    showOrgContact: bool(input.showOrgContact, d.showOrgContact),
    showEin: bool(input.showEin, d.showEin),
    showReceiptNumber: bool(input.showReceiptNumber, d.showReceiptNumber),
    showDonorAddress: bool(input.showDonorAddress, d.showDonorAddress),
    windowEnvelope: bool(input.windowEnvelope, d.windowEnvelope),
    showLines: bool(input.showLines, d.showLines),
    showAccount: bool(input.showAccount, d.showAccount),
    showFund: bool(input.showFund, d.showFund),
    showPaymentMethod: bool(input.showPaymentMethod, d.showPaymentMethod),
    intro: text(input.intro, d.intro, 2000),
    closing: text(input.closing, d.closing, 2000),
    showTaxStatement: bool(input.showTaxStatement, d.showTaxStatement),
    taxStatement: text(input.taxStatement, d.taxStatement, 2000),
    showSignature: bool(input.showSignature, d.showSignature),
    signatureName: text(input.signatureName, d.signatureName, 100),
    signatureTitle: text(input.signatureTitle, d.signatureTitle, 100),
    signatureImage: image(input.signatureImage),
    footer: text(input.footer, d.footer, 1000),
    emailSubject: text(input.emailSubject, d.emailSubject, 200).replace(/[\r\n]+/g, ' '),
    emailBody: text(input.emailBody, d.emailBody, 4000),
  };
}

/** Explain why an uploaded image was rejected (normalizeTemplate silently drops invalid images). */
export function imageProblem(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !IMAGE_DATA_URL.test(v)) return 'Images must be PNG or JPEG';
  if (v.length > MAX_IMAGE_CHARS) return 'Images must be smaller than about 500 KB';
  return null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatReceiptDate(iso, fmt) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  switch (fmt) {
    case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${d}`;
    default: return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
  }
}

export const formatMoney = (n) => usd.format(n);

/** Merge field values for a receipt (same names the editor offers). */
export function mergeValues(tpl, data) {
  return {
    donor_name: data.donorName || 'Friend',
    amount: usd.format(data.amount),
    date: formatReceiptDate(data.date, tpl.dateFormat),
    receipt_number: data.receiptNumber,
    payment_method: data.paymentMethod,
    check_number: data.checkNumber || '',
    memo: data.memo || '',
    fund: data.fundName || '',
    org_name: data.org.name,
    ein: data.org.ein || '',
  };
}

/** Replace {{merge_fields}}; unknown fields are left as typed. */
export const applyMerge = (text, values) => String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => (key in values ? values[key] : m));
