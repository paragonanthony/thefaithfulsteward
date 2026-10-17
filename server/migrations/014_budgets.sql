-- Budgets: named plans with a start and end date, either overall (all funds) or for one fund.
-- Amounts are entered per account per month in the account's normal-balance sign
-- (income and expense = activity for the month; balance sheet accounts = change in balance).
CREATE TABLE budgets (
  id                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  fund_id             INTEGER REFERENCES funds(id),  -- NULL = overall budget
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX budgets_org_name_idx ON budgets (organization_id, lower(name));

CREATE TABLE budget_lines (
  id                  SERIAL PRIMARY KEY,
  budget_id           INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month               DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),  -- first day of the month
  amount              NUMERIC(14,2) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (budget_id, account_id, month)
);

CREATE TRIGGER budgets_audit BEFORE INSERT OR UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
CREATE TRIGGER budget_lines_audit BEFORE INSERT OR UPDATE ON budget_lines FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
