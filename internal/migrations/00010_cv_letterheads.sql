-- +goose Up
-- Company letterheads of the standard CV (Word export): the lines under the logo
-- and the footer, edited by an administrator; the logos are part of the build.
-- Existing data is untouched.
CREATE TABLE cv_letterheads (
    id         text PRIMARY KEY CHECK (id IN ('knt', 'gs')),
    sort       smallint NOT NULL,
    name       text NOT NULL,
    header     text NOT NULL DEFAULT '',
    footer     text NOT NULL DEFAULT '',
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at timestamptz
);
INSERT INTO cv_letterheads (id, sort, name) VALUES
    ('knt', 1, 'Kazakhstan New Technologies'),
    ('gs', 2, 'Green Spark');

-- +goose Down
DROP TABLE IF EXISTS cv_letterheads;
