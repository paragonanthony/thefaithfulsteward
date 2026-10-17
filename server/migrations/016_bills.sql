-- Bills (vendor invoices owed, posted to Accounts Payable) and bill payments.
ALTER TABLE transactions DROP CONSTRAINT transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IN ('income', 'expense', 'deposit', 'reconciliation', 'journal', 'transfer', 'bill'));

ALTER TABLE transactions ADD COLUMN due_date DATE;  -- bills only

-- A line of an expense can pay toward one bill (paid = sum of linked expense lines), like tuition payments on income.
ALTER TABLE transaction_details ADD COLUMN bill_id INTEGER REFERENCES transactions(id);
CREATE INDEX transaction_details_bill_idx ON transaction_details (bill_id) WHERE bill_id IS NOT NULL;

-- Accounts Payable is its own account type (a liability) so bills can only post to an A/P account.
-- Existing "Accounts Payable" current liability accounts become that type.
UPDATE accounts SET account_type = 'accounts_payable'
 WHERE account_type = 'current_liability' AND name ILIKE 'accounts payable%';
UPDATE account_groups SET account_type = 'accounts_payable'
 WHERE account_type = 'current_liability' AND name ILIKE 'accounts payable%';

-- Bills can have a saved extraction prompt too.
ALTER TABLE extraction_prompts DROP CONSTRAINT extraction_prompts_txn_type_check;
ALTER TABLE extraction_prompts ADD CONSTRAINT extraction_prompts_txn_type_check
  CHECK (txn_type IN ('income', 'expense', 'bill', 'transfer', 'journal', 'tuition'));
