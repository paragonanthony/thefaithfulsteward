-- Audit fields on every application table: created_by_user_id, created_at, updated_by_user_id, updated_at.
-- A trigger fills them in. The current user comes from the transaction-local setting app.user_id, which the
-- server sets for each request's writes (no user = system / background job).

CREATE OR REPLACE FUNCTION set_audit_fields() RETURNS trigger AS $$
DECLARE
  uid integer := NULLIF(current_setting('app.user_id', true), '')::integer;
BEGIN
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

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'organizations', 'users', 'user_organizations', 'funds', 'account_groups', 'accounts', 'companies',
    'transactions', 'transaction_details', 'reconciliations', 'gl_headers', 'gl_details', 'bank_feed_items',
    'report_definitions', 'plaid_items', 'plaid_accounts', 'check_formats', 'receipt_templates', 'receipt_emails',
    'org_email_settings', 'tuition_records', 'import_batches'
  ];
  has_updated_at boolean;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'updated_at')
      INTO has_updated_at;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL', t);
    -- Existing rows: "last updated" starts out equal to "created" where the table had no updated_at before.
    IF NOT has_updated_at THEN
      EXECUTE format('UPDATE %I SET updated_at = created_at, updated_by_user_id = created_by_user_id', t);
    ELSE
      EXECUTE format('UPDATE %I SET updated_by_user_id = created_by_user_id WHERE updated_by_user_id IS NULL', t);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_audit', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_audit_fields()', t || '_audit', t);
  END LOOP;
END $$;

-- Rows that already recorded who created them in another column.
UPDATE org_email_settings SET created_by_user_id = connected_by_user_id, updated_by_user_id = connected_by_user_id WHERE created_by_user_id IS NULL;
UPDATE receipt_emails SET created_by_user_id = sent_by_user_id, updated_by_user_id = sent_by_user_id WHERE created_by_user_id IS NULL;
