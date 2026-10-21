-- +goose Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Users, sessions, tokens
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL,
    email         text NOT NULL DEFAULT '',
    full_name     text NOT NULL,
    role          text NOT NULL CHECK (role IN ('admin', 'coordinator', 'analyst')),
    password_hash text NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    language      text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ru')),
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    ip           text NOT NULL DEFAULT '',
    user_agent   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    prefix       text NOT NULL,
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

-- ---------------------------------------------------------------------------
-- OAuth 2.1 authorization server (MCP authorization)
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_clients (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                  text NOT NULL UNIQUE,
    client_secret_hash         bytea,
    client_name                text NOT NULL,
    redirect_uris              text[] NOT NULL,
    grant_types                text[] NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    scope                      text NOT NULL DEFAULT '',
    client_uri                 text NOT NULL DEFAULT '',
    logo_uri                   text NOT NULL DEFAULT '',
    software_id                text NOT NULL DEFAULT '',
    software_version           text NOT NULL DEFAULT '',
    registration_ip            text NOT NULL DEFAULT '',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    last_used_at               timestamptz,
    revoked_at                 timestamptz
);

CREATE TABLE oauth_auth_codes (
    code_hash             bytea PRIMARY KEY,
    client_id             uuid NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    redirect_uri          text NOT NULL,
    scope                 text NOT NULL DEFAULT '',
    resource              text NOT NULL,
    code_challenge        text NOT NULL,
    code_challenge_method text NOT NULL,
    family_id             uuid,
    expires_at            timestamptz NOT NULL,
    used_at               timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_auth_codes_expires_idx ON oauth_auth_codes (expires_at);

CREATE TABLE oauth_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   bytea NOT NULL UNIQUE,
    kind         text NOT NULL CHECK (kind IN ('access', 'refresh')),
    family_id    uuid NOT NULL,
    client_id    uuid NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope        text NOT NULL DEFAULT '',
    resource     text NOT NULL,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    last_used_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_user_client_idx ON oauth_tokens (user_id, client_id);
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX oauth_tokens_expires_idx ON oauth_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------
CREATE TABLE ticket_counters (
    year       integer PRIMARY KEY,
    last_value integer NOT NULL
);

CREATE TABLE tickets (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number             text NOT NULL UNIQUE,
    type               text NOT NULL DEFAULT 'tender' CHECK (type IN ('tender', 'astana_hub', 'client_request', 'internal')),
    title              text NOT NULL,
    description        text NOT NULL DEFAULT '',
    platform           text NOT NULL DEFAULT '' CHECK (platform IN ('', 'goszakup', 'samruk', 'astana_hub', 'other')),
    tender_number      text NOT NULL DEFAULT '',
    source_url         text NOT NULL DEFAULT '',
    budget_amount      numeric(18, 2),
    currency           text NOT NULL DEFAULT 'KZT',
    deadline           timestamptz,
    priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'analysis', 'solution', 'sent', 'closed')),
    close_result       text NOT NULL DEFAULT '' CHECK (close_result IN ('', 'won', 'lost', 'cancelled', 'no_bid')),
    closed_at          timestamptz,
    assignee_id        uuid REFERENCES users (id),
    created_by         uuid NOT NULL REFERENCES users (id),
    tags               text[] NOT NULL DEFAULT '{}',
    technical_solution text NOT NULL DEFAULT '',
    search_vector      tsvector,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    CONSTRAINT tickets_close_result_chk CHECK ((status = 'closed') = (close_result <> ''))
);
CREATE INDEX tickets_search_idx ON tickets USING gin (search_vector);
CREATE INDEX tickets_title_trgm_idx ON tickets USING gin (title gin_trgm_ops);
CREATE INDEX tickets_description_trgm_idx ON tickets USING gin (description gin_trgm_ops);
CREATE INDEX tickets_tags_idx ON tickets USING gin (tags);
CREATE INDEX tickets_status_idx ON tickets (status) WHERE deleted_at IS NULL;
CREATE INDEX tickets_deadline_idx ON tickets (deadline) WHERE deleted_at IS NULL;
CREATE INDEX tickets_assignee_idx ON tickets (assignee_id);
CREATE INDEX tickets_created_idx ON tickets (created_at DESC);

-- +goose StatementBegin
CREATE FUNCTION tickets_search_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', coalesce(NEW.number, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.tender_number, '')), 'A') ||
        setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ')), 'B') ||
        setweight(to_tsvector('simple', left(coalesce(NEW.description, ''), 400000)), 'C') ||
        setweight(to_tsvector('simple', left(coalesce(NEW.technical_solution, ''), 400000)), 'D');
    RETURN NEW;
END
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER tickets_search_trg
    BEFORE INSERT OR UPDATE OF number, title, tender_number, tags, description, technical_solution
    ON tickets FOR EACH ROW EXECUTE FUNCTION tickets_search_update();

CREATE TABLE solution_versions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id  uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    body       text NOT NULL,
    author_id  uuid NOT NULL REFERENCES users (id),
    via        text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX solution_versions_ticket_idx ON solution_versions (ticket_id, created_at DESC);

CREATE TABLE ticket_status_history (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id    uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    from_status  text,
    to_status    text NOT NULL,
    close_result text NOT NULL DEFAULT '',
    changed_by   uuid NOT NULL REFERENCES users (id),
    comment      text NOT NULL DEFAULT '',
    via          text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_status_history_ticket_idx ON ticket_status_history (ticket_id, created_at);

CREATE TABLE comments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id     uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    author_id     uuid NOT NULL REFERENCES users (id),
    body          text NOT NULL,
    via           text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system')),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(body, 400000))) STORED,
    created_at    timestamptz NOT NULL DEFAULT now(),
    edited_at     timestamptz,
    deleted_at    timestamptz
);
CREATE INDEX comments_ticket_idx ON comments (ticket_id, created_at);
CREATE INDEX comments_search_idx ON comments USING gin (search_vector);
CREATE INDEX comments_body_trgm_idx ON comments USING gin (body gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id         uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    original_name     text NOT NULL,
    stored_name       text NOT NULL UNIQUE,
    mime              text NOT NULL,
    size              bigint NOT NULL,
    sha256            text NOT NULL,
    category          text NOT NULL DEFAULT 'other' CHECK (category IN ('tz', 'analysis', 'solution', 'proposal', 'other')),
    extracted_text    text,
    extraction_status text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'done', 'failed', 'unsupported')),
    extraction_error  text NOT NULL DEFAULT '',
    uploaded_by       uuid NOT NULL REFERENCES users (id),
    via               text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system')),
    search_vector     tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', original_name || ' ' || left(coalesce(extracted_text, ''), 400000))
    ) STORED,
    created_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz
);
CREATE INDEX attachments_ticket_idx ON attachments (ticket_id);
CREATE INDEX attachments_search_idx ON attachments USING gin (search_vector);
CREATE INDEX attachments_text_trgm_idx ON attachments USING gin (extracted_text gin_trgm_ops);
CREATE INDEX attachments_pending_idx ON attachments (created_at) WHERE extraction_status = 'pending';

-- ---------------------------------------------------------------------------
-- Notifications and audit
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type       text NOT NULL,
    ticket_id  uuid REFERENCES tickets (id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users (id),
    text       text NOT NULL,
    dedup_key  text,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedup_key ON notifications (user_id, dedup_key) WHERE dedup_key IS NOT NULL;

CREATE TABLE audit_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid REFERENCES users (id),
    action      text NOT NULL,
    entity_type text NOT NULL DEFAULT '',
    entity_id   uuid,
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    via         text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system')),
    ip          text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_ticket_idx ON audit_log ((details ->> 'ticket_id'), created_at);

-- +goose Down
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS ticket_status_history;
DROP TABLE IF EXISTS solution_versions;
DROP TRIGGER IF EXISTS tickets_search_trg ON tickets;
DROP FUNCTION IF EXISTS tickets_search_update();
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS ticket_counters;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_auth_codes;
DROP TABLE IF EXISTS oauth_clients;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
