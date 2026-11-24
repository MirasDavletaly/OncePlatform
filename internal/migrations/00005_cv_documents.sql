-- +goose Up
-- Diplomas and certificates of candidates. Only a new table: existing data is
-- not changed. Personal data like the CVs: a document is recognised, its holder
-- is looked up among the candidates and, when found unambiguously, it is
-- attached to that candidate; documents left without a candidate are deleted
-- after 30 days, and a candidate's documents are deleted with the candidate.
CREATE TABLE candidate_documents (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id uuid REFERENCES candidates (id) ON DELETE CASCADE,
    file_name    text NOT NULL,
    stored_name  text NOT NULL,
    mime         text NOT NULL,
    size         bigint NOT NULL,
    sha256       text NOT NULL UNIQUE,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    error        text NOT NULL DEFAULT '',
    ocr          boolean NOT NULL DEFAULT false,
    doc_text     text,
    info         jsonb,
    assigned     text NOT NULL DEFAULT '' CHECK (assigned IN ('', 'auto', 'manual')),
    uploaded_by  uuid NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidate_documents_candidate_idx ON candidate_documents (candidate_id);
CREATE INDEX candidate_documents_pending_idx ON candidate_documents (created_at) WHERE status = 'pending';

-- +goose Down
DROP TABLE IF EXISTS candidate_documents;
