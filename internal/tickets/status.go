package tickets

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/notify"
	"onceplatform/internal/workflow"
)

// ChangeStatus moves a ticket to another status according to the workflow
// matrix. Closing requires a result; moving back requires a comment.
func (s *Service) ChangeStatus(ctx context.Context, actor workflow.Actor, ref string, to workflow.Status,
	comment string, result workflow.CloseResult) (*Ticket, error) {
	if err := actor.Require(workflow.PermView); err != nil {
		return nil, err
	}
	comment = strings.TrimSpace(comment)
	var ticket *Ticket
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		id, err := s.ResolveID(ctx, tx, ref)
		if err != nil {
			return err
		}
		var (
			from     workflow.Status
			number   string
			title    string
			assignee *string
			author   string
		)
		if err := tx.QueryRow(ctx, `SELECT status, number, title, assignee_id, created_by FROM tickets
			WHERE id = $1 FOR UPDATE`, id).Scan(&from, &number, &title, &assignee, &author); err != nil {
			return err
		}
		if err := workflow.ValidateTransition(actor.Role, from, to, comment, result); err != nil {
			return err
		}
		var closedAt *time.Time
		if to == workflow.StatusClosed {
			now := time.Now().UTC()
			closedAt = &now
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET status = $2, close_result = $3, closed_at = $4, updated_at = now()
			WHERE id = $1`, id, string(to), string(result), closedAt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ticket_status_history (ticket_id, from_status, to_status, close_result, changed_by, comment, via)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			id, string(from), string(to), string(result), actor.UserID, comment, string(actor.Via)); err != nil {
			return err
		}
		details := map[string]any{
			"ticket_id": id, "number": number, "title": title, "from": from, "to": to,
		}
		if result != "" {
			details["result"] = result
		}
		if comment != "" {
			details["comment"] = comment
		}
		if err := audit.Write(ctx, tx, audit.FromActor(actor, "ticket.status_change", "ticket", id, details)); err != nil {
			return err
		}

		text := fmt.Sprintf("%s moved task %s \"%s\": %s → %s", actor.Name, number, title,
			workflow.StatusLabel(from), workflow.StatusLabel(to))
		if result != "" {
			text += " (" + workflow.ResultLabel(result) + ")"
		}
		if comment != "" {
			text += ". Comment: " + truncate(comment, 300)
		}
		recipients := []string{author}
		if assignee != nil && *assignee != author {
			recipients = append(recipients, *assignee)
		}
		if assignee == nil {
			// A task for everyone: the whole team follows it.
			if recipients, err = notify.ActiveUserIDs(ctx, tx); err != nil {
				return err
			}
		}
		for _, uid := range recipients {
			if err := notify.Create(ctx, tx, notify.New{
				UserID: uid, Type: notify.TypeStatusChanged, TicketID: id, ActorID: actor.UserID, Text: text,
			}); err != nil {
				return err
			}
		}
		ticket, err = s.getByID(ctx, tx, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return ticket, nil
}

// StatusChange is a row of the status history.
type StatusChange struct {
	ID          string    `json:"id"`
	FromStatus  *string   `json:"from_status"`
	ToStatus    string    `json:"to_status"`
	CloseResult string    `json:"close_result"`
	ChangedBy   string    `json:"changed_by"`
	ChangedName string    `json:"changed_by_name"`
	Comment     string    `json:"comment"`
	Via         string    `json:"via"`
	CreatedAt   time.Time `json:"created_at"`
}

// StatusHistory returns the status changes of a ticket, oldest first.
func (s *Service) StatusHistory(ctx context.Context, ticketID string) ([]StatusChange, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT h.id, h.from_status, h.to_status, h.close_result, h.changed_by, u.full_name, h.comment, h.via, h.created_at
		FROM ticket_status_history h JOIN users u ON u.id = h.changed_by
		WHERE h.ticket_id = $1 ORDER BY h.created_at`, ticketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StatusChange{}
	for rows.Next() {
		var c StatusChange
		if err := rows.Scan(&c.ID, &c.FromStatus, &c.ToStatus, &c.CloseResult, &c.ChangedBy, &c.ChangedName,
			&c.Comment, &c.Via, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// History returns the status history and all audit events of a ticket.
func (s *Service) History(ctx context.Context, ref string) ([]StatusChange, []audit.Record, error) {
	id, err := s.ResolveID(ctx, s.pool, ref)
	if err != nil {
		return nil, nil, err
	}
	statuses, err := s.StatusHistory(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	events, err := audit.ForTicket(ctx, s.pool, id)
	if err != nil {
		return nil, nil, err
	}
	return statuses, events, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
