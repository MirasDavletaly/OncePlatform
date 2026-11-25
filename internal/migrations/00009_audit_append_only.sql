-- +goose Up
-- The audit log is append-only: the portal never changes or deletes an entry,
-- so the database refuses it too. Someone who gets the portal's database
-- access (an SQL injection, a stolen backup restored elsewhere does not
-- matter) cannot quietly rewrite history. Existing entries are untouched.
-- +goose StatementBegin
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- +goose Down
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP FUNCTION IF EXISTS audit_log_append_only();
