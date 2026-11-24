-- +goose Up
-- The recruiter role (the CV database only) and one-time invitation codes.
-- Existing users keep their data. A code is stored as its SHA-256 only; the
-- admin sees it once, the person signs in with it once and sets a password.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'coordinator', 'analyst', 'recruiter'));
ALTER TABLE users
    ADD COLUMN invite_hash       bytea,
    ADD COLUMN invite_expires_at timestamptz;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS invite_expires_at, DROP COLUMN IF EXISTS invite_hash;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'coordinator', 'analyst'));
