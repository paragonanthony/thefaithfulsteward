-- Optional tuition tracking: amounts owed by customers, paid down by linked income lines.
ALTER TABLE organizations ADD COLUMN tuition_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE tuition_records (
  id                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id          INTEGER NOT NULL REFERENCES companies(id),
  date                DATE NOT NULL,
  description         TEXT,
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  income_account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,  -- default account when receiving payment
  fund_id             INTEGER REFERENCES funds(id) ON DELETE SET NULL,
  memo                TEXT,
  created_by_user_id  INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tuition_records_org_idx ON tuition_records (organization_id, company_id);

-- An income detail line can pay toward one tuition record (paid = sum of linked lines).
ALTER TABLE transaction_details ADD COLUMN tuition_id INTEGER REFERENCES tuition_records(id);
CREATE INDEX transaction_details_tuition_idx ON transaction_details (tuition_id);
