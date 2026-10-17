-- Once a reconciliation is completed, the total each cleared transaction posts to the reconciled bank account is
-- locked in the database: no edit, delete or other code path can change it (until the reconciliation is undone).
-- Edits that keep the total (memo, date, lines split differently, funds, other accounts) are still allowed.

-- The general-ledger total (debits - credits, in cents) of each cleared transaction on the reconciled account,
-- recorded when the reconciliation is completed. No foreign key to transactions: deleting a cleared transaction
-- must be caught by the check below, not silently remove its row here.
CREATE TABLE reconciled_totals (
  reconciliation_id  INTEGER NOT NULL REFERENCES reconciliations(transaction_id) ON DELETE CASCADE,
  transaction_id     INTEGER NOT NULL,
  account_id         INTEGER NOT NULL,
  net_cents          BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (reconciliation_id, transaction_id, account_id)
);
CREATE INDEX reconciled_totals_txn_idx ON reconciled_totals (transaction_id);
CREATE TRIGGER reconciled_totals_audit BEFORE INSERT OR UPDATE ON reconciled_totals FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

CREATE OR REPLACE FUNCTION gl_net_cents(txn integer, acct integer) RETURNS bigint AS $$
  SELECT COALESCE(SUM(ROUND(d.debit * 100) - ROUND(d.credit * 100)), 0)::bigint
    FROM gl_details d JOIN gl_headers h ON h.id = d.gl_header_id
   WHERE h.transaction_id = txn AND d.account_id = acct AND h.entry_kind = 'transaction'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION snapshot_reconciled_totals(rec integer) RETURNS void AS $$
DECLARE
  acct integer;
BEGIN
  SELECT account_id INTO acct FROM transactions WHERE id = rec;
  DELETE FROM reconciled_totals WHERE reconciliation_id = rec;
  INSERT INTO reconciled_totals (reconciliation_id, transaction_id, account_id, net_cents)
  SELECT rec, x.id, acct, gl_net_cents(x.id, acct)
    FROM (SELECT id FROM transactions WHERE reconciliation_id = rec
          UNION SELECT transaction_id FROM transaction_details WHERE reconciliation_id = rec AND account_id = acct) x;
END;
$$ LANGUAGE plpgsql;

-- Completing a reconciliation records the totals; undoing it releases them.
CREATE OR REPLACE FUNCTION track_reconciled_totals() RETURNS trigger AS $$
BEGIN
  IF NEW.is_complete AND (TG_OP = 'INSERT' OR NOT OLD.is_complete) THEN
    PERFORM snapshot_reconciled_totals(NEW.transaction_id);
  ELSIF TG_OP = 'UPDATE' AND OLD.is_complete AND NOT NEW.is_complete THEN
    DELETE FROM reconciled_totals WHERE reconciliation_id = NEW.transaction_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reconciliations_track_totals AFTER INSERT OR UPDATE OF is_complete ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION track_reconciled_totals();

-- Raises (HINT 'reconciled_locked', which the server turns into a friendly 409) if a cleared total changed.
CREATE OR REPLACE FUNCTION check_reconciled_total(txn integer) RETURNS void AS $$
DECLARE
  r record;
BEGIN
  IF txn IS NULL THEN RETURN; END IF;
  FOR r IN SELECT rt.account_id, rt.net_cents, a.name FROM reconciled_totals rt JOIN accounts a ON a.id = rt.account_id
            JOIN reconciliations rc ON rc.transaction_id = rt.reconciliation_id
           WHERE rt.transaction_id = txn AND rc.is_complete LOOP
    IF gl_net_cents(txn, r.account_id) <> r.net_cents THEN
      RAISE EXCEPTION USING
        MESSAGE = format('This transaction is cleared in a completed reconciliation of %s, so its total to that account (%s) can''t change and it can''t be deleted. Other details can still be edited; undo the reconciliation to change the amount.',
                         r.name, to_char(abs(r.net_cents) / 100.0, 'FM999,999,999,990.00')),
        HINT = 'reconciled_locked';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Checked at commit, after a save has replaced its ledger lines, so rewriting lines with the same total passes.
CREATE OR REPLACE FUNCTION enforce_reconciled_gl_headers() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM check_reconciled_total(OLD.transaction_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM check_reconciled_total(NEW.transaction_id); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER gl_headers_reconciled AFTER INSERT OR UPDATE OR DELETE ON gl_headers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_reconciled_gl_headers();

CREATE OR REPLACE FUNCTION enforce_reconciled_gl_details() RETURNS trigger AS $$
DECLARE
  txn integer;
BEGIN
  -- If the header was deleted too, its own trigger does the check.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT transaction_id INTO txn FROM gl_headers WHERE id = OLD.gl_header_id;
    PERFORM check_reconciled_total(txn);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT transaction_id INTO txn FROM gl_headers WHERE id = NEW.gl_header_id;
    PERFORM check_reconciled_total(txn);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER gl_details_reconciled AFTER INSERT OR UPDATE OR DELETE ON gl_details
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_reconciled_gl_details();

-- The amount and bank account on a cleared income, expense or deposit stay as reconciled too.
CREATE OR REPLACE FUNCTION enforce_reconciled_transactions() RETURNS trigger AS $$
BEGIN
  IF (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND OLD.transaction_type IN ('income', 'expense', 'deposit')
     AND EXISTS (SELECT 1 FROM reconciled_totals rt JOIN reconciliations rc ON rc.transaction_id = rt.reconciliation_id
                  WHERE rt.transaction_id = OLD.id AND rc.is_complete) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'This transaction is part of a completed reconciliation; its amount and bank account can''t be changed. Undo the reconciliation to change them.',
      HINT = 'reconciled_locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_reconciled BEFORE UPDATE OF amount, account_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_reconciled_transactions();

-- Reconciliations completed before this migration.
SELECT snapshot_reconciled_totals(transaction_id) FROM reconciliations WHERE is_complete;
