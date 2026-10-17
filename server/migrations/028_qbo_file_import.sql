-- QuickBooks Online export import (Journal, contact lists and reports exported to Excel / CSV).
-- import_key identifies a transaction from an export, so importing the same export again skips it.
ALTER TABLE transactions ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX transactions_import_key_uq ON transactions (organization_id, import_key) WHERE import_key IS NOT NULL;

-- What kind of import a batch was, and the accounts it created (removed on undo if unused).
ALTER TABLE import_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'transactions';
ALTER TABLE import_batches ADD COLUMN created_account_ids INTEGER[] NOT NULL DEFAULT '{}';
