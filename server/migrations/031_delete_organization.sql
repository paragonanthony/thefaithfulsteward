-- Deleting an organization removes all of its data (every organization table cascades from organizations).
-- The period-closing and reconciled-total checks would refuse to delete locked transactions, so they stand aside
-- only while that one organization is being deleted: the delete sets app.deleting_organization for its own
-- transaction (SET LOCAL), and nothing else does.
CREATE OR REPLACE FUNCTION check_period_open(org integer, new_date date, old_date date) RETURNS void AS $$
DECLARE
  closed date;
BEGIN
  IF current_setting('app.deleting_organization', true) = org::text THEN RETURN; END IF;
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
