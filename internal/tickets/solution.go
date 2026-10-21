package tickets

import (
	"context"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// SolutionVersion is a saved version of a ticket's technical solution.
type SolutionVersion struct {
	ID         string    `json:"id"`
	TicketID   string    `json:"ticket_id"`
	Body       string    `json:"body,omitempty"`
	Length     int       `json:"length"`
	AuthorID   string    `json:"author_id"`
	AuthorName string    `json:"author_name"`
	Via        string    `json:"via"`
	CreatedAt  time.Time `json:"created_at"`
}

// SaveSolution stores a new technical solution text and records it as a new
// version. Saving identical text does not create a duplicate version.
func (s *Service) SaveSolution(ctx context.Context, actor workflow.Actor, ref, body string) (*SolutionVersion, error) {
	return s.saveSolution(ctx, actor, ref, body, "")
}

func (s *Service) saveSolution(ctx context.Context, actor workflow.Actor, ref, body, restoredFrom string) (*SolutionVersion, error) {
	if err := actor.Require(workflow.PermSolutionEdit); err != nil {
		return nil, err
	}
	if utf8.RuneCountInString(body) > maxSolution {
		return nil, apperr.Validation("The technical solution is too long (maximum 1,000,000 characters)")
	}
	if !utf8.ValidString(body) {
		return nil, apperr.Validation("The text must be UTF-8")
	}
	var v *SolutionVersion
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		id, err := s.ResolveID(ctx, tx, ref)
		if err != nil {
			return err
		}
		var current, number, title string
		if err := tx.QueryRow(ctx, `SELECT technical_solution, number, title FROM tickets WHERE id = $1 FOR UPDATE`, id).
			Scan(&current, &number, &title); err != nil {
			return err
		}
		if current == body {
			latest, err := s.latestVersion(ctx, tx, id)
			if err != nil && !apperr.IsNotFound(err) {
				return err
			}
			if latest != nil {
				v = latest
				return nil
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET technical_solution = $2, updated_at = now() WHERE id = $1`, id, body); err != nil {
			return err
		}
		v = &SolutionVersion{TicketID: id, AuthorID: actor.UserID, AuthorName: actor.Name, Via: string(actor.Via),
			Length: utf8.RuneCountInString(body)}
		if err := tx.QueryRow(ctx, `INSERT INTO solution_versions (ticket_id, body, author_id, via)
			VALUES ($1, $2, $3, $4) RETURNING id, created_at`, id, body, actor.UserID, string(actor.Via)).
			Scan(&v.ID, &v.CreatedAt); err != nil {
			return err
		}
		details := map[string]any{"ticket_id": id, "number": number, "title": title, "version_id": v.ID, "length": v.Length}
		if restoredFrom != "" {
			details["restored_from"] = restoredFrom
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "ticket.solution_save", "ticket", id, details))
	})
	if err != nil {
		return nil, err
	}
	return v, nil
}

func (s *Service) latestVersion(ctx context.Context, q db.Querier, ticketID string) (*SolutionVersion, error) {
	var v SolutionVersion
	err := q.QueryRow(ctx, `
		SELECT sv.id, sv.ticket_id, char_length(sv.body), sv.author_id, u.full_name, sv.via, sv.created_at
		FROM solution_versions sv JOIN users u ON u.id = sv.author_id
		WHERE sv.ticket_id = $1 ORDER BY sv.created_at DESC LIMIT 1`, ticketID).
		Scan(&v.ID, &v.TicketID, &v.Length, &v.AuthorID, &v.AuthorName, &v.Via, &v.CreatedAt)
	if db.IsNoRows(err) {
		return nil, apperr.NotFound("No versions yet")
	}
	return &v, err
}

// ListSolutionVersions returns versions (without bodies), newest first.
func (s *Service) ListSolutionVersions(ctx context.Context, ref string) ([]SolutionVersion, error) {
	id, err := s.ResolveID(ctx, s.pool, ref)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT sv.id, sv.ticket_id, char_length(sv.body), sv.author_id, u.full_name, sv.via, sv.created_at
		FROM solution_versions sv JOIN users u ON u.id = sv.author_id
		WHERE sv.ticket_id = $1 ORDER BY sv.created_at DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SolutionVersion{}
	for rows.Next() {
		var v SolutionVersion
		if err := rows.Scan(&v.ID, &v.TicketID, &v.Length, &v.AuthorID, &v.AuthorName, &v.Via, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetSolutionVersion returns one version including its body.
func (s *Service) GetSolutionVersion(ctx context.Context, ref, versionID string) (*SolutionVersion, error) {
	id, err := s.ResolveID(ctx, s.pool, ref)
	if err != nil {
		return nil, err
	}
	if !db.IsUUID(versionID) {
		return nil, apperr.NotFound("Version not found")
	}
	var v SolutionVersion
	err = s.pool.QueryRow(ctx, `
		SELECT sv.id, sv.ticket_id, sv.body, char_length(sv.body), sv.author_id, u.full_name, sv.via, sv.created_at
		FROM solution_versions sv JOIN users u ON u.id = sv.author_id
		WHERE sv.id = $1 AND sv.ticket_id = $2`, versionID, id).
		Scan(&v.ID, &v.TicketID, &v.Body, &v.Length, &v.AuthorID, &v.AuthorName, &v.Via, &v.CreatedAt)
	if db.IsNoRows(err) {
		return nil, apperr.NotFound("Version not found")
	}
	return &v, err
}

// RestoreSolutionVersion makes an old version current by saving it as a new version.
func (s *Service) RestoreSolutionVersion(ctx context.Context, actor workflow.Actor, ref, versionID string) (*SolutionVersion, error) {
	if err := actor.Require(workflow.PermSolutionEdit); err != nil {
		return nil, err
	}
	old, err := s.GetSolutionVersion(ctx, ref, versionID)
	if err != nil {
		return nil, err
	}
	return s.saveSolution(ctx, actor, old.TicketID, old.Body, old.ID)
}
