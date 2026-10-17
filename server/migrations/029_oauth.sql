-- API and MCP access with the user's own sign-in (OAuth 2.1 with PKCE). A token acts as its user: the same
-- organizations, roles and permissions as their web sign-in. Codes and tokens are stored only as SHA-256 hashes.

-- Apps that asked to connect (MCP clients register themselves; "api" is the built-in client for password sign-in).
CREATE TABLE oauth_clients (
  id                    SERIAL PRIMARY KEY,
  client_id             TEXT NOT NULL UNIQUE,
  client_name           TEXT NOT NULL,
  redirect_uris         TEXT[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TRIGGER oauth_clients_audit BEFORE INSERT OR UPDATE ON oauth_clients FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

-- One-time authorization codes (10 minutes), issued after the user signs in and approves the app.
CREATE TABLE oauth_codes (
  id                    SERIAL PRIMARY KEY,
  code_hash             TEXT NOT NULL UNIQUE,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  resource              TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TRIGGER oauth_codes_audit BEFORE INSERT OR UPDATE ON oauth_codes FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

-- Access tokens (1 hour) and refresh tokens (30 days, replaced on every use; reusing an old one ends the grant).
CREATE TABLE oauth_tokens (
  id                    SERIAL PRIMARY KEY,
  token_hash            TEXT NOT NULL UNIQUE,
  kind                  TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id              TEXT NOT NULL,             -- all tokens from one sign-in share this; revoking it ends them all
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX oauth_tokens_user_idx ON oauth_tokens (user_id, client_id);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE TRIGGER oauth_tokens_audit BEFORE INSERT OR UPDATE ON oauth_tokens FOR EACH ROW EXECUTE FUNCTION set_audit_fields();

INSERT INTO oauth_clients (client_id, client_name) VALUES ('api', 'API (password sign-in)');
