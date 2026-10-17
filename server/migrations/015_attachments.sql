-- File attachments (receipts, invoices, statements...) on income, expense, transfer and journal transactions
-- and on tuition records. Files are stored in the database so they survive redeploys (no persistent disk needed).
-- An attachment with neither owner is "pending": uploaded on a form that hasn't been saved yet.
CREATE TABLE attachments (
  id                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id      INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  tuition_id          INTEGER REFERENCES tuition_records(id) ON DELETE CASCADE,
  file_name           TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  data                BYTEA NOT NULL,
  extracted_at        TIMESTAMPTZ,          -- last time the data was extracted with Claude
  extraction          JSONB,                -- what was extracted (for reference)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (transaction_id IS NULL OR tuition_id IS NULL)
);
CREATE INDEX attachments_txn_idx ON attachments (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX attachments_tuition_idx ON attachments (tuition_id) WHERE tuition_id IS NOT NULL;
CREATE INDEX attachments_pending_idx ON attachments (organization_id, created_at) WHERE transaction_id IS NULL AND tuition_id IS NULL;

-- Saved instructions sent to Claude when extracting data from a document, one per transaction type.
CREATE TABLE extraction_prompts (
  id                  SERIAL PRIMARY KEY,
  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  txn_type            TEXT NOT NULL CHECK (txn_type IN ('income', 'expense', 'transfer', 'journal', 'tuition')),
  prompt              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, txn_type)
);

CREATE TRIGGER attachments_audit BEFORE INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
CREATE TRIGGER extraction_prompts_audit BEFORE INSERT OR UPDATE ON extraction_prompts FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
