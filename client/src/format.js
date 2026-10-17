const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (v) => (v === null || v === undefined || v === '' ? '' : usd.format(Number(v)));
/** Accounting style: negatives in parentheses, no currency symbol. */
export const acct = (v) => {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  if (Math.abs(n) < 0.005) return '0.00';
  return n < 0 ? `(${num.format(-n)})` : num.format(n);
};
export const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n) => Math.round(n * 100) / 100;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const date = (s) => {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
};
export const longDate = (s) => {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const startOfYear = () => `${new Date().getFullYear()}-01-01`;

export const TXN_LABEL = { income: 'Income', expense: 'Expense', deposit: 'Deposit', reconciliation: 'Reconciliation', journal: 'Journal Entry', transfer: 'Transfer', bill: 'Bill' };
export const txnPath = (type, id) => ({ income: `/income/${id}`, expense: `/expenses/${id}`, deposit: `/deposits/${id}`, reconciliation: `/reconcile/${id}`, journal: `/advanced/journal-entries/${id}`, transfer: `/register/transfers/${id}`, bill: `/bills/${id}` }[type]);

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${words(n % 100)}` : ''}`;
  for (const [size, name] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']]) {
    if (n >= size) return `${words(Math.floor(n / size))} ${name}${n % size ? ` ${words(n % size)}` : ''}`;
  }
  return '';
}
/** "One Hundred Twenty and 55/100" for printed checks. */
export const amountInWords = (v) => {
  const cents = Math.round(Number(v) * 100);
  const dollars = Math.floor(cents / 100);
  return `${dollars ? words(dollars) : 'Zero'} and ${String(cents % 100).padStart(2, '0')}/100`;
};

/** Where to go after saving a transaction created from a bank feed line: ?return=/path (this app only), else the bank feed. */
export const feedReturn = (search) => {
  const r = search.get('return');
  return r && r.startsWith('/') && !r.startsWith('//') && !r.includes('\\') ? r : '/bank-feed';
};
