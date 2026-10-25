// Package notify stores in-app notifications (assignment, status change,
// mention, upcoming deadline) and runs the hourly deadline check.
package notify

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/db"
)

// Notification types.
const (
	TypeAssigned      = "assigned"
	TypeStatusChanged = "status_changed"
	TypeMentioned     = "mentioned"
	TypeDeadline3d    = "deadline_3d"
	TypeDeadline1d    = "deadline_1d"
)

// Notification is a stored notification with joined display fields.
type Notification struct {
	ID           string     `json:"id"`
	Type         string     `json:"type"`
	TicketID     *string    `json:"ticket_id"`
	TicketNumber *string    `json:"ticket_number"`
	TicketTitle  *string    `json:"ticket_title"`
	ActorID      *string    `json:"actor_id"`
	ActorName    *string    `json:"actor_name"`
	Text         string     `json:"text"`
	ReadAt       *time.Time `json:"read_at"`
	CreatedAt    time.Time  `json:"created_at"`
}

// New describes a notification to create.
type New struct {
	UserID   string
	Type     string
	TicketID string
	ActorID  string
	Text     string
	DedupKey string // optional; a (user, key) pair is notified at most once
}

// Create inserts a notification using q (pool or transaction). Notifications
// to the actor themselves are skipped.
func Create(ctx context.Context, q db.Querier, n New) error {
	if n.UserID == "" || (n.ActorID != "" && n.UserID == n.ActorID) {
		return nil
	}
	_, err := q.Exec(ctx, `
		INSERT INTO notifications (user_id, type, ticket_id, actor_id, text, dedup_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
		n.UserID, n.Type, nullable(n.TicketID), nullable(n.ActorID), n.Text, nullable(n.DedupKey))
	return err
}

var mentionRe = regexp.MustCompile(`(?:^|[^\p{L}\p{N}_.@])@([\p{L}\p{N}][\p{L}\p{N}._-]*)`)

// ParseMentions extracts lowercase @handles from Markdown text.
func ParseMentions(body string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(body, -1) {
		h := strings.ToLower(strings.TrimRight(m[1], "._-"))
		if h != "" && !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}

// UserRef is a minimal user reference.
type UserRef struct {
	ID   string
	Name string
}

// MentionedUsers resolves handles to active users. A handle matches the
// user's login (@Miras) or the first word of the full name, case-insensitively.
func MentionedUsers(ctx context.Context, q db.Querier, handles []string) ([]UserRef, error) {
	if len(handles) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `SELECT id, full_name FROM users
		WHERE is_active AND (lower(username) = ANY($1) OR lower(split_part(full_name, ' ', 1)) = ANY($1))`, handles)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UserRef
	for rows.Next() {
		var u UserRef
		if err := rows.Scan(&u.ID, &u.Name); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ActiveUserIDs returns the IDs of all active users (recipients of
// notifications about tasks that belong to everyone).
func ActiveUserIDs(ctx context.Context, q db.Querier) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT id FROM users WHERE is_active`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Service lists notifications and runs background checks.
type Service struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	loc  *time.Location
}

// NewService creates the notification service.
func NewService(pool *pgxpool.Pool, log *slog.Logger, loc *time.Location) *Service {
	return &Service{pool: pool, log: log, loc: loc}
}

// List returns the user's notifications, newest first.
func (s *Service) List(ctx context.Context, userID string, unreadOnly bool, page, size int) ([]Notification, int, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 30
	}
	// Notifications about deleted tasks are hidden.
	cond := `n.user_id = $1 AND (n.ticket_id IS NULL OR t.deleted_at IS NULL)`
	if unreadOnly {
		cond += ` AND n.read_at IS NULL`
	}
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id
		WHERE `+cond, userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT n.id, n.type, n.ticket_id, t.number, t.title, n.actor_id, a.full_name, n.text, n.read_at, n.created_at
		FROM notifications n
		LEFT JOIN tickets t ON t.id = n.ticket_id
		LEFT JOIN users a ON a.id = n.actor_id
		WHERE `+cond+` ORDER BY n.created_at DESC LIMIT $2 OFFSET $3`, userID, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Type, &n.TicketID, &n.TicketNumber, &n.TicketTitle, &n.ActorID, &n.ActorName,
			&n.Text, &n.ReadAt, &n.CreatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, n)
	}
	return out, total, rows.Err()
}

// UnreadCount returns the number of unread notifications of the user.
func (s *Service) UnreadCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id
		WHERE n.user_id = $1 AND n.read_at IS NULL AND (n.ticket_id IS NULL OR t.deleted_at IS NULL)`, userID).Scan(&n)
	return n, err
}

// MarkRead marks one notification of the user as read.
func (s *Service) MarkRead(ctx context.Context, userID, id string) error {
	if !db.IsUUID(id) {
		return apperr.NotFound("Notification not found")
	}
	tag, err := s.pool.Exec(ctx, `UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.NotFound("Notification not found")
	}
	return nil
}

// MarkAllRead marks all notifications of the user as read.
func (s *Service) MarkAllRead(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, userID)
	return err
}

// CheckDeadlines notifies assignees and authors about tasks whose deadline
// is within 3 days or within 1 day (for tasks assigned to everyone: all
// active users). Each (task, deadline, threshold) is notified once per user.
func (s *Service) CheckDeadlines(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, number, title, deadline, assignee_id, created_by
		FROM tickets
		WHERE deleted_at IS NULL AND status NOT IN ('sent', 'closed')
		  AND deadline > now() AND deadline <= now() + interval '3 days'`)
	if err != nil {
		return 0, err
	}
	type due struct {
		id, number, title string
		deadline          time.Time
		assignee          *string
		author            string
	}
	var list []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.id, &d.number, &d.title, &d.deadline, &d.assignee, &d.author); err != nil {
			rows.Close()
			return 0, err
		}
		list = append(list, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	created := 0
	now := time.Now()
	var everyone []string
	for _, d := range list {
		typ, label := TypeDeadline3d, "less than 3 days"
		if d.deadline.Sub(now) <= 24*time.Hour {
			typ, label = TypeDeadline1d, "less than a day"
		}
		text := fmt.Sprintf("Task %s \"%s\" is due in %s (%s)",
			d.number, d.title, label, d.deadline.In(s.loc).Format("02.01.2006 15:04"))
		recipients := []string{d.author}
		if d.assignee != nil && *d.assignee != d.author {
			recipients = append(recipients, *d.assignee)
		}
		if d.assignee == nil {
			if everyone == nil {
				if everyone, err = ActiveUserIDs(ctx, s.pool); err != nil {
					return created, err
				}
			}
			recipients = everyone
		}
		for _, uid := range recipients {
			key := fmt.Sprintf("%s:%s:%d", typ, d.id, d.deadline.Unix())
			tag, err := s.pool.Exec(ctx, `
				INSERT INTO notifications (user_id, type, ticket_id, text, dedup_key)
				SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active)
				ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
				uid, typ, d.id, text, key)
			if err != nil {
				return created, err
			}
			created += int(tag.RowsAffected())
		}
	}
	return created, nil
}

// Cleanup removes read notifications older than 90 days.
func (s *Service) Cleanup(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '90 days'`)
	return err
}

// Run performs the deadline check shortly after start and then every hour
// until ctx is cancelled.
func (s *Service) Run(ctx context.Context) {
	check := func() {
		n, err := s.CheckDeadlines(ctx)
		if err != nil && ctx.Err() == nil {
			s.log.Error("deadline check failed", "error", err.Error())
			return
		}
		if n > 0 {
			s.log.Info("deadline notifications created", "count", n)
		}
		if err := s.Cleanup(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("notification cleanup failed", "error", err.Error())
		}
	}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		check()
	}
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
