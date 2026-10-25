-- +goose Up
-- Existing lost tasks remain unclassified; never guess a historical reason.
ALTER TABLE tickets ADD COLUMN loss_reason text NOT NULL DEFAULT ''
    CHECK (loss_reason IN ('', 'price', 'competitor', 'no_response', 'requirements'));
ALTER TABLE tickets ADD CONSTRAINT tickets_loss_reason_result_chk
    CHECK (loss_reason = '' OR (status = 'closed' AND close_result = 'lost'));
ALTER TABLE ticket_status_history ADD COLUMN loss_reason text NOT NULL DEFAULT ''
    CHECK (loss_reason IN ('', 'price', 'competitor', 'no_response', 'requirements'));

-- +goose Down
ALTER TABLE ticket_status_history DROP COLUMN loss_reason;
ALTER TABLE tickets DROP CONSTRAINT tickets_loss_reason_result_chk;
ALTER TABLE tickets DROP COLUMN loss_reason;
