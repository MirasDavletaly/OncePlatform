-- +goose Up
-- Two new columns of candidates; existing rows keep their data.
-- referred_by: who recommended the candidate (a person's name: cv.manage only).
-- translations: the profile's texts translated by Claude through MCP, per
-- language: {"en": {"source": <hash of the texts>, "texts": {...}, "at": ...}}.
ALTER TABLE candidates
    ADD COLUMN referred_by  text NOT NULL DEFAULT '' CHECK (char_length(referred_by) <= 200),
    ADD COLUMN translations jsonb;

-- +goose Down
ALTER TABLE candidates DROP COLUMN IF EXISTS translations, DROP COLUMN IF EXISTS referred_by;
