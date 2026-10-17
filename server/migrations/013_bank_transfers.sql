-- Bank transfers: a transaction type with debit/credit lines like journal entries (one line per account).
ALTER TABLE transactions DROP CONSTRAINT transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IN ('income', 'expense', 'deposit', 'reconciliation', 'journal', 'transfer'));
