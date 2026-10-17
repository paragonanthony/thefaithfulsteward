-- QuickBooks Online import: one connection per organization, links from QuickBooks records to records here
-- (so an import can be re-run without duplicates), and import runs (progress, results, undo).
CREATE TABLE qbo_connections (
  organization_id       INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  realm_id              TEXT NOT NULL,         -- QuickBooks company id
  company_name          TEXT,
  environment           TEXT NOT NULL,         -- sandbox | production
  refresh_token_enc     TEXT NOT NULL,         -- encrypted with ENCRYPTION_KEY
  refresh_expires_at    TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect_required')),
  last_error            TEXT,
  connected_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE qbo_imports (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  realm_id              TEXT NOT NULL,
  company_name          TEXT,
  status                TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'undone')),
  options               JSONB NOT NULL DEFAULT '{}',
  progress              JSONB NOT NULL DEFAULT '{}',
  summary               JSONB NOT NULL DEFAULT '{}',
  errors                JSONB NOT NULL DEFAULT '[]',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  undone_at             TIMESTAMPTZ,
  undone_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX qbo_imports_org_idx ON qbo_imports (organization_id, started_at DESC);
CREATE UNIQUE INDEX qbo_imports_running_uq ON qbo_imports (organization_id) WHERE status = 'running';

-- qbo_type: Customer, Vendor, Account, Class, Department, or a transaction entity (Purchase, Bill, Deposit...).
-- local_type: company | account | fund | transaction. `created` = the import created the local record (undo removes it);
-- false = it was matched to a record that already existed.
CREATE TABLE qbo_links (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  realm_id              TEXT NOT NULL,
  qbo_type              TEXT NOT NULL,
  qbo_id                TEXT NOT NULL,
  local_type            TEXT NOT NULL CHECK (local_type IN ('company', 'account', 'fund', 'transaction')),
  local_id              INTEGER NOT NULL,
  created               BOOLEAN NOT NULL DEFAULT false,
  import_id             INTEGER REFERENCES qbo_imports(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, realm_id, qbo_type, qbo_id)
);
CREATE INDEX qbo_links_local_idx ON qbo_links (local_type, local_id);
CREATE INDEX qbo_links_import_idx ON qbo_links (import_id);

CREATE TRIGGER qbo_connections_audit BEFORE INSERT OR UPDATE ON qbo_connections FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
CREATE TRIGGER qbo_imports_audit BEFORE INSERT OR UPDATE ON qbo_imports FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
CREATE TRIGGER qbo_links_audit BEFORE INSERT OR UPDATE ON qbo_links FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
