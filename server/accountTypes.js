// Fixed list of account types. `category` drives financial statement placement;
// `normal` is the normal balance side (debit-normal accounts increase with debits).
export const ACCOUNT_TYPES = [
  { key: 'bank',                 label: 'Bank',                 category: 'asset',     normal: 'debit' },
  { key: 'current_asset',        label: 'Current Asset',        category: 'asset',     normal: 'debit' },
  { key: 'fixed_asset',          label: 'Fixed Asset',          category: 'asset',     normal: 'debit' },
  { key: 'accounts_payable',     label: 'Accounts Payable',     category: 'liability', normal: 'credit' },
  { key: 'credit_card',          label: 'Credit Card',          category: 'liability', normal: 'credit' },
  { key: 'line_of_credit',       label: 'Line of Credit',       category: 'liability', normal: 'credit' },
  { key: 'current_liability',    label: 'Current Liability',    category: 'liability', normal: 'credit' },
  { key: 'loan',                 label: 'Loan',                 category: 'liability', normal: 'credit' },
  { key: 'long_term_liability',  label: 'Long Term Liability',  category: 'liability', normal: 'credit' },
  { key: 'equity',               label: 'Equity',               category: 'equity',    normal: 'credit' },
  { key: 'income',               label: 'Income',               category: 'income',    normal: 'credit' },
  { key: 'other_income',         label: 'Other Income',         category: 'income',    normal: 'credit' },
  { key: 'expense',              label: 'Expense',              category: 'expense',   normal: 'debit' },
  { key: 'other_expense',        label: 'Other Expense',        category: 'expense',   normal: 'debit' },
];

export const TYPE_BY_KEY = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.key, t]));
export const BANKING_TYPES = ['bank', 'credit_card'];
export const isValidType = (key) => Boolean(TYPE_BY_KEY[key]);
