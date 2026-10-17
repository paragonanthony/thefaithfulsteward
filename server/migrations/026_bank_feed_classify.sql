-- Auto Classify on the Bank Feed: Claude suggests a customer / vendor and account for unassigned lines.
-- Its instructions are an organization prompt like the document extraction prompts.
ALTER TABLE extraction_prompts DROP CONSTRAINT extraction_prompts_txn_type_check;
ALTER TABLE extraction_prompts ADD CONSTRAINT extraction_prompts_txn_type_check
  CHECK (txn_type IN ('income', 'expense', 'bill', 'transfer', 'journal', 'tuition', 'statement', 'classify'));

-- 'claude' = set by Auto Classify (kept when rules change, like a choice made by hand)
ALTER TABLE bank_feed_items DROP CONSTRAINT bank_feed_items_assigned_by_check;
ALTER TABLE bank_feed_items ADD CONSTRAINT bank_feed_items_assigned_by_check CHECK (assigned_by IN ('user', 'rule', 'claude'));
-- Why Claude chose it (shown on the line)
ALTER TABLE bank_feed_items ADD COLUMN assign_note TEXT;
