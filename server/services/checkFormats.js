// Check print layouts. Positions and sizes are in inches, measured from the top-left of the check
// (the 8.5" wide check portion of a letter-size sheet).

export const PAGE_WIDTH = 8.5;
export const PAGE_HEIGHT = 11;

// Default positions match common pre-printed voucher check stock (check on top, two stubs below).
export const CHECK_FIELDS = {
  date:        { label: 'Date', x: 6.55, y: 0.8, w: 1.6, show: true },
  payee:       { label: 'Payee name', x: 1.05, y: 1.32, w: 5.2, show: true },
  amount:      { label: 'Amount', x: 6.95, y: 1.32, w: 1.35, show: true },
  amountWords: { label: 'Amount in words', x: 0.45, y: 1.72, w: 6.6, show: true },
  address:     { label: 'Payee address', x: 1.0, y: 2.05, w: 3.5, show: true },
  memo:        { label: 'Memo', x: 0.75, y: 2.95, w: 3.4, show: true },
  orgInfo:     { label: 'Organization name & address', x: 0.4, y: 0.3, w: 3.4, show: false },
  bankName:    { label: 'Bank account name', x: 4.0, y: 0.3, w: 2.4, show: false },
  checkNumber: { label: 'Check number', x: 7.25, y: 0.3, w: 1.0, show: false },
  signature:   { label: 'Signature line', x: 5.2, y: 2.8, w: 2.9, show: false },
};

export const DATE_FORMATS = ['MM/DD/YYYY', 'MM/DD/YY', 'Month D, YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
export const FONTS = ['Courier New', 'Arial', 'Helvetica', 'Times New Roman', 'Verdana'];
export const CHECK_POSITIONS = ['top', 'middle', 'bottom'];

export const DEFAULT_LAYOUT = {
  checkPosition: 'top',       // where the check sits on a 3-part voucher sheet
  checkHeight: 3.5,
  offsetX: 0,                 // printer alignment nudges, applied to everything
  offsetY: 0,
  fontFamily: 'Courier New',
  fontSize: 11,
  dateFormat: 'MM/DD/YYYY',
  protectAmounts: true,       // "**1,234.56" and "One Thousand ... and 56/100 *****"
  printLabels: false,         // "PAY TO THE ORDER OF", "MEMO", "DATE" (for blank check stock)
  printBorder: false,
  signatureText: 'Authorized Signature',
  stubs: 2,                   // voucher stubs printed on the rest of the sheet (0-2)
  stubDetail: true,           // show expense lines (account, memo, fund, amount) on stubs
  fields: Object.fromEntries(Object.entries(CHECK_FIELDS).map(([k, f]) => [k, { x: f.x, y: f.y, w: f.w, show: f.show }])),
};

/** Settings for blank (not pre-printed) check stock. */
export const BLANK_STOCK_PRESET = {
  printLabels: true,
  printBorder: true,
  fields: { orgInfo: { show: true }, bankName: { show: true }, checkNumber: { show: true }, signature: { show: true } },
};

const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
};
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);

/** Fill in defaults and clamp every value so a saved layout always renders sensibly. */
export function normalizeLayout(input = {}) {
  const d = DEFAULT_LAYOUT;
  const checkHeight = num(input.checkHeight, 2.5, 4.5, d.checkHeight);
  const fields = {};
  for (const [key, def] of Object.entries(d.fields)) {
    const f = input.fields?.[key] || {};
    const w = num(f.w, 0.5, PAGE_WIDTH, def.w);
    fields[key] = {
      x: num(f.x, 0, PAGE_WIDTH - 0.25, def.x),
      y: num(f.y, 0, checkHeight - 0.15, def.y),
      w,
      show: f.show === undefined ? def.show : Boolean(f.show),
    };
  }
  return {
    checkPosition: pick(input.checkPosition, CHECK_POSITIONS, d.checkPosition),
    checkHeight,
    offsetX: num(input.offsetX, -1, 1, 0),
    offsetY: num(input.offsetY, -1, 1, 0),
    fontFamily: pick(input.fontFamily, FONTS, d.fontFamily),
    fontSize: num(input.fontSize, 7, 16, d.fontSize),
    dateFormat: pick(input.dateFormat, DATE_FORMATS, d.dateFormat),
    protectAmounts: input.protectAmounts === undefined ? d.protectAmounts : Boolean(input.protectAmounts),
    printLabels: Boolean(input.printLabels),
    printBorder: Boolean(input.printBorder),
    signatureText: String(input.signatureText ?? d.signatureText).slice(0, 60),
    stubs: Math.round(num(input.stubs, 0, 2, d.stubs)),
    stubDetail: input.stubDetail === undefined ? d.stubDetail : Boolean(input.stubDetail),
    fields,
  };
}
