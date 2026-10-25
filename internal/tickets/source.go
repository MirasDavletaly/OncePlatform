package tickets

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"onceplatform/internal/apperr"
	"onceplatform/internal/db"
)

type DuplicateTicket struct {
	ID     string `json:"id"`
	Number string `json:"number"`
	Title  string `json:"title"`
}

// FindSource is advisory for the form; the database trigger is authoritative.
func (s *Service) FindSource(ctx context.Context, source, exclude string) (*DuplicateTicket, error) {
	source, err := normalizeURL(source)
	if err != nil {
		return nil, err
	}
	if source == "" {
		return nil, nil
	}
	if exclude != "" && !db.IsUUID(exclude) {
		return nil, apperr.Validation("Invalid excluded task id")
	}
	var found DuplicateTicket
	err = s.pool.QueryRow(ctx, `SELECT id, number, title FROM tickets
		WHERE deleted_at IS NULL AND source_url_key <> '' AND source_url_key = ticket_source_key($1) AND id::text <> $2
		ORDER BY created_at, id LIMIT 1`, source, exclude).Scan(&found.ID, &found.Number, &found.Title)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &found, nil
}

func (s *Service) sourceConflict(ctx context.Context, source string, err error) error {
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23505" || pg.ConstraintName != "ticket_source_claims_pkey" {
		return err
	}
	e := apperr.New(409, "duplicate_source_url", "A task with this source URL already exists")
	// Called only after rollback: a failed transaction cannot run this query.
	if existing, lookupErr := s.FindSource(ctx, source, ""); lookupErr == nil && existing != nil {
		e.Message = fmt.Sprintf("Task %s already has this source URL", existing.Number)
		e.Details = map[string]any{"ticket": existing}
	}
	return e
}
