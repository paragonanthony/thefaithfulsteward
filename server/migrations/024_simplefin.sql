-- Live bank feeds through SimpleFIN (replacing Stripe Financial Connections).
-- The old fc_accounts table is left in place (unused) so no data is lost; lines already imported stay in the bank feed.

-- A SimpleFIN connection: the organization's access URL (it holds the credentials, so it is stored encrypted).
-- One access URL can cover several banks; an organization can add more than one.
CREATE TABLE simplefin_connections (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label                 TEXT,
  access_url_enc        TEXT NOT NULL,               -- AES-256-GCM (see server/crypto.js)
  server_host           TEXT NOT NULL,               -- e.g. beta-bridge.simplefin.org (shown; the URL itself never leaves the server)
  last_synced_at        TIMESTAMPTZ,
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX simplefin_connections_org_idx ON simplefin_connections (organization_id);
CREATE TRIGGER simplefin_connections_audit BEFORE INSERT OR UPDATE ON simplefin_connections FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

CREATE TABLE simplefin_accounts (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id         INTEGER NOT NULL REFERENCES simplefin_connections(id) ON DELETE CASCADE,
  simplefin_account_id  TEXT NOT NULL,               -- the account id SimpleFIN reports
  institution_name      TEXT,
  name                  TEXT,
  currency              TEXT,
  balance               NUMERIC(14,2),
  balance_date          TIMESTAMPTZ,
  account_id            INTEGER REFERENCES accounts(id) ON DELETE SET NULL,  -- ledger account it feeds
  is_enabled            BOOLEAN NOT NULL DEFAULT false,
  sync_start_date       DATE,                        -- ignore bank transactions dated before this
  last_synced_at        TIMESTAMPTZ,
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (connection_id, simplefin_account_id)
);
CREATE INDEX simplefin_accounts_org_idx ON simplefin_accounts (organization_id);
-- A ledger account can be fed by only one enabled bank connection.
CREATE UNIQUE INDEX simplefin_accounts_ledger_uq ON simplefin_accounts (account_id) WHERE is_enabled AND account_id IS NOT NULL;
CREATE TRIGGER simplefin_accounts_audit BEFORE INSERT OR UPDATE ON simplefin_accounts FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

ALTER TABLE bank_feed_items DROP CONSTRAINT bank_feed_items_source_check;
ALTER TABLE bank_feed_items ADD CONSTRAINT bank_feed_items_source_check CHECK (source IN ('file', 'plaid', 'stripe', 'simplefin'));
ALTER TABLE bank_feed_items ADD COLUMN simplefin_account_id INTEGER REFERENCES simplefin_accounts(id) ON DELETE SET NULL;
