import { BANKING_TYPES } from '../accountTypes.js';
import { HttpError, emptyToNull, fromCents, idOrNull, loadOwned, requireDate, toCents } from '../util.js';
import { cleanExtract } from './statementMatch.js';

// ---------------------------------------------------------------------------
// General ledger helpers
// ---------------------------------------------------------------------------

/**
 * Write one GL entry (header + details). Lines: { accountId, fundId, debit, credit, detailId } in cents.
 * Enforces that debits equal credits.
 */
async function writeGl(db, orgId, { date, transactionId, kind = 'transaction', description }, lines) {
  const dr = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (dr !== cr) throw new HttpError(400, `General ledger entry is out of balance (debits ${fromCents(dr)} ≠ credits ${fromCents(cr)})`);
  const { rows } = await db.query(
    'INSERT INTO gl_headers (organization_id, date, transaction_id, entry_kind, description) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orgId, date, transactionId, kind, description || null],
  );
  for (const l of lines) {
    await db.query(
      'INSERT INTO gl_details (gl_header_id, account_id, fund_id, debit, credit, transaction_detail_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [rows[0].id, l.accountId, l.fundId ?? null, fromCents(l.debit || 0), fromCents(l.credit || 0), l.detailId ?? null],
    );
  }
  return rows[0].id;
}

const deleteGl = (db, transactionId, kinds = ['transaction']) =>
  db.query('DELETE FROM gl_headers WHERE transaction_id = $1 AND entry_kind = ANY($2::text[])', [transactionId, kinds]);

async function loadTxn(db, orgId, id, type) {
  const { rows } = await db.query('SELECT * FROM transactions WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, orgId]);
  const t = rows[0];
  if (!t || (type && t.transaction_type !== type)) throw new HttpError(404, 'Transaction not found');
  return t;
}

/** Bank accounts a journal entry has been cleared on: [{ account_id, reconciliation_id, is_complete, net }] (net in cents). */
async function journalReconciledLines(db, journalId) {
  const { rows } = await db.query(
    `SELECT d.account_id, d.reconciliation_id, COALESCE(r.is_complete, false) AS is_complete, a.name AS account_name,
            SUM(ROUND(d.amount * 100))::bigint AS net
       FROM transaction_details d LEFT JOIN reconciliations r ON r.transaction_id = d.reconciliation_id
       LEFT JOIN accounts a ON a.id = d.account_id
      WHERE d.transaction_id = $1 AND d.reconciliation_id IS NOT NULL
      GROUP BY d.account_id, d.reconciliation_id, r.is_complete, a.name`,
    [journalId],
  );
  return rows.map((r) => ({ ...r, net: Number(r.net) }));
}

/** Transaction types whose lines carry debits/credits and are cleared / matched per bank account. */
export const LINE_TYPES = ['journal', 'transfer'];

async function isInCompletedReconciliation(db, txn) {
  if (LINE_TYPES.includes(txn.transaction_type)) return (await journalReconciledLines(db, txn.id)).some((l) => l.is_complete);
  if (!txn.reconciliation_id) return false;
  const { rows } = await db.query('SELECT is_complete FROM reconciliations WHERE transaction_id = $1', [txn.reconciliation_id]);
  return Boolean(rows[0]?.is_complete);
}

/** The deposit (if any) an income transaction has been included in. */
async function depositFor(db, incomeId) {
  const { rows } = await db.query(
    `SELECT t.* FROM transaction_details d JOIN transactions t ON t.id = d.transaction_id
      WHERE d.linked_transaction_id = $1 AND t.transaction_type = 'deposit' LIMIT 1`,
    [incomeId],
  );
  return rows[0] || null;
}

function assertBankingAccount(acct, label) {
  if (!acct || !BANKING_TYPES.includes(acct.account_type)) throw new HttpError(400, `${label} must be a Bank or Credit Card account`);
}

/** Total paid toward a bill (cents), optionally ignoring one payment transaction. */
export async function billPaid(db, billId, excludeTxnId = null) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS paid FROM transaction_details WHERE bill_id = $1 AND transaction_id IS DISTINCT FROM $2',
    [billId, excludeTxnId]);
  return Number(rows[0].paid);
}

/**
 * Expense lines that pay bills: each must be a positive amount to the bill's A/P account, for a bill from the same vendor,
 * and the payments can't add up to more than the bill. The line's fund is the bill's fund, so A/P clears fund by fund.
 */
/** How a bill's amount is split by fund (cents): its credits to Accounts Payable in the general ledger. */
async function billFunds(db, billId, apAccountId) {
  const { rows } = await db.query(
    `SELECT d.fund_id, SUM(ROUND(d.credit * 100) - ROUND(d.debit * 100))::bigint AS cents
       FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
      WHERE h.transaction_id = $1 AND h.entry_kind = 'transaction' AND d.account_id = $2
      GROUP BY d.fund_id HAVING SUM(ROUND(d.credit * 100) - ROUND(d.debit * 100)) <> 0
      ORDER BY d.fund_id NULLS FIRST`, [billId, apAccountId]);
  return rows.map((r) => ({ fundId: r.fund_id, cents: Number(r.cents) }));
}

/** Split `amount` (cents) in proportion to `parts` ([{ cents }]), largest remainders first, so the pieces add up exactly. */
function prorate(amount, parts) {
  const total = parts.reduce((s, p) => s + p.cents, 0);
  if (!total) return parts.map((p, i) => (i === 0 ? amount : 0));
  const raw = parts.map((p) => (amount * p.cents) / total);
  const out = raw.map(Math.floor);
  let left = amount - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; out[i] += 1; left -= 1; }
  return out;
}

async function checkBillPayments(db, orgId, txnId, companyId, lines) {
  const billIds = [...new Set(lines.map((l) => l.billId).filter(Boolean))];
  if (!billIds.length) return;
  const { rows } = await db.query(
    `SELECT id, company_id, account_id, fund_id, amount, ref_number, transaction_type FROM transactions
      WHERE organization_id = $1 AND id = ANY($2::int[])`, [orgId, billIds]);
  const bills = Object.fromEntries(rows.filter((b) => b.transaction_type === 'bill').map((b) => [b.id, b]));
  const label = (b) => (b.ref_number ? `bill ${b.ref_number}` : `bill #${b.id}`);
  for (const [i, l] of lines.entries()) {
    if (!l.billId) continue;
    const b = bills[l.billId];
    if (!b) throw new HttpError(400, `Line ${i + 1}: bill not found`);
    if (b.company_id !== companyId) throw new HttpError(400, `Line ${i + 1}: ${label(b)} is from a different vendor than Paid To`);
    if (l.accountId !== b.account_id) throw new HttpError(400, `Line ${i + 1}: a payment on ${label(b)} must use the bill's Accounts Payable account`);
    if (l.amount <= 0) throw new HttpError(400, `Line ${i + 1}: a bill payment must be more than zero`);
  }
  // Each payment line pays down one of the bill's funds. A line without one of them is split across the bill's
  // funds in proportion to the bill, so each fund's payable is cleared.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (!l.billId) continue;
    const funds = await billFunds(db, l.billId, bills[l.billId].account_id);
    if (!funds.length || funds.some((f) => f.fundId === l.fundId)) continue;
    if (funds.length === 1) { l.fundId = funds[0].fundId; continue; }
    const pieces = prorate(l.amount, funds);
    lines.splice(i, 1, ...funds.map((f, k) => ({ ...l, fundId: f.fundId, amount: pieces[k] })).filter((x) => x.amount));
  }
  for (const id of billIds) {
    const b = bills[id];
    const applying = lines.filter((l) => l.billId === id).reduce((s, l) => s + l.amount, 0);
    const open = toCents(b.amount) - (await billPaid(db, id, txnId));
    if (applying > open) throw new HttpError(400, `The payment of ${fromCents(applying)} on ${label(b)} is more than its open balance of ${fromCents(open)}`);
  }
}

// ---------------------------------------------------------------------------
// Income & Expense
// ---------------------------------------------------------------------------

/**
 * Create or update an income, expense or bill transaction and regenerate its GL entry.
 * Income: Dr deposit-to account (header fund), Cr each detail account/fund.
 * Expense: Cr bank account (header fund), Dr each detail account/fund.
 * Bill: Cr the Accounts Payable account (header fund), Dr each detail account/fund. Expense lines can pay bills (bill_id).
 */
export async function saveIncomeExpense(db, ctx, type, body, id = null) {
  const { orgId, userId } = ctx;
  const isBill = type === 'bill';
  const date = requireDate(body.date);
  const dueDate = isBill && body.dueDate ? requireDate(body.dueDate, 'Due date') : null;
  const amount = toCents(body.amount);
  if (amount <= 0) throw new HttpError(400, 'Amount must be greater than zero');
  const accountId = idOrNull(body.accountId);
  if (!accountId) throw new HttpError(400, type === 'income' ? 'Deposit To is required' : isBill ? 'Accounts Payable account is required' : 'Bank Account is required');
  const fundId = idOrNull(body.fundId);
  const companyId = idOrNull(body.companyId);
  if (isBill && !companyId) throw new HttpError(400, 'Vendor is required');
  const method = isBill ? null : body.method === 'check' ? 'check' : 'electronic';
  const checkNumber = isBill ? null : emptyToNull(body.checkNumber);

  const lines = (body.lines || [])
    .filter((l) => l && (l.accountId || toCents(l.amount) !== 0))
    .map((l, i) => {
      const lineAmount = toCents(l.amount);
      const lineAccount = idOrNull(l.accountId);
      if (!lineAccount) throw new HttpError(400, `Line ${i + 1}: Account is required`);
      if (lineAmount === 0) throw new HttpError(400, `Line ${i + 1}: Amount is required`);
      return { accountId: lineAccount, amount: lineAmount, memo: emptyToNull(l.memo), fundId: idOrNull(l.fundId), tuitionId: idOrNull(l.tuitionId), billId: idOrNull(l.billId) };
    });
  if (!lines.length) throw new HttpError(400, 'At least one detail line is required');
  // A fund given for the whole transaction (imports, API) is the default for lines without one.
  for (const l of lines) if (!l.fundId) l.fundId = fundId;
  const lineTotal = lines.reduce((s, l) => s + l.amount, 0);
  if (lineTotal !== amount) {
    throw new HttpError(400, `Detail lines total ${fromCents(lineTotal)} but the transaction amount is ${fromCents(amount)}. They must be equal.`);
  }

  const accts = await loadOwned(db, 'accounts', [accountId, ...lines.map((l) => l.accountId)], orgId, 'account');
  if (isBill) {
    if (accts[accountId].account_type !== 'accounts_payable') throw new HttpError(400, 'The bill must post to an Accounts Payable account');
  } else assertBankingAccount(accts[accountId], type === 'income' ? 'Deposit To' : 'Bank Account');
  if (lines.some((l) => l.billId) && type !== 'expense') throw new HttpError(400, 'Only expenses can pay bills');
  if (isBill && lines.some((l) => BANKING_TYPES.includes(accts[l.accountId].account_type))) {
    throw new HttpError(400, 'Bill lines can’t use a bank or credit card account (use Pay Bills to pay a bill)');
  }
  await loadOwned(db, 'funds', [fundId, ...lines.map((l) => l.fundId)], orgId, 'fund');
  if (companyId) await loadOwned(db, 'companies', [companyId], orgId, 'customer/donor/vendor');
  const tuitionIds = lines.map((l) => l.tuitionId).filter(Boolean);
  if (tuitionIds.length) {
    if (type !== 'income') throw new HttpError(400, 'Only income can be applied to tuition');
    const tuition = await loadOwned(db, 'tuition_records', tuitionIds, orgId, 'tuition record');
    for (const t of Object.values(tuition)) {
      if (t.company_id !== companyId) throw new HttpError(400, 'A tuition record on this income belongs to a different customer than Received From');
    }
  }

  if (type === 'expense') await checkBillPayments(db, orgId, id, companyId, lines);
  // The transaction's fund is the lines' fund when they all share one.
  const lineFunds = new Set(lines.map((l) => l.fundId ?? null));
  const txnFund = lineFunds.size === 1 ? [...lineFunds][0] : null;

  let txnId = id;
  let deposit = null;
  if (id) {
    const existing = await loadTxn(db, orgId, id, type);
    if (isBill) {
      const paid = await billPaid(db, id);
      if (paid && amount < paid) throw new HttpError(409, `This bill has ${fromCents(paid)} of payments, so its amount can’t be less than that`);
      if (paid && (existing.company_id !== companyId || existing.account_id !== accountId)) {
        throw new HttpError(409, 'This bill has payments, so its vendor and Accounts Payable account can’t be changed');
      }
    }
    const changedMoney = toCents(existing.amount) !== amount || existing.account_id !== accountId;
    if (changedMoney && (await isInCompletedReconciliation(db, existing))) {
      throw new HttpError(409, 'This transaction is part of a completed reconciliation; its amount and bank account cannot be changed.');
    }
    if (type === 'income') {
      deposit = await depositFor(db, id);
      if (deposit && changedMoney) throw new HttpError(409, 'This income has been deposited; remove it from the deposit before changing its amount or Deposit To account.');
    }
    await db.query(
      `UPDATE transactions SET transaction_method=$1, date=$2, amount=$3, ref_number=$4, check_number=$5, account_id=$6,
              fund_id=$7, company_id=$8, memo=$9, due_date=$10, updated_at=now()
        WHERE id=$11 AND organization_id=$12`,
      [method, date, fromCents(amount), emptyToNull(body.refNumber), checkNumber, accountId, txnFund, companyId, emptyToNull(body.memo), dueDate, id, orgId],
    );
    await db.query('DELETE FROM transaction_details WHERE transaction_id = $1', [id]);
    await deleteGl(db, id);
  } else {
    const { rows } = await db.query(
      `INSERT INTO transactions (organization_id, transaction_type, transaction_method, date, amount, ref_number, check_number,
                                 account_id, fund_id, company_id, memo, due_date, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [orgId, type, method, date, fromCents(amount), emptyToNull(body.refNumber), checkNumber, accountId, txnFund, companyId, emptyToNull(body.memo), dueDate, userId],
    );
    txnId = rows[0].id;
  }

  const glLines = [];
  for (const [i, l] of lines.entries()) {
    const { rows } = await db.query(
      'INSERT INTO transaction_details (transaction_id, account_id, amount, memo, fund_id, sort_order, tuition_id, bill_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [txnId, l.accountId, fromCents(l.amount), l.memo, l.fundId, i, l.tuitionId, l.billId],
    );
    glLines.push(type === 'income'
      ? { accountId: l.accountId, fundId: l.fundId, credit: l.amount, detailId: rows[0].id }
      : { accountId: l.accountId, fundId: l.fundId, debit: l.amount, detailId: rows[0].id });
  }
  // The bank (or A/P) side is split by the lines' funds, so every fund stays in balance.
  const byFund = new Map();
  for (const l of lines) byFund.set(l.fundId ?? null, (byFund.get(l.fundId ?? null) || 0) + l.amount);
  const headerLines = [...byFund.entries()].filter(([, net]) => net).map(([f, net]) => (type === 'income'
    ? (net > 0 ? { accountId, fundId: f, debit: net } : { accountId, fundId: f, credit: -net })
    : (net > 0 ? { accountId, fundId: f, credit: net } : { accountId, fundId: f, debit: -net })));
  await writeGl(db, orgId, { date, transactionId: txnId, description: type === 'income' ? 'Income' : isBill ? 'Bill' : 'Expense' }, [...headerLines, ...glLines]);

  // The deposit's GL uses the income's fund, so keep it in sync after an edit.
  if (deposit) await repostDeposit(db, orgId, deposit.id);
  if (id) await revalidateFeedMatches(db, orgId, txnId);
  if (body.bankFeedItemId) await matchFeedItem(db, orgId, idOrNull(body.bankFeedItemId), txnId);
  return txnId;
}

/**
 * Pay one or more bills from one vendor with a single expense.
 * body: { companyId, date, accountId (bank / credit card), method, checkNumber, refNumber, memo, payments: [{ billId, amount }] }
 */
export async function payBills(db, ctx, body) {
  const companyId = idOrNull(body.companyId);
  if (!companyId) throw new HttpError(400, 'Choose the vendor to pay');
  const payments = (Array.isArray(body.payments) ? body.payments : [])
    .map((p) => ({ billId: idOrNull(p.billId), amount: toCents(p.amount) }))
    .filter((p) => p.billId && p.amount !== 0);
  if (!payments.length) throw new HttpError(400, 'Choose at least one bill and enter the amount to pay');
  if (payments.some((p) => p.amount < 0)) throw new HttpError(400, 'Each bill payment must be more than zero');
  if (new Set(payments.map((p) => p.billId)).size !== payments.length) throw new HttpError(400, 'Each bill can appear only once');
  const { rows } = await db.query(
    `SELECT id, account_id, fund_id, ref_number, date FROM transactions
      WHERE organization_id = $1 AND transaction_type = 'bill' AND id = ANY($2::int[])`, [ctx.orgId, payments.map((p) => p.billId)]);
  const bills = Object.fromEntries(rows.map((b) => [b.id, b]));
  if (rows.length !== payments.length) throw new HttpError(400, 'Bill not found');
  const funds = new Set(rows.map((b) => b.fund_id));
  const total = payments.reduce((s, p) => s + p.amount, 0);
  return saveIncomeExpense(db, ctx, 'expense', {
    date: body.date, companyId, accountId: body.accountId, method: body.method, checkNumber: body.checkNumber,
    refNumber: body.refNumber, memo: body.memo, fundId: funds.size === 1 ? [...funds][0] : null, amount: fromCents(total),
    lines: payments.map((p) => {
      const b = bills[p.billId];
      return { accountId: b.account_id, amount: fromCents(p.amount), fundId: null, billId: b.id, memo: b.ref_number ? `Bill ${b.ref_number}` : `Bill of ${b.date}` };
    }),
  });
}

export async function deleteTransaction(db, orgId, id, type) {
  const txn = await loadTxn(db, orgId, id, type);
  if (await isInCompletedReconciliation(db, txn)) throw new HttpError(409, 'This transaction is part of a completed reconciliation and cannot be deleted.');
  if (type === 'income' && (await depositFor(db, id))) throw new HttpError(409, 'This income has been deposited. Remove it from the deposit first.');
  if (type === 'bill' && (await billPaid(db, id))) throw new HttpError(409, 'This bill has payments. Delete or change those payments first.');
  await db.query(`UPDATE bank_feed_items SET status = 'unmatched', transaction_id = NULL WHERE transaction_id = $1`, [id]);
  await db.query('DELETE FROM transactions WHERE id = $1 AND organization_id = $2', [id, orgId]);
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

/**
 * Create or update a general journal entry. Each line is a debit or a credit to an account/fund;
 * a line without a fund uses the header fund. Debits must equal credits. The GL entry mirrors the lines.
 */
export async function saveJournal(db, ctx, body, id = null) {
  const { orgId, userId } = ctx;
  const date = requireDate(body.date);
  const fundId = idOrNull(body.fundId);
  const description = emptyToNull(String(body.memo ?? '').trim());
  const lines = (body.lines || [])
    .filter((l) => l && (l.accountId || toCents(l.debit) || toCents(l.credit)))
    .map((l, i) => {
      const debit = toCents(l.debit);
      const credit = toCents(l.credit);
      const accountId = idOrNull(l.accountId);
      if (!accountId) throw new HttpError(400, `Line ${i + 1}: Account is required`);
      if (debit < 0 || credit < 0) throw new HttpError(400, `Line ${i + 1}: amounts cannot be negative`);
      if (debit && credit) throw new HttpError(400, `Line ${i + 1}: enter either a debit or a credit, not both`);
      if (!debit && !credit) throw new HttpError(400, `Line ${i + 1}: enter a debit or a credit amount`);
      return { accountId, debit, credit, fundId: idOrNull(l.fundId) ?? fundId, memo: emptyToNull(String(l.memo ?? '').trim()) };
    });
  if (lines.length < 2) throw new HttpError(400, 'A journal entry needs at least two lines');
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  if (debits !== credits) throw new HttpError(400, `Debits (${fromCents(debits)}) must equal credits (${fromCents(credits)})`);

  await loadOwned(db, 'accounts', lines.map((l) => l.accountId), orgId, 'account');
  await loadOwned(db, 'funds', [fundId, ...lines.map((l) => l.fundId)], orgId, 'fund');
  return postLineEntry(db, ctx, 'journal', { date, fundId, memo: description, glDescription: description || 'Journal entry' }, lines, id, body.bankFeedItemId);
}

/**
 * Save a line-based transaction (journal entry or bank transfer) and its GL entry.
 * header: { date, fundId, memo, glDescription, accountId?, refNumber? }; lines: [{ accountId, debit, credit, fundId, memo }] in cents.
 */
async function postLineEntry(db, ctx, type, header, lines, id, bankFeedItemId) {
  const { orgId, userId } = ctx;
  const { date, fundId } = header;
  const description = header.memo;
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  let txnId = id;
  let keepLinks = [];
  if (id) {
    await loadTxn(db, orgId, id, type);
    // Cleared bank lines stay cleared if the entry's net effect on that account is unchanged. In a completed
    // reconciliation the amount is locked; in one still in progress a changed amount simply becomes uncleared.
    const netFor = (accountId) => lines.filter((l) => l.accountId === accountId).reduce((s, l) => s + l.debit - l.credit, 0);
    for (const link of await journalReconciledLines(db, id)) {
      if (netFor(link.account_id) === link.net) keepLinks.push(link);
      else if (link.is_complete) {
        throw new HttpError(409, `This entry's amount to ${link.account_name} is part of a completed reconciliation and cannot be changed.`);
      }
    }
    await db.query('UPDATE transactions SET date=$1, amount=$2, fund_id=$3, memo=$4, account_id=$5, ref_number=$6, updated_at=now() WHERE id=$7 AND organization_id=$8',
      [date, fromCents(debits), fundId, description, header.accountId ?? null, header.refNumber ?? null, id, orgId]);
    await db.query('DELETE FROM transaction_details WHERE transaction_id = $1', [id]);
    await deleteGl(db, id);
  } else {
    const { rows } = await db.query(
      `INSERT INTO transactions (organization_id, transaction_type, date, amount, fund_id, memo, account_id, ref_number, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, type, date, fromCents(debits), fundId, description, header.accountId ?? null, header.refNumber ?? null, userId],
    );
    txnId = rows[0].id;
  }

  const glLines = [];
  for (const [i, l] of lines.entries()) {
    const { rows } = await db.query(
      `INSERT INTO transaction_details (transaction_id, account_id, amount, debit, credit, memo, fund_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [txnId, l.accountId, fromCents(l.debit - l.credit), fromCents(l.debit), fromCents(l.credit), l.memo, l.fundId, i],
    );
    glLines.push({ accountId: l.accountId, fundId: l.fundId, debit: l.debit, credit: l.credit, detailId: rows[0].id });
  }
  for (const link of keepLinks) {
    await db.query('UPDATE transaction_details SET reconciliation_id = $1 WHERE transaction_id = $2 AND account_id = $3', [link.reconciliation_id, txnId, link.account_id]);
  }
  await writeGl(db, orgId, { date, transactionId: txnId, description: header.glDescription }, glLines);
  if (id) await revalidateFeedMatches(db, orgId, txnId);
  if (bankFeedItemId) await matchFeedItem(db, orgId, idOrNull(bankFeedItemId), txnId);
  return txnId;
}

// ---------------------------------------------------------------------------
// Bank transfers
// ---------------------------------------------------------------------------

/** Move money between two bank / credit card accounts: Dr the To account, Cr the From account. */
export async function saveTransfer(db, ctx, body, id = null) {
  const { orgId } = ctx;
  const date = requireDate(body.date);
  const amount = toCents(body.amount);
  if (amount <= 0) throw new HttpError(400, 'Amount must be greater than zero');
  const fromId = idOrNull(body.fromAccountId);
  const toId = idOrNull(body.toAccountId);
  if (!fromId) throw new HttpError(400, 'From account is required');
  if (!toId) throw new HttpError(400, 'To account is required');
  if (fromId === toId) throw new HttpError(400, 'From and To must be different accounts');
  const fundId = idOrNull(body.fundId);
  const accts = await loadOwned(db, 'accounts', [fromId, toId], orgId, 'account');
  for (const [aid, label] of [[fromId, 'From'], [toId, 'To']]) {
    assertBankingAccount(accts[aid], `${label} account`);
    if (accts[aid].is_undeposited_funds) throw new HttpError(400, `${label} account can't be an Undeposited Funds account (use Deposits instead)`);
  }
  if (fundId) await loadOwned(db, 'funds', [fundId], orgId, 'fund');
  const memo = emptyToNull(String(body.memo ?? '').trim());
  const glDescription = memo || `Transfer from ${accts[fromId].name} to ${accts[toId].name}`;
  const lines = [
    { accountId: toId, debit: amount, credit: 0, fundId, memo },
    { accountId: fromId, debit: 0, credit: amount, fundId, memo },
  ];
  return postLineEntry(db, ctx, 'transfer', { date, fundId, memo, glDescription, accountId: fromId, refNumber: emptyToNull(String(body.refNumber ?? '').trim()) }, lines, id, body.bankFeedItemId);
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/** Income transactions sitting in an Undeposited Funds account that are not yet in a deposit. */
export async function undepositedFunds(db, orgId, includeDepositId = null) {
  const { rows } = await db.query(
    `SELECT t.id, t.date, t.amount, t.check_number, t.ref_number, t.memo, t.fund_id, c.name AS company_name,
            a.name AS account_name, f.name AS fund_name
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id AND a.is_undeposited_funds
       LEFT JOIN companies c ON c.id = t.company_id
       LEFT JOIN funds f ON f.id = t.fund_id
      WHERE t.organization_id = $1 AND t.transaction_type = 'income'
        AND NOT EXISTS (
          SELECT 1 FROM transaction_details d JOIN transactions dep ON dep.id = d.transaction_id
           WHERE d.linked_transaction_id = t.id AND dep.transaction_type = 'deposit' AND dep.id IS DISTINCT FROM $2)
      ORDER BY t.date, t.id`,
    [orgId, includeDepositId],
  );
  return rows;
}

/** Regenerate a deposit's GL: Dr deposit-to account (per fund), Cr each linked income's undeposited funds account. */
async function repostDeposit(db, orgId, depositId) {
  const dep = await loadTxn(db, orgId, depositId, 'deposit');
  const { rows: details } = await db.query(
    `SELECT d.id, d.amount, t.id AS linked_id, t.account_id AS income_account_id, t.fund_id AS income_fund_id
       FROM transaction_details d JOIN transactions t ON t.id = d.linked_transaction_id
      WHERE d.transaction_id = $1 ORDER BY d.sort_order, d.id`,
    [depositId],
  );
  await deleteGl(db, depositId);
  const credits = [];
  const debitsByFund = new Map();
  let total = 0;
  for (const d of details) {
    const cents = toCents(d.amount);
    total += cents;
    // Keep detail rows aligned with the linked income in case it was edited.
    await db.query('UPDATE transaction_details SET account_id = $1, fund_id = $2 WHERE id = $3', [d.income_account_id, d.income_fund_id, d.id]);
    // The income sits in Undeposited Funds split by its lines' funds; move each part to the bank in the same fund.
    const { rows: parts } = await db.query(
      `SELECT g.fund_id, SUM(ROUND(g.debit * 100) - ROUND(g.credit * 100))::bigint AS cents
         FROM gl_details g JOIN gl_headers h ON h.id = g.gl_header_id
        WHERE h.transaction_id = $1 AND h.entry_kind = 'transaction' AND g.account_id = $2
        GROUP BY g.fund_id HAVING SUM(ROUND(g.debit * 100) - ROUND(g.credit * 100)) <> 0`,
      [d.linked_id, d.income_account_id]);
    const split = parts.length ? parts.map((p) => ({ fundId: p.fund_id, cents: Number(p.cents) })) : [{ fundId: d.income_fund_id, cents }];
    for (const p of split) {
      credits.push({ accountId: d.income_account_id, fundId: p.fundId, credit: p.cents, detailId: d.id });
      debitsByFund.set(p.fundId ?? null, (debitsByFund.get(p.fundId ?? null) || 0) + p.cents);
    }
  }
  await db.query('UPDATE transactions SET amount = $1, updated_at = now() WHERE id = $2', [fromCents(total), depositId]);
  if (!details.length) return;
  const debits = [...debitsByFund.entries()].map(([fundId, cents]) => ({ accountId: dep.account_id, fundId, debit: cents }));
  await writeGl(db, orgId, { date: dep.date, transactionId: depositId, description: 'Deposit' }, [...debits, ...credits]);
}

export async function saveDeposit(db, ctx, body, id = null) {
  const { orgId, userId } = ctx;
  const date = requireDate(body.date);
  const accountId = idOrNull(body.accountId);
  if (!accountId) throw new HttpError(400, 'Deposit To is required');
  const accts = await loadOwned(db, 'accounts', [accountId], orgId, 'account');
  assertBankingAccount(accts[accountId], 'Deposit To');
  if (accts[accountId].is_undeposited_funds) throw new HttpError(400, 'Deposit To cannot be an Undeposited Funds account');
  const incomeIds = [...new Set((body.incomeIds || []).map(Number))];
  if (!incomeIds.length) throw new HttpError(400, 'Add at least one undeposited funds item to the deposit');

  let depId = id;
  if (id) {
    const existing = await loadTxn(db, orgId, id, 'deposit');
    if (await isInCompletedReconciliation(db, existing)) {
      const { rows } = await db.query('SELECT linked_transaction_id FROM transaction_details WHERE transaction_id = $1', [id]);
      const same = rows.length === incomeIds.length && rows.every((r) => incomeIds.includes(r.linked_transaction_id));
      if (!same || existing.account_id !== accountId) throw new HttpError(409, 'This deposit is part of a completed reconciliation; its items and account cannot be changed.');
    }
  }

  const eligible = new Map((await undepositedFunds(db, orgId, id)).map((r) => [r.id, r]));
  for (const incomeId of incomeIds) {
    if (!eligible.has(incomeId)) throw new HttpError(400, `Income transaction ${incomeId} is not available for deposit`);
  }

  if (id) {
    await db.query('UPDATE transactions SET date=$1, account_id=$2, memo=$3, updated_at=now() WHERE id=$4', [date, accountId, emptyToNull(body.memo), id]);
    // Detail records can be added or removed but not edited.
    await db.query('DELETE FROM transaction_details WHERE transaction_id = $1 AND NOT (linked_transaction_id = ANY($2::int[]))', [id, incomeIds]);
  } else {
    const { rows } = await db.query(
      `INSERT INTO transactions (organization_id, transaction_type, date, amount, account_id, memo, created_by_user_id)
       VALUES ($1,'deposit',$2,0,$3,$4,$5) RETURNING id`,
      [orgId, date, accountId, emptyToNull(body.memo), userId],
    );
    depId = rows[0].id;
  }
  const { rows: existingDetails } = await db.query('SELECT linked_transaction_id FROM transaction_details WHERE transaction_id = $1', [depId]);
  const have = new Set(existingDetails.map((r) => r.linked_transaction_id));
  for (const [i, incomeId] of incomeIds.entries()) {
    if (have.has(incomeId)) continue;
    const inc = eligible.get(incomeId);
    await db.query(
      `INSERT INTO transaction_details (transaction_id, account_id, amount, memo, fund_id, linked_transaction_id, sort_order)
       SELECT $1, t.account_id, t.amount, $2, t.fund_id, t.id, $3 FROM transactions t WHERE t.id = $4`,
      [depId, inc.company_name || null, i, incomeId],
    );
  }
  await repostDeposit(db, orgId, depId);
  if (id) await revalidateFeedMatches(db, orgId, depId);
  if (body.bankFeedItemId) await matchFeedItem(db, orgId, idOrNull(body.bankFeedItemId), depId);
  return depId;
}

// ---------------------------------------------------------------------------
// Reconciliations
// ---------------------------------------------------------------------------

/** Sign used to present balances: credit card balances are shown as the amount owed. */
const balanceSign = (acct) => (acct.account_type === 'credit_card' ? -1 : 1);

export async function priorStatementBalance(db, orgId, accountId, excludeId = null) {
  const { rows } = await db.query(
    `SELECT r.statement_ending_balance FROM reconciliations r JOIN transactions t ON t.id = r.transaction_id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND r.is_complete AND t.id IS DISTINCT FROM $3
      ORDER BY r.statement_date DESC, t.id DESC LIMIT 1`,
    [orgId, accountId, excludeId],
  );
  return rows.length ? toCents(rows[0].statement_ending_balance) : 0;
}

/**
 * Items that can be cleared in a reconciliation for this account: income, expenses and deposits whose bank account
 * is this account, plus journal entries with lines to it (one item per entry, for its net effect on the account).
 * direction: 'in' increases the bank balance (deposit side), 'out' decreases it (payment side).
 */
export async function reconciliationCandidates(db, orgId, accountId, recId = null) {
  const { rows } = await db.query(
    `SELECT t.id, t.transaction_type, t.date, t.amount, t.check_number, t.ref_number, t.memo, c.name AS company_name,
            (t.reconciliation_id IS NOT NULL AND t.reconciliation_id = $3::int) AS cleared,
            CASE WHEN t.transaction_type = 'expense' THEN 'out' ELSE 'in' END AS direction
       FROM transactions t LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND t.transaction_type IN ('income','expense','deposit')
        AND (t.reconciliation_id IS NULL OR t.reconciliation_id = $3::int)
     UNION ALL
     SELECT t.id, t.transaction_type, t.date, ABS(SUM(d.amount))::numeric(14,2), NULL, NULL, t.memo, NULL,
            BOOL_AND(d.reconciliation_id IS NOT NULL AND d.reconciliation_id = $3::int),
            CASE WHEN SUM(d.amount) >= 0 THEN 'in' ELSE 'out' END
       FROM transactions t JOIN transaction_details d ON d.transaction_id = t.id
      WHERE t.organization_id = $1 AND t.transaction_type IN ('journal', 'transfer') AND d.account_id = $2
        AND (d.reconciliation_id IS NULL OR d.reconciliation_id = $3::int)
      GROUP BY t.id
     HAVING SUM(d.amount) <> 0
      ORDER BY date, id`,
    [orgId, accountId, recId],
  );
  return rows;
}

/** Items cleared by a (completed) reconciliation, in the same shape as reconciliationCandidates. */
export async function reconciledItems(db, orgId, recId, accountId) {
  const { rows } = await db.query(
    `SELECT t.id, t.transaction_type, t.date, t.amount, t.check_number, t.ref_number, t.memo, c.name AS company_name, true AS cleared,
            CASE WHEN t.transaction_type = 'expense' THEN 'out' ELSE 'in' END AS direction
       FROM transactions t LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.reconciliation_id = $1 AND t.organization_id = $2
     UNION ALL
     SELECT t.id, t.transaction_type, t.date, ABS(SUM(d.amount))::numeric(14,2), NULL, NULL, t.memo, NULL, true,
            CASE WHEN SUM(d.amount) >= 0 THEN 'in' ELSE 'out' END
       FROM transactions t JOIN transaction_details d ON d.transaction_id = t.id
      WHERE d.reconciliation_id = $1 AND t.organization_id = $2 AND d.account_id = $3
      GROUP BY t.id
      ORDER BY date, id`,
    [recId, orgId, accountId],
  );
  return rows;
}

function adjustmentInput(src = {}, label) {
  const amount = toCents(src.amount);
  if (amount < 0) throw new HttpError(400, `${label} cannot be negative`);
  if (!amount) return { amount: 0, date: null, accountId: null, fundId: null };
  const accountId = idOrNull(src.accountId);
  if (!accountId) throw new HttpError(400, `Select an account for the ${label}`);
  return { amount, date: requireDate(src.date, `${label} date`), accountId, fundId: idOrNull(src.fundId) };
}

export async function saveReconciliation(db, ctx, body, id = null) {
  const { orgId, userId } = ctx;
  const accountId = idOrNull(body.accountId);
  if (!accountId) throw new HttpError(400, 'Bank Account is required');
  const statementDate = requireDate(body.statementDate, 'Statement Ending Date');
  const ending = toCents(body.statementEndingBalance);
  const sc = adjustmentInput(body.serviceCharge, 'Service Charge');
  const ie = adjustmentInput(body.interest, 'Interest Earned');
  const accts = await loadOwned(db, 'accounts', [accountId, sc.accountId, ie.accountId], orgId, 'account');
  const bank = accts[accountId];
  assertBankingAccount(bank, 'Bank Account');
  await loadOwned(db, 'funds', [sc.fundId, ie.fundId], orgId, 'fund');

  let recId = id;
  if (id) {
    const t = await loadTxn(db, orgId, id, 'reconciliation');
    const { rows } = await db.query('SELECT is_complete FROM reconciliations WHERE transaction_id = $1', [id]);
    if (rows[0]?.is_complete) throw new HttpError(409, 'This reconciliation is complete. Undo it before making changes.');
    if (t.account_id !== accountId) throw new HttpError(400, 'The bank account of a reconciliation cannot be changed');
  } else {
    const { rows } = await db.query(
      `SELECT t.id FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id
        WHERE t.organization_id = $1 AND t.account_id = $2 AND NOT r.is_complete`,
      [orgId, accountId],
    );
    if (rows.length) throw new HttpError(409, 'There is already a reconciliation in progress for this account. Open it to continue.');
  }
  const { rows: last } = await db.query(
    `SELECT MAX(r.statement_date) AS d FROM reconciliations r JOIN transactions t ON t.id = r.transaction_id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND r.is_complete AND t.id IS DISTINCT FROM $3`,
    [orgId, accountId, id],
  );
  if (last[0].d && statementDate < last[0].d) throw new HttpError(400, `Statement date must be on or after the last reconciled statement (${last[0].d})`);

  const beginning = await priorStatementBalance(db, orgId, accountId, id);
  if (id) {
    await db.query('UPDATE transactions SET date=$1, amount=$2, memo=$3, updated_at=now() WHERE id=$4', [statementDate, fromCents(ending), emptyToNull(body.memo), id]);
  } else {
    const { rows } = await db.query(
      `INSERT INTO transactions (organization_id, transaction_type, date, amount, account_id, memo, created_by_user_id)
       VALUES ($1,'reconciliation',$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, statementDate, fromCents(ending), accountId, emptyToNull(body.memo), userId],
    );
    recId = rows[0].id;
  }

  // Clear / unclear transactions.
  const candidates = await reconciliationCandidates(db, orgId, accountId, id);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const clearedIds = [...new Set((body.clearedIds || []).map(Number))];
  for (const cid of clearedIds) if (!byId.has(cid)) throw new HttpError(400, `Transaction ${cid} cannot be cleared in this reconciliation`);
  // Income/expense/deposit are cleared as a whole; journal entries only on their lines to this account.
  const txnIds = clearedIds.filter((cid) => !LINE_TYPES.includes(byId.get(cid).transaction_type));
  const journalIds = clearedIds.filter((cid) => LINE_TYPES.includes(byId.get(cid).transaction_type));
  await db.query('UPDATE transactions SET reconciliation_id = NULL WHERE reconciliation_id = $1 AND organization_id = $2', [recId, orgId]);
  if (txnIds.length) await db.query('UPDATE transactions SET reconciliation_id = $1 WHERE id = ANY($2::int[]) AND organization_id = $3', [recId, txnIds, orgId]);
  await db.query('UPDATE transaction_details SET reconciliation_id = NULL WHERE reconciliation_id = $1', [recId]);
  if (journalIds.length) {
    await db.query(
      `UPDATE transaction_details d SET reconciliation_id = $1 FROM transactions t
        WHERE t.id = d.transaction_id AND t.organization_id = $2 AND t.transaction_type IN ('journal', 'transfer') AND t.id = ANY($3::int[]) AND d.account_id = $4`,
      [recId, orgId, journalIds, accountId],
    );
  }

  // Totals
  let deposits = 0;
  let payments = 0;
  for (const cid of clearedIds) {
    const c = byId.get(cid);
    if (c.direction === 'out') payments += toCents(c.amount);
    else deposits += toCents(c.amount);
  }
  const sign = balanceSign(bank);
  const cleared = beginning + sign * (deposits - payments - sc.amount + ie.amount);
  const difference = cleared - ending;
  const complete = Boolean(body.complete);
  if (complete && difference !== 0) throw new HttpError(400, `The reconciliation cannot be completed until the Difference is $0.00 (currently ${fromCents(difference)})`);

  const recValues = [statementDate, fromCents(beginning), fromCents(ending), fromCents(sc.amount), sc.date, sc.accountId, sc.fundId,
    fromCents(ie.amount), ie.date, ie.accountId, ie.fundId, complete];
  if (id) {
    await db.query(
      `UPDATE reconciliations SET statement_date=$2, beginning_balance=$3, statement_ending_balance=$4, service_charge_amount=$5,
              service_charge_date=$6, service_charge_account_id=$7, service_charge_fund_id=$8, interest_amount=$9, interest_date=$10,
              interest_account_id=$11, interest_fund_id=$12, is_complete=$13, completed_at = CASE WHEN $13 THEN now() ELSE NULL END
        WHERE transaction_id=$1`,
      [recId, ...recValues],
    );
  } else {
    await db.query(
      `INSERT INTO reconciliations (transaction_id, statement_date, beginning_balance, statement_ending_balance, service_charge_amount,
              service_charge_date, service_charge_account_id, service_charge_fund_id, interest_amount, interest_date,
              interest_account_id, interest_fund_id, is_complete, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13 THEN now() ELSE NULL END)`,
      [recId, ...recValues],
    );
  }

  // A statement read on the reconciliation screen (undefined = leave as is, null = remove).
  if (body.statementExtract !== undefined) {
    const extract = cleanExtract(body.statementExtract);
    await db.query('UPDATE reconciliations SET statement_extract = $1 WHERE transaction_id = $2', [extract ? JSON.stringify(extract) : null, recId]);
  }

  // Service charge: Cr bank, Dr service charge account. Interest: Dr bank, Cr interest account.
  await deleteGl(db, recId, ['service_charge', 'interest']);
  if (sc.amount) {
    await writeGl(db, orgId, { date: sc.date, transactionId: recId, kind: 'service_charge', description: 'Bank service charge' }, [
      { accountId, fundId: sc.fundId, credit: sc.amount },
      { accountId: sc.accountId, fundId: sc.fundId, debit: sc.amount },
    ]);
  }
  if (ie.amount) {
    await writeGl(db, orgId, { date: ie.date, transactionId: recId, kind: 'interest', description: 'Interest earned' }, [
      { accountId, fundId: ie.fundId, debit: ie.amount },
      { accountId: ie.accountId, fundId: ie.fundId, credit: ie.amount },
    ]);
  }
  return recId;
}

async function latestCompletedRec(db, orgId, accountId) {
  const { rows } = await db.query(
    `SELECT t.id FROM reconciliations r JOIN transactions t ON t.id = r.transaction_id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND r.is_complete
      ORDER BY r.statement_date DESC, t.id DESC LIMIT 1`,
    [orgId, accountId],
  );
  return rows[0]?.id || null;
}

export async function undoReconciliation(db, orgId, id) {
  const t = await loadTxn(db, orgId, id, 'reconciliation');
  const { rows: [org] } = await db.query('SELECT period_closing_date FROM organizations WHERE id = $1', [orgId]);
  if (org.period_closing_date && t.date <= org.period_closing_date) {
    throw new HttpError(409, `This reconciliation is in a closed period (closed through ${org.period_closing_date}) and can't be undone.`);
  }
  if ((await latestCompletedRec(db, orgId, t.account_id)) !== id) throw new HttpError(409, 'Only the most recent completed reconciliation for an account can be undone');
  const { rows } = await db.query(
    `SELECT 1 FROM transactions t JOIN reconciliations r ON r.transaction_id = t.id
      WHERE t.organization_id = $1 AND t.account_id = $2 AND NOT r.is_complete`, [orgId, t.account_id]);
  if (rows.length) throw new HttpError(409, 'Delete the reconciliation in progress for this account first');
  await db.query('UPDATE reconciliations SET is_complete = false, completed_at = NULL WHERE transaction_id = $1', [id]);
}

export async function deleteReconciliation(db, orgId, id) {
  const t = await loadTxn(db, orgId, id, 'reconciliation');
  const { rows } = await db.query('SELECT is_complete FROM reconciliations WHERE transaction_id = $1', [id]);
  if (rows[0]?.is_complete) throw new HttpError(409, 'Undo the completed reconciliation before deleting it');
  await db.query('UPDATE transactions SET reconciliation_id = NULL WHERE reconciliation_id = $1 AND organization_id = $2', [id, orgId]);
  await db.query('UPDATE transaction_details SET reconciliation_id = NULL WHERE reconciliation_id = $1', [id]);
  await db.query('DELETE FROM transactions WHERE id = $1 AND organization_id = $2', [t.id, orgId]);
}

// ---------------------------------------------------------------------------
// Bank feed matching
// ---------------------------------------------------------------------------
/**
 * A transaction's effect on a bank account in cents (money in positive), or null if it doesn't touch the account.
 * Income/expense/deposit affect their header account; journal entries affect every account on their lines (net).
 */
async function bankEffect(db, txn, accountId) {
  if (LINE_TYPES.includes(txn.transaction_type)) {
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n, COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS net FROM transaction_details WHERE transaction_id = $1 AND account_id = $2',
      [txn.id, accountId]);
    return rows[0].n ? Number(rows[0].net) : null;
  }
  if (!['income', 'expense', 'deposit'].includes(txn.transaction_type) || txn.account_id !== accountId) return null;
  return txn.transaction_type === 'expense' ? -toCents(txn.amount) : toCents(txn.amount);
}

export async function matchFeedItem(db, orgId, feedId, transactionId) {
  const { rows } = await db.query('SELECT * FROM bank_feed_items WHERE id = $1 AND organization_id = $2 FOR UPDATE', [feedId, orgId]);
  const item = rows[0];
  if (!item) throw new HttpError(404, 'Bank feed item not found');
  const txn = await loadTxn(db, orgId, transactionId);
  const effect = await bankEffect(db, txn, item.account_id);
  if (effect === null) throw new HttpError(400, 'The transaction is for a different bank account than the bank feed item');
  if (effect !== toCents(item.amount)) throw new HttpError(400, 'The transaction amount does not match the bank feed item');
  // A journal entry can be matched once per bank account it touches (e.g. both sides of a transfer).
  const dup = await db.query(
    `SELECT 1 FROM bank_feed_items WHERE transaction_id = $1 AND id <> $2 AND ($3::boolean IS FALSE OR account_id = $4)`,
    [transactionId, feedId, LINE_TYPES.includes(txn.transaction_type), item.account_id]);
  if (dup.rows.length) throw new HttpError(409, 'That transaction is already matched to another bank feed item');
  await db.query(`UPDATE bank_feed_items SET status = 'matched', transaction_id = $1 WHERE id = $2`, [transactionId, feedId]);
}

/** After a transaction is edited, unmatch bank feed lines whose amount no longer equals its effect on their account. */
async function revalidateFeedMatches(db, orgId, transactionId) {
  const { rows: items } = await db.query('SELECT id, account_id, amount FROM bank_feed_items WHERE transaction_id = $1 AND organization_id = $2', [transactionId, orgId]);
  if (!items.length) return;
  const txn = await loadTxn(db, orgId, transactionId);
  for (const item of items) {
    if ((await bankEffect(db, txn, item.account_id)) !== toCents(item.amount)) {
      await db.query(`UPDATE bank_feed_items SET status = 'unmatched', transaction_id = NULL WHERE id = $1`, [item.id]);
    }
  }
}
