-- Per-organization sending mailbox (Microsoft 365 via Microsoft Graph, delegated OAuth).
CREATE TABLE org_email_settings (
  organization_id       INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL CHECK (provider IN ('microsoft365')),
  account_email         TEXT NOT NULL,          -- the signed-in mailbox
  account_name          TEXT,
  tenant_id             TEXT,
  send_as               TEXT,                   -- optional shared mailbox to send from
  refresh_token_enc     TEXT NOT NULL,          -- AES-256-GCM encrypted
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect_required')),
  last_error            TEXT,
  connected_by_user_id  INTEGER REFERENCES users(id),
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
