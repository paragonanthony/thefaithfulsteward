-- General journal entries: a transaction whose lines carry explicit debits and credits.
ALTER TABLE transactions DROP CONSTRAINT transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IN ('income', 'expense', 'deposit', 'reconciliation', 'journal'));

-- Journal lines keep their debit and credit (amount = debit - credit for these lines).
ALTER TABLE transaction_details ADD COLUMN debit NUMERIC(14,2), ADD COLUMN credit NUMERIC(14,2);
