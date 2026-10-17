-- Restoring an organization from a backup file writes its records back exactly as they were: dates in a closed
-- period, completed reconciliations, and who created or last changed each record and when. While a restore runs it
-- sets app.restoring_organization for its own transaction (SET LOCAL), and nothing else does. The period-closing and
-- reconciled-total checks stand aside, and the audit trigger keeps the backup's created/updated values. The restore
-- checks the ledger itself (every entry balances) and records the reconciled totals again before it commits.
CREATE OR REPLACE FUNCTION set_audit_fields() RETURNS trigger AS $$
DECLARE
  uid integer := NULLIF(current_setting('app.user_id', true), '')::integer;
BEGIN
  IF coalesce(current_setting('app.restoring_organization', true), '') <> '' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.created_at := OLD.created_at;
      NEW.created_by_user_id := OLD.created_by_user_id;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by_user_id := COALESCE(uid, NEW.created_by_user_id);
    NEW.updated_at := NEW.created_at;
    NEW.updated_by_user_id := NEW.created_by_user_id;
  ELSE
    -- "Created" can never be changed; "Last updated" is always the current user and time.
    NEW.created_at := OLD.created_at;
    NEW.created_by_user_id := OLD.created_by_user_id;
    NEW.updated_at := now();
    NEW.updated_by_user_id := uid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_period_open(org integer, new_date date, old_date date) RETURNS void AS $$
DECLARE
  closed date;
BEGIN
  IF current_setting('app.deleting_organization', true) = org::text THEN RETURN; END IF;
  IF current_setting('app.restoring_organization', true) = org::text THEN RETURN; END IF;
  SELECT period_closing_date INTO closed FROM organizations WHERE id = org;
  IF closed IS NOT NULL AND ((new_date IS NOT NULL AND new_date <= closed) OR (old_date IS NOT NULL AND old_date <= closed)) THEN
    RAISE EXCEPTION USING
      MESSAGE = format('The accounting period is closed through %s. Transactions dated on or before that date can''t be added, changed or deleted.',
                       to_char(closed, 'FMMonth FMDD, YYYY')),
      HINT = 'period_closed';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_reconciled_total(txn integer) RETURNS void AS $$
DECLARE
  r record;
BEGIN
  IF txn IS NULL THEN RETURN; END IF;
  -- A restore only touches the one organization, and records the reconciled totals again from the restored ledger.
  IF coalesce(current_setting('app.restoring_organization', true), '') <> '' THEN RETURN; END IF;
  -- An organization being deleted: its transactions go with it (they may already be gone when this runs at commit).
  IF coalesce(current_setting('app.deleting_organization', true), '') <> ''
     AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = txn AND t.organization_id::text <> current_setting('app.deleting_organization', true)) THEN
    RETURN;
  END IF;
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
