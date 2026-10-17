import { trialBalanceDefinition } from './trialBalance.js';
import { billAgingDefinition } from './billAging.js';
import { tuitionBalancesDefinition } from './tuitionReports.js';

// Standard report definitions. These are copied into each organization's report_definitions
// table so they can be customized; "Reset to default" restores the definition from here.
//
// Definition format (shared with the client report designer):
// {
//   type: 'pnl' | 'balance_sheet',         // period activity vs. balance as of a date
//   defaultPeriod: 'this_fiscal_year' | 'last_fiscal_year' | 'this_month' | 'last_month' |
//                  'this_quarter' | 'last_quarter' | 'fiscal_ytd' | 'today' | 'all',
//   columns: { mode: 'total' | 'fund' | 'month' | 'quarter' | 'year' | 'prior_year' | 'budget',
//              funds: [fundId...],           // fund mode: which funds get columns (empty = all with activity)
//              includeNoFund: bool,          // fund mode: column for entries with no fund
//              includeTotal: bool,           // fund/month/quarter/year modes: add a Total column
//              budgetId: id | null },        // budget mode: budget to compare (null = covering the report date)
//   fundFilter: [fundId...],                // restrict all figures to these funds (empty = all)
//   options: { showZeroRows, showAccountNumbers, percentOf: rowId | null },
//   rows: [
//     { id, kind: 'heading', label },
//     { id, kind: 'accounts', label, filter: { categories:[], types:[], groups:[], accounts:[] },
//       display: 'accounts' | 'by_type' | 'by_group' | 'groups' | 'total',
//       showHeader, showTotal, totalLabel, negate },
//     { id, kind: 'net_income', label, scope: 'period' | 'current_year' | 'prior_years' },
//     { id, kind: 'formula', label, formula: 'income - expense', style: 'normal'|'bold'|'grand', hideIfZero },
//     { id, kind: 'spacer' }
//   ]
// }

const pnlRows = () => [
  { id: 'income', kind: 'accounts', label: 'Income', filter: { types: ['income'] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: 'Total Income' },
  { id: 'expense', kind: 'accounts', label: 'Expenses', filter: { types: ['expense'] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: 'Total Expenses' },
  { id: 'net_operating', kind: 'formula', label: 'Net Operating Income', formula: 'income - expense', style: 'bold' },
  { id: 'other_income', kind: 'accounts', label: 'Other Income', filter: { types: ['other_income'] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: 'Total Other Income' },
  { id: 'other_expense', kind: 'accounts', label: 'Other Expenses', filter: { types: ['other_expense'] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: 'Total Other Expenses' },
  { id: 'net_other', kind: 'formula', label: 'Net Other Income', formula: 'other_income - other_expense', style: 'bold', hideIfZero: true },
  { id: 'net_income', kind: 'formula', label: 'Change in Net Assets', formula: 'net_operating + net_other', style: 'grand' },
];

const bsRows = (byFund) => [
  { id: 'h_assets', kind: 'heading', label: 'Assets' },
  { id: 'assets', kind: 'accounts', label: 'Assets', filter: { categories: ['asset'] }, display: 'by_type', showHeader: false, showTotal: true, totalLabel: 'Total Assets' },
  { id: 'sp1', kind: 'spacer' },
  { id: 'h_le', kind: 'heading', label: 'Liabilities and Net Assets' },
  { id: 'liabilities', kind: 'accounts', label: 'Liabilities', filter: { categories: ['liability'] }, display: 'by_type', showHeader: true, showTotal: true, totalLabel: 'Total Liabilities' },
  { id: 'equity', kind: 'accounts', label: 'Net Assets', filter: { categories: ['equity'] }, display: 'accounts', showHeader: true, showTotal: false },
  { id: 'prior_ni', kind: 'net_income', label: 'Accumulated Change in Net Assets (Prior Years)', scope: 'prior_years' },
  { id: 'current_ni', kind: 'net_income', label: 'Change in Net Assets (Current Year)', scope: 'current_year' },
  { id: 'net_assets', kind: 'formula', label: 'Total Net Assets', formula: 'equity + prior_ni + current_ni', style: 'bold' },
  ...(byFund
    ? [{ id: 'interfund', kind: 'formula', label: 'Interfund Balances (Due to / from Other Funds)', formula: 'assets - liabilities - net_assets', style: 'normal', hideIfZero: true }]
    : []),
  { id: 'total_le', kind: 'formula', label: 'Total Liabilities and Net Assets', formula: byFund ? 'liabilities + net_assets + interfund' : 'liabilities + net_assets', style: 'grand' },
];

const baseOptions = { showZeroRows: false, showAccountNumbers: true, percentOf: null };

// Fund Balances: a column per fund, a row per balance sheet account. Each fund's balance is its assets less its liabilities.
export const fundBalancesDefinition = () => ({
  type: 'balance_sheet', defaultPeriod: 'today', columns: { mode: 'fund', funds: [], includeNoFund: true, includeTotal: true }, fundFilter: [], options: { ...baseOptions },
  rows: [
    { id: 'assets', kind: 'accounts', label: 'Assets', filter: { categories: ['asset'] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: 'Total Assets' },
    { id: 'liabilities', kind: 'accounts', label: 'Liabilities', filter: { categories: ['liability'] }, display: 'accounts', showHeader: true, showTotal: true, totalLabel: 'Total Liabilities' },
    { id: 'fund_balance', kind: 'formula', label: 'Fund Balance', formula: 'assets - liabilities', style: 'grand' },
  ],
});

export const BUILTIN_REPORTS = [
  {
    key: 'pnl',
    name: 'Profit and Loss',
    description: 'Income and expenses for a period (Statement of Activities).',
    definition: { type: 'pnl', defaultPeriod: 'this_fiscal_year', columns: { mode: 'total', funds: [], includeNoFund: true, includeTotal: true }, fundFilter: [], options: { ...baseOptions, percentOf: null }, rows: pnlRows() },
  },
  {
    key: 'balance_sheet',
    name: 'Balance Sheet',
    description: 'Assets, liabilities and net assets as of a date (Statement of Financial Position).',
    definition: { type: 'balance_sheet', defaultPeriod: 'today', columns: { mode: 'total', funds: [], includeNoFund: true, includeTotal: true }, fundFilter: [], options: { ...baseOptions }, rows: bsRows(false) },
  },
  {
    key: 'pnl_by_fund',
    name: 'Profit and Loss by Fund',
    description: 'Income and expenses for a period with a column for each fund.',
    definition: { type: 'pnl', defaultPeriod: 'this_fiscal_year', columns: { mode: 'fund', funds: [], includeNoFund: true, includeTotal: true }, fundFilter: [], options: { ...baseOptions }, rows: pnlRows() },
  },
  {
    key: 'balance_sheet_by_fund',
    name: 'Balance Sheet by Fund',
    description: 'Balance sheet as of a date with a column for each fund.',
    definition: { type: 'balance_sheet', defaultPeriod: 'today', columns: { mode: 'fund', funds: [], includeNoFund: true, includeTotal: true }, fundFilter: [], options: { ...baseOptions }, rows: bsRows(true) },
  },
  {
    key: 'fund_balances',
    name: 'Fund Balances',
    description: 'Each fund’s balance as of a date, by balance sheet account: what the fund holds in each asset account, less what it owes on each liability account.',
    definition: fundBalancesDefinition(),
  },
  {
    key: 'pnl_budget',
    name: 'Budget to Actual Profit and Loss',
    description: 'Income and expenses for a period compared to a budget, with the difference and % of budget.',
    definition: { type: 'pnl', defaultPeriod: 'this_fiscal_year', columns: { mode: 'budget', funds: [], includeNoFund: true, includeTotal: true, budgetId: null }, fundFilter: [], options: { ...baseOptions }, rows: pnlRows() },
  },
  {
    key: 'balance_sheet_budget',
    name: 'Budget to Actual Balance Sheet',
    description: 'Balances as of a date compared to the balances a budget plans for.',
    definition: { type: 'balance_sheet', defaultPeriod: 'today', columns: { mode: 'budget', funds: [], includeNoFund: true, includeTotal: true, budgetId: null }, fundFilter: [], options: { ...baseOptions }, rows: bsRows(false) },
  },
  {
    key: 'bill_aging',
    name: 'Unpaid Bills Aging',
    description: 'Unpaid bills by vendor as of a date, split by how many days past due they are (accounts payable aging).',
    definition: billAgingDefinition(),
  },
  {
    key: 'trial_balance',
    name: 'Trial Balance',
    description: 'Every account balance as a debit or credit as of a date, with matching totals.',
    definition: trialBalanceDefinition(),
  },
];

// Added only for organizations with tuition tracking turned on.
export const TUITION_BUILTIN = {
  key: 'tuition_balances',
  name: 'Tuition Balances',
  description: 'All tuition records with a balance due, by customer.',
  definition: tuitionBalancesDefinition(),
};

export const BUILTIN_BY_KEY = Object.fromEntries([...BUILTIN_REPORTS, TUITION_BUILTIN].map((r) => [r.key, r]));

/** A blank starting point for a brand-new custom report. */
export function blankDefinition(type = 'pnl') {
  if (type === 'tuition') return { ...tuitionBalancesDefinition(), status: 'all', groupBy: 'none' };
  return {
    type,
    defaultPeriod: type === 'pnl' ? 'this_fiscal_year' : 'today',
    columns: { mode: 'total', funds: [], includeNoFund: true, includeTotal: true },
    fundFilter: [],
    options: { ...baseOptions },
    rows: type === 'pnl' ? pnlRows() : bsRows(false),
  };
}
