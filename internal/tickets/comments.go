package tickets

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/notify"
	"onceplatform/internal/workflow"
)

// Comment is a ticket comment.
type Comment struct {
	ID         string     `json:"id"`
	TicketID   string     `json:"ticket_id"`
	AuthorID   string     `json:"author_id"`
	AuthorName string     `json:"author_name"`
	Body       string     `json:"body"`
	Via        string     `json:"via"`
	CreatedAt  time.Time  `json:"created_at"`
	EditedAt   *time.Time `json:"edited_at"`
}

const commentSelect = `
	SELECT cm.id, cm.ticket_id, cm.author_id, u.full_name, cm.body, cm.via, cm.created_at, cm.edited_at
	FROM comments cm JOIN users u ON u.id = cm.author_id`

func scanComment(row pgx.Row) (*Comment, error) {
	var c Comment
	err := row.Scan(&c.ID, &c.TicketID, &c.AuthorID, &c.AuthorName, &c.Body, &c.Via, &c.CreatedAt, &c.EditedAt)
	return &c, err
}

// ListComments returns comments of a ticket, oldest first. If limit > 0 only
// the latest `limit` comments are returned (still oldest first).
func (s *Service) ListComments(ctx context.Context, ref string, limit int) ([]Comment, error) {
	id, err := s.ResolveID(ctx, s.pool, ref)
	if err != nil {
		return nil, err
	}
	q := commentSelect + ` WHERE cm.ticket_id = $1 AND cm.deleted_at IS NULL ORDER BY cm.created_at`
	args := []any{id}
	if limit > 0 {
		q = `SELECT * FROM (` + commentSelect + ` WHERE cm.ticket_id = $1 AND cm.deleted_at IS NULL
			ORDER BY cm.created_at DESC LIMIT $2) x ORDER BY created_at`
		args = append(args, limit)
	}
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Comment{}
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func validateCommentBody(body string) (string, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return "", apperr.Validation("A comment cannot be empty")
	}
	if utf8.RuneCountInString(body) > maxComment {
		return "", apperr.Validationf("A comment can be at most %d characters long", maxComment)
	}
	return body, nil
}

// AddComment adds a comment; @mentions notify the mentioned users.
func (s *Service) AddComment(ctx context.Context, actor workflow.Actor, ref, body string) (*Comment, error) {
	if err := actor.Require(workflow.PermFilesComments); err != nil {
		return nil, err
	}
	body, err := validateCommentBody(body)
	if err != nil {
		return nil, err
	}
	var c *Comment
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		id, err := s.ResolveID(ctx, tx, ref)
		if err != nil {
			return err
		}
		var number, title string
		if err := tx.QueryRow(ctx, `SELECT number, title FROM tickets WHERE id = $1`, id).Scan(&number, &title); err != nil {
			return err
		}
		var cid string
		if err := tx.QueryRow(ctx, `INSERT INTO comments (ticket_id, author_id, body, via) VALUES ($1, $2, $3, $4) RETURNING id`,
			id, actor.UserID, body, string(actor.Via)).Scan(&cid); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.FromActor(actor, "comment.create", "comment", cid, map[string]any{
			"ticket_id": id, "number": number, "title": title, "excerpt": truncate(body, 200),
		})); err != nil {
			return err
		}
		if err := s.notifyMentions(ctx, tx, actor, id, number, title, body, nil); err != nil {
			return err
		}
		c, err = scanComment(tx.QueryRow(ctx, commentSelect+` WHERE cm.id = $1`, cid))
		return err
	})
	if err != nil {
		return nil, err
	}
	return c, nil
}

func (s *Service) notifyMentions(ctx context.Context, q db.Querier, actor workflow.Actor, ticketID, number, title, body string, skip []string) error {
	handles := notify.ParseMentions(body)
	var fresh []string
	for _, h := range handles {
		if !slices.Contains(skip, h) {
			fresh = append(fresh, h)
		}
	}
	users, err := notify.MentionedUsers(ctx, q, fresh)
	if err != nil {
		return err
	}
	for _, u := range users {
		if err := notify.Create(ctx, q, notify.New{
			UserID: u.ID, Type: notify.TypeMentioned, TicketID: ticketID, ActorID: actor.UserID,
			Text: fmt.Sprintf("%s mentioned you in a comment on task %s \"%s\": %s", actor.Name, number, title, truncate(body, 200)),
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) loadComment(ctx context.Context, q db.Querier, id string) (*Comment, error) {
	if !db.IsUUID(id) {
		return nil, apperr.NotFound("Comment not found")
	}
	c, err := scanComment(q.QueryRow(ctx, commentSelect+` JOIN tickets t ON t.id = cm.ticket_id
		WHERE cm.id = $1 AND cm.deleted_at IS NULL AND t.deleted_at IS NULL`, id))
	if db.IsNoRows(err) {
		return nil, apperr.NotFound("Comment not found")
	}
	return c, err
}

// EditComment changes the body of the actor's own comment.
func (s *Service) EditComment(ctx context.Context, actor workflow.Actor, commentID, body string) (*Comment, error) {
	body, err := validateCommentBody(body)
	if err != nil {
		return nil, err
	}
	var c *Comment
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		cur, err := s.loadComment(ctx, tx, commentID)
		if err != nil {
			return err
		}
		if cur.AuthorID != actor.UserID {
			return apperr.Forbidden("You can edit only your own comments")
		}
		if cur.Body == body {
			c = cur
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE comments SET body = $2, edited_at = now() WHERE id = $1`, cur.ID, body); err != nil {
			return err
		}
		var number, title string
		if err := tx.QueryRow(ctx, `SELECT number, title FROM tickets WHERE id = $1`, cur.TicketID).Scan(&number, &title); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.FromActor(actor, "comment.update", "comment", cur.ID, map[string]any{
			"ticket_id": cur.TicketID, "number": number, "title": title, "excerpt": truncate(body, 200),
		})); err != nil {
			return err
		}
		if err := s.notifyMentions(ctx, tx, actor, cur.TicketID, number, title, body, notify.ParseMentions(cur.Body)); err != nil {
			return err
		}
		c, err = scanComment(tx.QueryRow(ctx, commentSelect+` WHERE cm.id = $1`, cur.ID))
		return err
	})
	if err != nil {
		return nil, err
	}
	return c, nil
}

// DeleteComment soft-deletes a comment (its author or an admin).
func (s *Service) DeleteComment(ctx context.Context, actor workflow.Actor, commentID string) error {
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		cur, err := s.loadComment(ctx, tx, commentID)
		if err != nil {
			return err
		}
		if cur.AuthorID != actor.UserID && !actor.Can(workflow.PermDelete) {
			return apperr.Forbidden("Only the author or the admin can delete a comment")
		}
		if _, err := tx.Exec(ctx, `UPDATE comments SET deleted_at = now() WHERE id = $1`, cur.ID); err != nil {
			return err
		}
		var number string
		_ = tx.QueryRow(ctx, `SELECT number FROM tickets WHERE id = $1`, cur.TicketID).Scan(&number)
		return audit.Write(ctx, tx, audit.FromActor(actor, "comment.delete", "comment", cur.ID, map[string]any{
			"ticket_id": cur.TicketID, "number": number, "excerpt": truncate(cur.Body, 200),
		}))
	})
}
