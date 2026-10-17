// Creates a demo organization with sample funds, names and a few months of transactions.
// Usage: npm run seed:demo   (uses DATABASE_URL; creates/updates the user "demo" / "demo-password")
import { pool, withTransaction } from '../server/db.js';
import { migrate } from '../server/migrate.js';
import { hashPassword } from '../server/auth.js';
import { setupOrganization } from '../server/services/orgSetup.js';
import { saveDeposit, saveIncomeExpense, saveReconciliation } from '../server/services/ledger.js';

await migrate();
await withTransaction(async (db) => {
  const name = 'Hope Community Center (Demo)';
  const existing = await db.query('SELECT id FROM organizations WHERE name = $1', [name]);
  if (existing.rows.length) { console.log('Demo organization already exists.'); return; }

  const { rows: [org] } = await db.query('INSERT INTO organizations (name, fiscal_year_start_month, city, state, ein) VALUES ($1, 1, $2, $3, $4) RETURNING id', [name, 'Springfield', 'IL', '12-3456789']);
  let { rows: [user] } = await db.query(`SELECT id FROM users WHERE username = 'demo'`);
  if (!user) {
    ({ rows: [user] } = await db.query(`INSERT INTO users (username, password_hash, display_name) VALUES ('demo', $1, 'Demo User') RETURNING id`, [await hashPassword('demo-password')]));
  }
  await db.query(`INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1, $2, 'admin')`, [user.id, org.id]);
  const admins = await db.query('SELECT id FROM users WHERE is_system_admin');
  for (const a of admins.rows) await db.query(`INSERT INTO user_organizations (user_id, organization_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`, [a.id, org.id]);
  await setupOrganization(db, org.id, { userId: user.id });

  const acct = async (num) => (await db.query('SELECT id FROM accounts WHERE organization_id = $1 AND account_number = $2', [org.id, num])).rows[0].id;
  const fund = async (fname, restricted = false) => (await db.query('INSERT INTO funds (organization_id, name, is_restricted) VALUES ($1,$2,$3) RETURNING id', [org.id, fname, restricted])).rows[0].id;
  const general = (await db.query(`SELECT id FROM funds WHERE organization_id = $1 AND name = 'General Fund'`, [org.id])).rows[0].id;
  const youth = await fund('Youth Program', true);
  const food = await fund('Food Pantry', true);
  const company = async (cname, inc, exp) => (await db.query(
    'INSERT INTO companies (organization_id, name, city, state, default_income_account_id, default_expense_account_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [org.id, cname, 'Springfield', 'IL', inc, exp])).rows[0].id;

  const ids = [];
  for (const num of ['1000', '1050', '4000', '4100', '4200', '4300', '4900', '5000', '5100', '5200', '5300', '5500']) ids.push(await acct(num));
  const [checking, undeposited, contributions, grants, fees, events, interest, salaries, supplies, rent, office, bankfees] = ids;
  await db.query('UPDATE accounts SET default_fund_id = $1 WHERE id = $2', [general, rent]);

  const donors = [];
  for (const [n, a] of [['Jane Smith', contributions], ['Robert Lee', contributions], ['Garcia Family Foundation', grants], ['United Way of Springfield', grants]]) donors.push(await company(n, a, null));
  const vendors = [];
  for (const [n, e] of [['Springfield Properties', rent], ['Office Depot', office], ['Costco', supplies], ['Payroll Services Inc', salaries]]) vendors.push(await company(n, null, e));
  const ctx = { orgId: org.id, userId: user.id };
  const year = new Date().getFullYear();
  const d = (m, day) => `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const thisMonth = new Date().getMonth() + 1;

  for (let m = 1; m <= Math.max(1, thisMonth - 1); m++) {
    const incomeIds = [];
    incomeIds.push(await saveIncomeExpense(db, ctx, 'income', { date: d(m, 3), amount: 250 + m * 10, accountId: undeposited, fundId: general, companyId: donors[0], method: 'check', checkNumber: String(1000 + m), lines: [{ accountId: contributions, amount: 250 + m * 10, fundId: general }] }));
    incomeIds.push(await saveIncomeExpense(db, ctx, 'income', { date: d(m, 5), amount: 100, accountId: undeposited, fundId: youth, companyId: donors[1], method: 'check', checkNumber: String(2000 + m), lines: [{ accountId: contributions, amount: 100, fundId: youth }] }));
    if (m % 3 === 1) incomeIds.push(await saveIncomeExpense(db, ctx, 'income', { date: d(m, 8), amount: 5000, accountId: undeposited, fundId: food, companyId: donors[2], method: 'check', checkNumber: String(3000 + m), memo: 'Quarterly pantry grant', lines: [{ accountId: grants, amount: 5000, fundId: food }] }));
    await saveDeposit(db, ctx, { date: d(m, 10), accountId: checking, incomeIds });
    await saveIncomeExpense(db, ctx, 'income', { date: d(m, 15), amount: 1200, accountId: checking, fundId: youth, companyId: donors[3], memo: 'Youth program grant', lines: [{ accountId: grants, amount: 1000, fundId: youth }, { accountId: fees, amount: 200, fundId: youth }] });
    if (m === 2) await saveIncomeExpense(db, ctx, 'income', { date: d(m, 20), amount: 3400, accountId: checking, fundId: general, memo: 'Spring gala', lines: [{ accountId: events, amount: 3400, fundId: general }] });
    await saveIncomeExpense(db, ctx, 'expense', { date: d(m, 1), amount: 1500, accountId: checking, fundId: general, companyId: vendors[0], method: 'check', checkNumber: String(500 + m * 3), lines: [{ accountId: rent, amount: 1500, fundId: general }] });
    await saveIncomeExpense(db, ctx, 'expense', { date: d(m, 12), amount: 85.4 + m, accountId: checking, fundId: general, companyId: vendors[1], lines: [{ accountId: office, amount: 85.4 + m, fundId: general }] });
    await saveIncomeExpense(db, ctx, 'expense', { date: d(m, 18), amount: 1450, accountId: checking, fundId: food, companyId: vendors[2], lines: [{ accountId: supplies, amount: 1450, fundId: food }] });
    await saveIncomeExpense(db, ctx, 'expense', { date: d(m, 28), amount: 2000, accountId: checking, fundId: general, companyId: vendors[3], memo: 'Payroll', lines: [{ accountId: salaries, amount: 2000, fundId: general }] });
    await saveIncomeExpense(db, ctx, 'expense', { date: d(m, 28), amount: 1200, accountId: checking, fundId: youth, companyId: vendors[3], memo: 'Payroll - youth staff', lines: [{ accountId: salaries, amount: 1200, fundId: youth }] });
    await saveIncomeExpense(db, ctx, 'income', { date: d(m, 20), amount: 4500, accountId: checking, fundId: general, companyId: donors[3], memo: 'Operating support', lines: [{ accountId: grants, amount: 4500, fundId: general }] });
  }

  // Reconcile January.
  const jan = await db.query(`SELECT id, transaction_type, amount FROM transactions WHERE organization_id = $1 AND account_id = $2 AND date <= $3 AND transaction_type <> 'reconciliation'`, [org.id, checking, d(1, 31)]);
  const cents = (v) => Math.round(Number(v) * 100);
  const net = jan.rows.reduce((s, t) => s + (t.transaction_type === 'expense' ? -cents(t.amount) : cents(t.amount)), 0) - 1200 + 37;
  await saveReconciliation(db, ctx, {
    accountId: checking, statementDate: d(1, 31), statementEndingBalance: net / 100, clearedIds: jan.rows.map((t) => t.id), complete: true,
    serviceCharge: { amount: 12, date: d(1, 31), accountId: bankfees, fundId: general },
    interest: { amount: 0.37, date: d(1, 31), accountId: interest, fundId: general },
  });
  console.log(`Created demo organization "${name}". Sign in as demo / demo-password.`);
});
await pool.end();
