-- Bank feed lines can carry a customer / vendor and an account, chosen on the Bank Feed or set by a rule. They become
-- the defaults when a transaction is created from the line.

CREATE TABLE bank_feed_rules (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT,
  match_text            TEXT NOT NULL,               -- the bank description contains this (ignoring case)
  direction             TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'in', 'out')),
  min_amount            NUMERIC(14,2) CHECK (min_amount IS NULL OR min_amount >= 0),  -- amount (ignoring sign) is at least this
  max_amount            NUMERIC(14,2) CHECK (max_amount IS NULL OR max_amount > 0),   -- ... and less than this
  bank_account_id       INTEGER REFERENCES accounts(id) ON DELETE CASCADE,            -- only lines on this bank account (null = any)
  company_id            INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  account_id            INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,  -- the first matching rule (lowest) wins
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (min_amount IS NULL OR max_amount IS NULL OR max_amount > min_amount)
);
CREATE INDEX bank_feed_rules_org_idx ON bank_feed_rules (organization_id, sort_order);
CREATE TRIGGER bank_feed_rules_audit BEFORE INSERT OR UPDATE ON bank_feed_rules FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

ALTER TABLE bank_feed_items ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE bank_feed_items ADD COLUMN assigned_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
-- 'user' = chosen on the Bank Feed (rules leave it alone); 'rule' = set by rule_id (redone when rules change)
ALTER TABLE bank_feed_items ADD COLUMN assigned_by TEXT CHECK (assigned_by IN ('user', 'rule'));
ALTER TABLE bank_feed_items ADD COLUMN rule_id INTEGER REFERENCES bank_feed_rules(id) ON DELETE SET NULL;
