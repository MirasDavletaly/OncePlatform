-- +goose Up
-- CV section. Only new tables: existing tasks and data are not changed.
-- candidates hold personal data (CV file, its text, the parsed profile); they
-- are deleted for real (row and files) on the candidate's request.
CREATE TABLE candidates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number              integer GENERATED ALWAYS AS IDENTITY UNIQUE,
    full_name           text NOT NULL DEFAULT '' CHECK (char_length(full_name) <= 200),
    file_name           text NOT NULL,
    stored_name         text NOT NULL,
    mime                text NOT NULL,
    size                bigint NOT NULL,
    sha256              text NOT NULL UNIQUE,
    status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    error               text NOT NULL DEFAULT '',
    ocr                 boolean NOT NULL DEFAULT false,
    cv_text             text,
    profile             jsonb,
    consent_date        date NOT NULL,
    consent_note        text NOT NULL DEFAULT '' CHECK (char_length(consent_note) <= 1000),
    consent_file_name   text,
    consent_stored_name text,
    consent_mime        text,
    uploaded_by         uuid NOT NULL REFERENCES users (id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidates_pending_idx ON candidates (created_at) WHERE status = 'pending';

-- Key-personnel requirements of a task (roles), filled by Claude from the
-- specification or by the team; candidates are matched against them.
CREATE TABLE ticket_cv_requirements (
    ticket_id  uuid PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
    roles      jsonb NOT NULL DEFAULT '[]',
    updated_by uuid NOT NULL REFERENCES users (id),
    via        text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'mcp', 'system')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS ticket_cv_requirements;
DROP TABLE IF EXISTS candidates;
