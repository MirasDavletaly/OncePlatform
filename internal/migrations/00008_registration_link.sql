-- +goose Up
-- A shared registration link: whoever opens it creates their own account with
-- the recruiter role (the CV database only). One link at a time; the admin
-- replaces or disables it. Existing data is untouched.
CREATE TABLE registration_link (
    id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    token      text NOT NULL,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS registration_link;
