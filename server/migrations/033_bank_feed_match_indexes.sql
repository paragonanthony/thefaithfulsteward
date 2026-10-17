-- Bank feed match suggestions look up which transactions a feed line already matches, and journal entries / transfers
-- by the bank account on their lines. Neither column had an index, so a long feed scanned both tables for every candidate.
CREATE INDEX IF NOT EXISTS bank_feed_items_txn_idx ON bank_feed_items (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transaction_details_account_idx ON transaction_details (account_id);
