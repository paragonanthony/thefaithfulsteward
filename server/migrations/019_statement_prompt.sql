-- A saved prompt for reading bank statements into the bank feed.
ALTER TABLE extraction_prompts DROP CONSTRAINT extraction_prompts_txn_type_check;
ALTER TABLE extraction_prompts ADD CONSTRAINT extraction_prompts_txn_type_check
  CHECK (txn_type IN ('income', 'expense', 'bill', 'transfer', 'journal', 'tuition', 'statement'));
