-- An administrator can require a user to choose a new password the next time they sign in.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
