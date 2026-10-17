-- Whether a user may use the API and MCP server (with their own sign-in). Off unless an administrator turns it on;
-- their web sign-in is not affected. Existing API / MCP sign-ins end until access is turned on.
ALTER TABLE users ADD COLUMN api_access BOOLEAN NOT NULL DEFAULT false;
UPDATE oauth_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
