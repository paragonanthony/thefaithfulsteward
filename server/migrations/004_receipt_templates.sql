-- Customizable income / donation receipts.
CREATE TABLE receipt_templates (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  template         JSONB NOT NULL,
  is_default       BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipt_templates_org_idx ON receipt_templates (organization_id);
CREATE UNIQUE INDEX receipt_templates_default_uq ON receipt_templates (organization_id) WHERE is_default;
