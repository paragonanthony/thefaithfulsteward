-- Customizable check print layouts.
CREATE TABLE check_formats (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  layout           JSONB NOT NULL,
  is_default       BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX check_formats_org_idx ON check_formats (organization_id);
CREATE UNIQUE INDEX check_formats_default_uq ON check_formats (organization_id) WHERE is_default;

-- A bank account can use a specific format (e.g. different check stock per bank); otherwise the default is used.
ALTER TABLE accounts ADD COLUMN check_format_id INTEGER REFERENCES check_formats(id) ON DELETE SET NULL;
