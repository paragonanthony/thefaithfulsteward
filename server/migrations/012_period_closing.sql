-- Period closing: no transaction dated on or before the organization's closing date may be added, changed or deleted.
ALTER TABLE organizations ADD COLUMN period_closing_date DATE;

CREATE TABLE period_closing_log (
  id                   SERIAL PRIMARY KEY,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  previous_date        DATE,
  closing_date         DATE,
  note                 TEXT,
  created_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX period_closing_log_org_idx ON period_closing_log (organization_id, created_at DESC);
CREATE TRIGGER period_closing_log_audit BEFORE INSERT OR UPDATE ON period_closing_log FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

-- Raises (HINT 'period_closed', which the server turns into a friendly 409) if either date is in the closed period.
CREATE OR REPLACE FUNCTION check_period_open(org integer, new_date date, old_date date) RETURNS void AS $$
DECLARE
  closed date;
BEGIN
  SELECT period_closing_date INTO closed FROM organizations WHERE id = org;
  IF closed IS NOT NULL AND ((new_date IS NOT NULL AND new_date <= closed) OR (old_date IS NOT NULL AND old_date <= closed)) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('The accounting period is closed through %s. Transactions dated on or before that date can''t be added, changed or deleted.',
                       to_char(closed, 'FMMonth FMDD, YYYY')),
      HINT = 'period_closed';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_period_closing_transactions() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM check_period_open(NEW.organization_id, NEW.date, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM check_period_open(OLD.organization_id, NULL, OLD.date);
    RETURN OLD;
  END IF;
  -- Changes that don't affect the books are always allowed: clearing in a reconciliation, import batch links, audit columns.
  IF NEW.date IS NOT DISTINCT FROM OLD.date AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id AND NEW.fund_id IS NOT DISTINCT FROM OLD.fund_id
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id AND NEW.memo IS NOT DISTINCT FROM OLD.memo
     AND NEW.check_number IS NOT DISTINCT FROM OLD.check_number AND NEW.ref_number IS NOT DISTINCT FROM OLD.ref_number
     AND NEW.transaction_method IS NOT DISTINCT FROM OLD.transaction_method AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type THEN
    RETURN NEW;
  END IF;
  PERFORM check_period_open(NEW.organization_id, NEW.date, OLD.date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every general-ledger posting (including deposits, service charges and interest) is covered here.
CREATE OR REPLACE FUNCTION enforce_period_closing_gl() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM check_period_open(NEW.organization_id, NEW.date, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM check_period_open(OLD.organization_id, NULL, OLD.date);
    RETURN OLD;
  END IF;
  PERFORM check_period_open(NEW.organization_id, NEW.date, OLD.date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_period_closing BEFORE INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_period_closing_transactions();
CREATE TRIGGER gl_headers_period_closing BEFORE INSERT OR UPDATE OR DELETE ON gl_headers
  FOR EACH ROW EXECUTE FUNCTION enforce_period_closing_gl();
