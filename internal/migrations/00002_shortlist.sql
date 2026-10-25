-- +goose Up
ALTER TABLE tickets
    ADD COLUMN fit_score smallint CHECK (fit_score BETWEEN 1 AND 5),
    ADD COLUMN complexity smallint CHECK (complexity BETWEEN 1 AND 5),
    ADD COLUMN market text NOT NULL DEFAULT '' CHECK (char_length(market) <= 120),
    ADD COLUMN applications_count integer CHECK (applications_count >= 0),
    ADD COLUMN customer text NOT NULL DEFAULT '' CHECK (char_length(customer) <= 300);

-- Conservative normalization: retain scheme, path case, query and fragment.
-- Do not merge different task IDs carried in query strings or hash routes.
-- +goose StatementBegin
CREATE FUNCTION ticket_source_key(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    value text := btrim(raw);
    parts text[];
    authority text;
    host_part text;
    suffix text;
BEGIN
    IF value = '' THEN RETURN ''; END IF;
    IF position('://' IN value) = 0 THEN value := 'https://' || value; END IF;
    parts := regexp_match(value, '^(https?)://([^/?#]+)(.*)$', 'i');
    IF parts IS NULL THEN RETURN value; END IF;
    -- Userinfo, if present in a legacy link, can be case-sensitive.
    host_part := regexp_replace(parts[2], '^.*@', '');
    authority := left(parts[2], char_length(parts[2]) - char_length(host_part)) || lower(host_part);
    IF lower(parts[1]) = 'https' THEN
        authority := regexp_replace(authority, ':443$', '');
    ELSE
        authority := regexp_replace(authority, ':80$', '');
    END IF;
    suffix := parts[3];
    -- An absent root path and '/' denote the same URL.
    IF suffix = '' OR left(suffix, 1) IN ('?', '#') THEN suffix := '/' || suffix; END IF;
    RETURN lower(parts[1]) || '://' || authority || suffix;
END;
$$;
-- +goose StatementEnd

ALTER TABLE tickets ADD COLUMN source_url_key text
    GENERATED ALWAYS AS (ticket_source_key(source_url)) STORED;
CREATE INDEX tickets_source_url_key_idx ON tickets (source_url_key)
    WHERE deleted_at IS NULL AND source_url_key <> '';
CREATE INDEX tickets_shortlist_idx ON tickets (fit_score DESC, applications_count, deadline)
    WHERE deleted_at IS NULL;

-- A unique reservation serializes concurrent writes. Reference counts preserve
-- pre-existing duplicates without deleting records or blocking the migration.
CREATE TABLE ticket_source_claims (
    source_key text PRIMARY KEY,
    references_count integer NOT NULL CHECK (references_count >= 0)
);
INSERT INTO ticket_source_claims (source_key, references_count)
SELECT source_url_key, count(*) FROM tickets
WHERE deleted_at IS NULL AND source_url_key <> '' GROUP BY source_url_key;

-- +goose StatementBegin
CREATE FUNCTION tickets_claim_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    old_key text := '';
    new_key text := '';
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.deleted_at IS NULL THEN
        old_key := ticket_source_key(OLD.source_url);
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL THEN
        new_key := ticket_source_key(NEW.source_url);
    END IF;
    IF new_key IS DISTINCT FROM old_key THEN
        IF new_key <> '' THEN
            -- The primary key, not a SELECT-before-INSERT check, prevents races.
            INSERT INTO ticket_source_claims VALUES (new_key, 1);
        END IF;
        IF old_key <> '' THEN
            UPDATE ticket_source_claims SET references_count = references_count - 1
            WHERE source_key = old_key;
            DELETE FROM ticket_source_claims WHERE source_key = old_key AND references_count = 0;
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER tickets_claim_source_trg
    BEFORE INSERT OR UPDATE OF source_url, deleted_at OR DELETE ON tickets
    FOR EACH ROW EXECUTE FUNCTION tickets_claim_source();

-- +goose Down
DROP TRIGGER IF EXISTS tickets_claim_source_trg ON tickets;
DROP FUNCTION IF EXISTS tickets_claim_source();
DROP TABLE IF EXISTS ticket_source_claims;
DROP INDEX IF EXISTS tickets_shortlist_idx;
ALTER TABLE tickets DROP COLUMN source_url_key;
DROP FUNCTION IF EXISTS ticket_source_key(text);
ALTER TABLE tickets DROP COLUMN fit_score, DROP COLUMN complexity, DROP COLUMN market,
    DROP COLUMN applications_count, DROP COLUMN customer;
