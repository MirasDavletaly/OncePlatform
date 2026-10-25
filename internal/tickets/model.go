// Package tickets implements tasks (tenders, Astana Hub tasks, client
// requests): their status workflow, technical solution versions, comments,
// history, the kanban board and the dashboard.
package tickets

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"onceplatform/internal/apperr"
	"onceplatform/internal/workflow"
)

// Priorities of a task.
var Priorities = []string{"low", "normal", "high", "urgent"}

// Ticket is a task with joined display fields. A task without an assignee
// belongs to everyone on the team.
type Ticket struct {
	LossReason string `json:"loss_reason"`
	Shortlist
	ID                string          `json:"id"`
	Number            string          `json:"number"`
	Title             string          `json:"title"`
	Description       string          `json:"description,omitempty"`
	SourceURL         string          `json:"source_url"`
	Deadline          *time.Time      `json:"deadline"`
	Priority          string          `json:"priority"`
	Status            workflow.Status `json:"status"`
	CloseResult       string          `json:"close_result"`
	ClosedAt          *time.Time      `json:"closed_at"`
	AssigneeID        *string         `json:"assignee_id"`
	AssigneeName      *string         `json:"assignee_name"`
	CreatedBy         string          `json:"created_by"`
	CreatedByName     string          `json:"created_by_name"`
	TechnicalSolution string          `json:"technical_solution,omitempty"`
	CommentsCount     int             `json:"comments_count"`
	AttachmentsCount  int             `json:"attachments_count"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

// CreateInput holds fields for a new task. A nil or empty AssigneeID means
// the task is for everyone.
type CreateInput struct {
	Shortlist
	Title       string  `json:"title"`
	Description string  `json:"description"`
	SourceURL   string  `json:"source_url"`
	Deadline    *string `json:"deadline"`
	Priority    string  `json:"priority"`
	AssigneeID  *string `json:"assignee_id"`
}

// UpdateInput holds fields to change; nil means "leave unchanged". An empty
// string clears the deadline, or assigns the task to everyone (assignee_id).
type UpdateInput struct {
	ShortlistPatch
	Title       *string `json:"title"`
	Description *string `json:"description"`
	SourceURL   *string `json:"source_url"`
	Deadline    *string `json:"deadline"`
	Priority    *string `json:"priority"`
	AssigneeID  *string `json:"assignee_id"`
}

// IsEmpty reports whether no field is set.
func (u UpdateInput) IsEmpty() bool {
	return u.Title == nil && u.Description == nil && u.SourceURL == nil && u.Deadline == nil &&
		u.Priority == nil && u.AssigneeID == nil && u.ShortlistPatch.empty()
}

const (
	maxTitle       = 300
	maxDescription = 200_000
	maxSolution    = 1_000_000
	maxComment     = 50_000
)

func validatePriority(p string) error {
	if !slices.Contains(Priorities, p) {
		return apperr.Validationf("Unknown priority %q (allowed: %s)", p, strings.Join(Priorities, ", "))
	}
	return nil
}

func normalizeTitle(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", apperr.Validation("Enter a task title")
	}
	if utf8.RuneCountInString(s) > maxTitle {
		return "", apperr.Validationf("The title must be at most %d characters", maxTitle)
	}
	return s, nil
}

func validateDescription(s string) error {
	if utf8.RuneCountInString(s) > maxDescription {
		return apperr.Validation("The description is too long")
	}
	return nil
}

func normalizeURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(s) > 2000 {
		return "", apperr.Validation("The source link must be a full http(s):// address")
	}
	return s, nil
}

var deadlineLayouts = []string{
	"2006-01-02T15:04:05",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"02.01.2006 15:04",
	"02.01.2006 15:04:05",
}

// ParseDeadline parses a deadline. Accepted forms: RFC 3339 with offset;
// local date-time ("2026-11-05T18:00", "2026-11-05 18:00", "05.11.2026 18:00")
// interpreted in loc; or a date alone ("2026-11-05", "05.11.2026"), which
// means 23:59 of that day in loc. An empty string means "no deadline".
func ParseDeadline(s string, loc *time.Location) (*time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		t = t.UTC()
		return &t, nil
	}
	for _, layout := range deadlineLayouts {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			t = t.UTC()
			return &t, nil
		}
	}
	for _, layout := range []string{"2006-01-02", "02.01.2006"} {
		if d, err := time.ParseInLocation(layout, s, loc); err == nil {
			t := time.Date(d.Year(), d.Month(), d.Day(), 23, 59, 0, 0, loc).UTC()
			return &t, nil
		}
	}
	return nil, apperr.Validation(fmt.Sprintf("Cannot parse deadline %q. Use 2026-11-05 18:00 or 05.11.2026", s))
}

// ParseDateBound parses a date filter ("2026-11-05" or RFC 3339) in loc. When
// end is true a date alone means the end of that day (exclusive bound).
func ParseDateBound(s string, loc *time.Location, end bool) (*time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return &t, nil
	}
	for _, layout := range []string{"2006-01-02", "02.01.2006"} {
		if d, err := time.ParseInLocation(layout, s, loc); err == nil {
			if end {
				d = d.AddDate(0, 0, 1)
			}
			d = d.UTC()
			return &d, nil
		}
	}
	return nil, apperr.Validationf("Invalid date %q (expected YYYY-MM-DD)", s)
}

var numberRe = regexp.MustCompile(`(?i)^T-\d{4}-\d{3,}$`)

// IsTicketNumber reports whether s looks like a task number (T-2026-0001).
func IsTicketNumber(s string) bool { return numberRe.MatchString(s) }

// FormatNumber formats a task number.
func FormatNumber(year, seq int) string { return fmt.Sprintf("T-%d-%04d", year, seq) }
