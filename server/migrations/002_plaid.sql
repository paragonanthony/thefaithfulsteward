-- Live bank feeds through Plaid.

-- One row per bank login ("Item" in Plaid's terms) connected by an organization.
CREATE TABLE plaid_items (
  id                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plaid_item_id       TEXT NOT NULL UNIQUE,
  access_token_enc    TEXT NOT NULL,          -- AES-256-GCM encrypted; never sent to the browser
  institution_id      TEXT,
  institution_name    TEXT,
  sync_cursor         TEXT,                   -- /transactions/sync cursor; NULL = sync from the beginning
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'login_required', 'error')),
  error_code          TEXT,
  error_message       TEXT,
  last_synced_at      TIMESTAMPTZ,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plaid_items_org_idx ON plaid_items (organization_id);

-- Accounts within a Plaid item, and which ledger bank account (if any) each one feeds.
CREATE TABLE plaid_accounts (
  id                SERIAL PRIMARY KEY,
  organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plaid_item_id     INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  plaid_account_id  TEXT NOT NULL UNIQUE,
  name              TEXT,
  official_name     TEXT,
  mask              TEXT,
  type              TEXT,
  subtype           TEXT,
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  sync_start_date   DATE                      -- ignore bank transactions dated before this
);
CREATE INDEX plaid_accounts_item_idx ON plaid_accounts (plaid_item_id);
-- A ledger account can be fed by only one enabled bank connection.
CREATE UNIQUE INDEX plaid_accounts_ledger_uq ON plaid_accounts (account_id) WHERE is_enabled AND account_id IS NOT NULL;

ALTER TABLE bank_feed_items
  ADD COLUMN source TEXT NOT NULL DEFAULT 'file' CHECK (source IN ('file', 'plaid')),
  ADD COLUMN plaid_account_id INTEGER REFERENCES plaid_accounts(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX bank_feed_items_external_uq ON bank_feed_items (account_id, external_id) WHERE external_id IS NOT NULL;
