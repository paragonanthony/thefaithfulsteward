-- Transaction imports from CSV / Excel, kept as batches so an import can be undone.
CREATE TABLE import_batches (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_name             TEXT,
  row_count             INTEGER NOT NULL DEFAULT 0,
  created_company_ids   INTEGER[] NOT NULL DEFAULT '{}',   -- customers/vendors the import created
  created_by_user_id    INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at             TIMESTAMPTZ,
  undone_by_user_id     INTEGER REFERENCES users(id)
);
CREATE INDEX import_batches_org_idx ON import_batches (organization_id, created_at DESC);

ALTER TABLE transactions ADD COLUMN import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL;
CREATE INDEX transactions_import_batch_idx ON transactions (import_batch_id);
