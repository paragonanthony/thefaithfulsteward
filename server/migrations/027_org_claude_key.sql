-- Each organization uses its own Claude (Anthropic) API key for Fill from document, statement reading and Auto Classify,
-- instead of one key for the whole server. Kept in its own table (not on organizations) so it is never returned with
-- organization records; the key itself is encrypted with ENCRYPTION_KEY (see server/crypto.js).
CREATE TABLE organization_claude_keys (
  organization_id       INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_enc           TEXT NOT NULL,
  key_hint              TEXT,                          -- last few characters, shown in settings
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TRIGGER organization_claude_keys_audit BEFORE INSERT OR UPDATE ON organization_claude_keys FOR EACH ROW EXECUTE FUNCTION set_audit_fields();
