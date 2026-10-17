import { BUILTIN_REPORTS } from './builtinReports.js';
import { cleanDefinition } from './reports.js';

const DEFAULT_GROUPS = [
  { name: 'Contributions & Grants', account_type: 'income' },
  { name: 'Program & Event Revenue', account_type: 'income' },
  { name: 'Personnel', account_type: 'expense' },
  { name: 'Program Expenses', account_type: 'expense' },
  { name: 'Management & General', account_type: 'expense' },
];

// [number, name, type, group name, extra]
const DEFAULT_ACCOUNTS = [
  ['1000', 'Operating Checking', 'bank'],
  ['1010', 'Savings', 'bank'],
  ['1050', 'Undeposited Funds', 'bank', null, { is_undeposited_funds: true }],
  ['1200', 'Pledges Receivable', 'current_asset'],
  ['1500', 'Furniture & Equipment', 'fixed_asset'],
  ['2000', 'Credit Card', 'credit_card'],
  ['2100', 'Accounts Payable', 'accounts_payable'],
  ['2200', 'Payroll Liabilities', 'current_liability'],
  ['3000', 'Net Assets Without Donor Restrictions', 'equity'],
  ['3100', 'Net Assets With Donor Restrictions', 'equity'],
  ['4000', 'Individual Contributions', 'income', 'Contributions & Grants'],
  ['4100', 'Grants', 'income', 'Contributions & Grants'],
  ['4200', 'Program Service Fees', 'income', 'Program & Event Revenue'],
  ['4300', 'Fundraising Events', 'income', 'Program & Event Revenue'],
  ['4900', 'Interest Income', 'other_income'],
  ['5000', 'Salaries & Wages', 'expense', 'Personnel'],
  ['5050', 'Payroll Taxes & Benefits', 'expense', 'Personnel'],
  ['5100', 'Program Supplies', 'expense', 'Program Expenses'],
  ['5200', 'Rent & Occupancy', 'expense', 'Management & General'],
  ['5300', 'Office Supplies', 'expense', 'Management & General'],
  ['5400', 'Professional Fees', 'expense', 'Management & General'],
  ['5500', 'Bank Service Charges', 'expense', 'Management & General'],
  ['5600', 'Insurance', 'expense', 'Management & General'],
  ['6000', 'Miscellaneous Expense', 'other_expense'],
];

/** Seed a new organization with funds, account groups, a chart of accounts and the standard reports. */
export async function setupOrganization(db, orgId, { defaultChart = true, userId = null } = {}) {
  await db.query(`INSERT INTO funds (organization_id, name, description) VALUES ($1, 'General Fund', 'Unrestricted operating fund')`, [orgId]);

  if (defaultChart) {
    const groupIds = {};
    for (const [i, g] of DEFAULT_GROUPS.entries()) {
      const { rows } = await db.query('INSERT INTO account_groups (organization_id, name, account_type, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, g.name, g.account_type, i]);
      groupIds[g.name] = rows[0].id;
    }
    for (const [number, name, type, group, extra = {}] of DEFAULT_ACCOUNTS) {
      await db.query(
        `INSERT INTO accounts (organization_id, account_number, name, account_type, account_group_id, is_undeposited_funds)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orgId, number, name, type, group ? groupIds[group] : null, Boolean(extra.is_undeposited_funds)],
      );
    }
  }

  await seedBuiltinReports(db, orgId, userId);
}

export async function seedBuiltinReports(db, orgId, userId = null) {
  for (const r of BUILTIN_REPORTS) {
    const exists = await db.query('SELECT 1 FROM report_definitions WHERE organization_id = $1 AND builtin_key = $2', [orgId, r.key]);
    if (exists.rows.length) continue;
    await db.query(
      `INSERT INTO report_definitions (organization_id, name, description, builtin_key, definition, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, r.name, r.description, r.key, JSON.stringify(cleanDefinition(r.definition)), userId],
    );
  }
}
