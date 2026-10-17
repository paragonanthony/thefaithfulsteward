-- Live bank feeds through Stripe Financial Connections (replacing Plaid).
-- The old plaid_* tables are left in place (unused) so no data is lost; lines already imported stay in the bank feed.

-- Each organization is a Stripe customer: the account holder for the bank accounts it links.
ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT;

CREATE TABLE fc_accounts (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_account_id     TEXT NOT NULL UNIQUE,        -- fca_...
  institution_name      TEXT,
  display_name          TEXT,
  last4                 TEXT,
  category              TEXT,                        -- cash | credit | investment | other
  subcategory           TEXT,                        -- checking | savings | credit_card | ...
  status                TEXT NOT NULL DEFAULT 'active', -- active | inactive | disconnected (from Stripe)
  account_id            INTEGER REFERENCES accounts(id) ON DELETE SET NULL,  -- ledger account it feeds
  is_enabled            BOOLEAN NOT NULL DEFAULT false,
  sync_start_date       DATE,                        -- ignore bank transactions dated before this
  last_refresh_id       TEXT,                        -- latest transaction refresh already imported (incremental sync)
  last_synced_at        TIMESTAMPTZ,
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX fc_accounts_org_idx ON fc_accounts (organization_id);
-- A ledger account can be fed by only one enabled bank connection.
CREATE UNIQUE INDEX fc_accounts_ledger_uq ON fc_accounts (account_id) WHERE is_enabled AND account_id IS NOT NULL;
CREATE TRIGGER fc_accounts_audit BEFORE INSERT OR UPDATE ON fc_accounts FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

ALTER TABLE bank_feed_items DROP CONSTRAINT bank_feed_items_source_check;
ALTER TABLE bank_feed_items ADD CONSTRAINT bank_feed_items_source_check CHECK (source IN ('file', 'plaid', 'stripe'));
ALTER TABLE bank_feed_items ADD COLUMN fc_account_id INTEGER REFERENCES fc_accounts(id) ON DELETE SET NULL;
