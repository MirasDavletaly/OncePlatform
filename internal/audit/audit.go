// Package audit writes and reads the audit log. Every data change in the
// portal (web or MCP) produces an audit entry, written in the same
// transaction as the change itself.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// Entry is a new audit record.
type Entry struct {
	UserID     string // empty for system actions
	Action     string // e.g. "ticket.create"
	EntityType string // e.g. "ticket"
	EntityID   string // UUID or empty
	Details    map[string]any
	Via        workflow.Via
	IP         string
}

// FromActor builds an entry attributed to actor.
func FromActor(a workflow.Actor, action, entityType, entityID string, details map[string]any) Entry {
	return Entry{
		UserID:     a.UserID,
		Action:     action,
		EntityType: entityType,
		EntityID:   entityID,
		Details:    details,
		Via:        a.Via,
		IP:         a.IP,
	}
}

// Write inserts an audit entry using q (pool or transaction).
func Write(ctx context.Context, q db.Querier, e Entry) error {
	if e.Details == nil {
		e.Details = map[string]any{}
	}
	if e.Via == "" {
		e.Via = workflow.ViaWeb
	}
	details, err := json.Marshal(e.Details)
	if err != nil {
		return fmt.Errorf("audit details: %w", err)
	}
	_, err = q.Exec(ctx, `
		INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, via, ip)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		nullable(e.UserID), e.Action, e.EntityType, nullable(e.EntityID), details, string(e.Via), e.IP)
	if err != nil {
		return fmt.Errorf("write audit: %w", err)
	}
	return nil
}

// Record is a stored audit entry.
type Record struct {
	ID         string          `json:"id"`
	UserID     *string         `json:"user_id"`
	UserName   string          `json:"user_name"`
	Action     string          `json:"action"`
	EntityType string          `json:"entity_type"`
	EntityID   *string         `json:"entity_id"`
	Details    json.RawMessage `json:"details"`
	Via        string          `json:"via"`
	IP         string          `json:"ip,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
}

// Filter narrows List results.
type Filter struct {
	UserID     string
	Action     string // prefix match, e.g. "ticket."
	EntityType string
	EntityID   string
	Via        string
	From, To   *time.Time
	Page       int
	PageSize   int
}

const selectRecord = `
	SELECT a.id, a.user_id, coalesce(u.full_name, ''), a.action, a.entity_type, a.entity_id,
	       a.details, a.via, a.ip, a.created_at
	FROM audit_log a
	LEFT JOIN users u ON u.id = a.user_id`

func scanRecords(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}) ([]Record, error) {
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var r Record
		var details []byte
		if err := rows.Scan(&r.ID, &r.UserID, &r.UserName, &r.Action, &r.EntityType, &r.EntityID,
			&details, &r.Via, &r.IP, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Details = json.RawMessage(details)
		out = append(out, r)
	}
	return out, rows.Err()
}

// List returns audit records matching f, newest first, plus the total count.
func List(ctx context.Context, q db.Querier, f Filter) ([]Record, int, error) {
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if f.UserID != "" && db.IsUUID(f.UserID) {
		add("a.user_id = $%d", f.UserID)
	}
	if f.Action != "" {
		add("a.action LIKE $%d", strings.ReplaceAll(f.Action, "%", "")+"%")
	}
	if f.EntityType != "" {
		add("a.entity_type = $%d", f.EntityType)
	}
	if f.EntityID != "" && db.IsUUID(f.EntityID) {
		add("a.entity_id = $%d", f.EntityID)
	}
	if f.Via != "" {
		add("a.via = $%d", f.Via)
	}
	if f.From != nil {
		add("a.created_at >= $%d", *f.From)
	}
	if f.To != nil {
		add("a.created_at < $%d", *f.To)
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := q.QueryRow(ctx, "SELECT count(*) FROM audit_log a"+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	page, size := normalizePage(f.Page, f.PageSize)
	args = append(args, size, (page-1)*size)
	rows, err := q.Query(ctx, selectRecord+cond+
		fmt.Sprintf(" ORDER BY a.created_at DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	recs, err := scanRecords(rows)
	return recs, total, err
}

// Activity returns recent work-related actions for the dashboard feed.
func Activity(ctx context.Context, q db.Querier, limit int) ([]Record, error) {
	rows, err := q.Query(ctx, selectRecord+`
		WHERE a.entity_type IN ('ticket', 'comment', 'attachment')
		ORDER BY a.created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return withoutIP(scanRecords(rows))
}

// withoutIP: the feed and a task's history are shown to the whole team;
// colleagues' addresses are for the administrator's audit log only.
func withoutIP(recs []Record, err error) ([]Record, error) {
	for i := range recs {
		recs[i].IP = ""
	}
	return recs, err
}

// ForTicket returns all audit records related to a ticket, oldest first.
func ForTicket(ctx context.Context, q db.Querier, ticketID string) ([]Record, error) {
	rows, err := q.Query(ctx, selectRecord+`
		WHERE (a.entity_type = 'ticket' AND a.entity_id = $1) OR a.details ->> 'ticket_id' = $2
		ORDER BY a.created_at ASC LIMIT 1000`, ticketID, ticketID)
	if err != nil {
		return nil, err
	}
	return withoutIP(scanRecords(rows))
}

func normalizePage(page, size int) (int, int) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	return page, size
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
