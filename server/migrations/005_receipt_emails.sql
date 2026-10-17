-- Log of receipts emailed to donors.
CREATE TABLE receipt_emails (
  id                   SERIAL PRIMARY KEY,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id       INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  receipt_template_id  INTEGER REFERENCES receipt_templates(id) ON DELETE SET NULL,
  to_email             TEXT NOT NULL,
  subject              TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error                TEXT,
  provider_message_id  TEXT,
  sent_by_user_id      INTEGER REFERENCES users(id),
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipt_emails_txn_idx ON receipt_emails (transaction_id);
CREATE INDEX receipt_emails_org_sent_idx ON receipt_emails (organization_id, sent_at);
