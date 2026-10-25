package tickets

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/notify"
	"onceplatform/internal/workflow"
)

// Service implements task operations. Every method that changes data takes
// the acting user, checks permissions and writes the audit log in the same
// transaction.
type Service struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	loc  *time.Location
}

// NewService creates the task service.
func NewService(pool *pgxpool.Pool, log *slog.Logger, loc *time.Location) *Service {
	return &Service{pool: pool, log: log, loc: loc}
}

// Location returns the display time zone.
func (s *Service) Location() *time.Location { return s.loc }

const ticketSelect = `
	SELECT t.id, t.number, t.title, %s, t.source_url, t.deadline, t.priority, t.status, t.close_result,
	       t.closed_at, t.assignee_id, a.full_name, t.created_by, cb.full_name, %s,
	       (SELECT count(*) FROM comments cm WHERE cm.ticket_id = t.id AND cm.deleted_at IS NULL),
	       (SELECT count(*) FROM attachments at WHERE at.ticket_id = t.id AND at.deleted_at IS NULL),
	       t.created_at, t.updated_at, t.fit_score, t.complexity, t.market,
	       t.applications_count, t.budget_amount::text, t.currency, t.customer, t.loss_reason
	FROM tickets t
	LEFT JOIN users a ON a.id = t.assignee_id
	JOIN users cb ON cb.id = t.created_by`

var (
	selectFull  = fmt.Sprintf(ticketSelect, "t.description", "t.technical_solution")
	selectBrief = fmt.Sprintf(ticketSelect, "''", "''")
)

func scanTicket(row pgx.Row) (*Ticket, error) {
	var t Ticket
	err := row.Scan(&t.ID, &t.Number, &t.Title, &t.Description, &t.SourceURL, &t.Deadline, &t.Priority,
		&t.Status, &t.CloseResult, &t.ClosedAt, &t.AssigneeID, &t.AssigneeName, &t.CreatedBy, &t.CreatedByName,
		&t.TechnicalSolution, &t.CommentsCount, &t.AttachmentsCount, &t.CreatedAt, &t.UpdatedAt,
		&t.FitScore, &t.Complexity, &t.Market, &t.ApplicationsCount, &t.BudgetAmount, &t.Currency, &t.Customer, &t.LossReason)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func collectTickets(rows pgx.Rows) ([]Ticket, error) {
	defer rows.Close()
	out := []Ticket{}
	for rows.Next() {
		t, err := scanTicket(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

var errTicketNotFound = apperr.NotFound("Task not found")

// ResolveID converts a task UUID or number (T-2026-0001) into the UUID of a
// non-deleted task.
func (s *Service) ResolveID(ctx context.Context, q db.Querier, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	var id string
	var err error
	switch {
	case db.IsUUID(ref):
		err = q.QueryRow(ctx, `SELECT id FROM tickets WHERE id = $1 AND deleted_at IS NULL`, ref).Scan(&id)
	case IsTicketNumber(ref):
		err = q.QueryRow(ctx, `SELECT id FROM tickets WHERE number = upper($1) AND deleted_at IS NULL`, ref).Scan(&id)
	default:
		return "", errTicketNotFound
	}
	if db.IsNoRows(err) {
		return "", errTicketNotFound
	}
	return id, err
}

// Get returns a full task by UUID or number.
func (s *Service) Get(ctx context.Context, ref string) (*Ticket, error) {
	id, err := s.ResolveID(ctx, s.pool, ref)
	if err != nil {
		return nil, err
	}
	return s.getByID(ctx, s.pool, id)
}

func (s *Service) getByID(ctx context.Context, q db.Querier, id string) (*Ticket, error) {
	t, err := scanTicket(q.QueryRow(ctx, selectFull+` WHERE t.id = $1 AND t.deleted_at IS NULL`, id))
	if db.IsNoRows(err) {
		return nil, errTicketNotFound
	}
	return t, err
}

// ListFilter selects tasks for the list, export, board and MCP.
type ListFilter struct {
	ShortlistFilter
	Statuses   []string
	Priorities []string
	// AssigneeIDs selects tasks of specific users; "everyone" selects tasks
	// assigned to the whole team.
	AssigneeIDs []string
	// MineUserID selects tasks of this user plus tasks for everyone.
	MineUserID   string
	DeadlineFrom *time.Time
	DeadlineTo   *time.Time
	Overdue      bool
	Q            string
	Sort         string
	Order        string
	Page         int
	PageSize     int
}

var sortColumns = map[string]string{
	"fit_score":          "t.fit_score",
	"complexity":         "t.complexity",
	"market":             "NULLIF(lower(t.market), '')",
	"applications_count": "t.applications_count",
	"budget_amount":      "t.budget_amount",
	"currency":           "t.currency",
	"customer":           "NULLIF(lower(t.customer), '')",
	"number":             "t.created_at",
	"title":              "lower(t.title)",
	"deadline":           "t.deadline",
	"priority":           "array_position(ARRAY['low','normal','high','urgent'], t.priority)",
	"status":             "array_position(ARRAY['new','analysis','solution','sent','closed'], t.status)",
	"created_at":         "t.created_at",
	"updated_at":         "t.updated_at",
	"assignee":           "lower(a.full_name)",
}

func (f *ListFilter) where() (string, []any) {
	conds := []string{"t.deleted_at IS NULL"}
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if len(f.Statuses) > 0 {
		conds = append(conds, "t.status = ANY("+arg(f.Statuses)+")")
	}
	if len(f.Priorities) > 0 {
		conds = append(conds, "t.priority = ANY("+arg(f.Priorities)+")")
	}
	if len(f.AssigneeIDs) > 0 {
		var ids []string
		everyone := false
		for _, id := range f.AssigneeIDs {
			if id == "everyone" || id == "none" {
				everyone = true
			} else if db.IsUUID(id) {
				ids = append(ids, id)
			}
		}
		var parts []string
		if len(ids) > 0 {
			parts = append(parts, "t.assignee_id = ANY("+arg(ids)+"::uuid[])")
		}
		if everyone {
			parts = append(parts, "t.assignee_id IS NULL")
		}
		if len(parts) == 0 {
			parts = append(parts, "false")
		}
		conds = append(conds, "("+strings.Join(parts, " OR ")+")")
	}
	if f.MineUserID != "" && db.IsUUID(f.MineUserID) {
		conds = append(conds, "(t.assignee_id = "+arg(f.MineUserID)+" OR t.assignee_id IS NULL)")
	}
	if f.DeadlineFrom != nil {
		conds = append(conds, "t.deadline >= "+arg(*f.DeadlineFrom))
	}
	if f.DeadlineTo != nil {
		conds = append(conds, "t.deadline < "+arg(*f.DeadlineTo))
	}
	if f.Overdue {
		conds = append(conds, "t.deadline < now() AND t.status NOT IN ('sent', 'closed')")
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		like := arg(db.LikePattern(q))
		parts := []string{
			"t.title ILIKE " + like,
			"t.number ILIKE " + like,
			"t.description ILIKE " + like,
		}
		if tsq := db.PrefixTSQuery(q); tsq != "" {
			parts = append(parts, "t.search_vector @@ to_tsquery('simple', "+arg(tsq)+")")
		}
		conds = append(conds, "("+strings.Join(parts, " OR ")+")")
	}
	for _, bound := range []struct {
		column, op string
		value      *int
	}{
		{"fit_score", ">=", f.FitMin}, {"fit_score", "<=", f.FitMax},
		{"complexity", ">=", f.ComplexityMin}, {"complexity", "<=", f.ComplexityMax},
		{"applications_count", ">=", f.ApplicationsMin}, {"applications_count", "<=", f.ApplicationsMax},
	} {
		if bound.value != nil {
			conds = append(conds, "t."+bound.column+" "+bound.op+" "+arg(*bound.value))
		}
	}
	if f.BudgetMin != nil {
		conds = append(conds, "t.budget_amount >= "+arg(*f.BudgetMin)+"::numeric")
	}
	if f.BudgetMax != nil {
		conds = append(conds, "t.budget_amount <= "+arg(*f.BudgetMax)+"::numeric")
	}
	if f.LossReason != "" {
		conds = append(conds, "t.close_result = 'lost' AND t.loss_reason = "+arg(f.LossReason))
	}
	if f.Currency != "" {
		conds = append(conds, "t.currency = "+arg(f.Currency))
	}
	if f.Market != "" {
		conds = append(conds, "t.market ILIKE "+arg(db.LikePattern(f.Market)))
	}
	if f.Customer != "" {
		conds = append(conds, "t.customer ILIKE "+arg(db.LikePattern(f.Customer)))
	}
	if f.SourceURL != "" {
		conds = append(conds, "t.source_url_key <> '' AND t.source_url_key = ticket_source_key("+arg(f.SourceURL)+")")
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

func (f *ListFilter) orderBy() string {
	col, ok := sortColumns[f.Sort]
	if !ok {
		col = "t.created_at"
	}
	dir := "DESC"
	if strings.EqualFold(f.Order, "asc") {
		dir = "ASC"
	}
	return fmt.Sprintf(" ORDER BY %s %s NULLS LAST, t.created_at DESC, t.id DESC", col, dir)
}

// List returns a page of tasks (without long text fields) and the total.
func (s *Service) List(ctx context.Context, f ListFilter) ([]Ticket, int, error) {
	if err := f.Validate(); err != nil {
		return nil, 0, err
	}
	if f.Page < 1 {
		f.Page = 1
	}
	if f.PageSize < 1 {
		f.PageSize = 25
	}
	if f.PageSize > 10000 {
		f.PageSize = 10000
	}
	where, args := f.where()
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id`+where, args...).
		Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, f.PageSize, (f.Page-1)*f.PageSize)
	rows, err := s.pool.Query(ctx, selectBrief+where+f.orderBy()+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	items, err := collectTickets(rows)
	return items, total, err
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

func (s *Service) checkUser(ctx context.Context, q db.Querier, id string) error {
	if !db.IsUUID(id) {
		return apperr.Validation("Assignee not found")
	}
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active)`, id).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return apperr.Validation("Assignee not found or deactivated")
	}
	return nil
}

// notifyAssignment tells the assignee (or, for tasks for everyone, the whole
// team) about a new assignment.
func notifyAssignment(ctx context.Context, q db.Querier, actor workflow.Actor, id, number, title string, assignee *string) error {
	if assignee != nil {
		return notify.Create(ctx, q, notify.New{
			UserID: *assignee, Type: notify.TypeAssigned, TicketID: id, ActorID: actor.UserID,
			Text: fmt.Sprintf("%s assigned you task %s \"%s\"", actor.Name, number, title),
		})
	}
	users, err := notify.ActiveUserIDs(ctx, q)
	if err != nil {
		return err
	}
	for _, uid := range users {
		if err := notify.Create(ctx, q, notify.New{
			UserID: uid, Type: notify.TypeAssigned, TicketID: id, ActorID: actor.UserID,
			Text: fmt.Sprintf("%s added task %s \"%s\" for everyone", actor.Name, number, title),
		}); err != nil {
			return err
		}
	}
	return nil
}

// Create creates a task in status "new".
func (s *Service) Create(ctx context.Context, actor workflow.Actor, in CreateInput) (*Ticket, error) {
	if err := actor.Require(workflow.PermTicketCreate); err != nil {
		return nil, err
	}
	if err := in.Shortlist.normalize(); err != nil {
		return nil, err
	}
	title, err := normalizeTitle(in.Title)
	if err != nil {
		return nil, err
	}
	if err := validateDescription(in.Description); err != nil {
		return nil, err
	}
	if in.Priority == "" {
		in.Priority = "normal"
	}
	if err := validatePriority(in.Priority); err != nil {
		return nil, err
	}
	sourceURL, err := normalizeURL(in.SourceURL)
	if err != nil {
		return nil, err
	}
	var deadline *time.Time
	if in.Deadline != nil {
		if deadline, err = ParseDeadline(*in.Deadline, s.loc); err != nil {
			return nil, err
		}
	}
	var assignee *string
	if in.AssigneeID != nil && *in.AssigneeID != "" && *in.AssigneeID != "everyone" {
		assignee = in.AssigneeID
	}

	var ticket *Ticket
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if assignee != nil {
			if err := s.checkUser(ctx, tx, *assignee); err != nil {
				return err
			}
		}
		year := time.Now().In(s.loc).Year()
		var seq int
		if err := tx.QueryRow(ctx, `
			INSERT INTO ticket_counters (year, last_value) VALUES ($1, 1)
			ON CONFLICT (year) DO UPDATE SET last_value = ticket_counters.last_value + 1
			RETURNING last_value`, year).Scan(&seq); err != nil {
			return err
		}
		number := FormatNumber(year, seq)
		var id string
		if err := tx.QueryRow(ctx, `
			INSERT INTO tickets (number, title, description, source_url, deadline, priority, assignee_id, created_by,
			                     fit_score, complexity, market, applications_count, budget_amount, currency, customer)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::numeric, $14, $15)
			RETURNING id`,
			number, title, in.Description, sourceURL, deadline, in.Priority, assignee, actor.UserID,
			in.FitScore, in.Complexity, in.Market, in.ApplicationsCount, in.BudgetAmount, in.Currency, in.Customer).Scan(&id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, via)
			VALUES ($1, NULL, 'new', $2, $3)`, id, actor.UserID, string(actor.Via)); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.FromActor(actor, "ticket.create", "ticket", id, map[string]any{
			"ticket_id": id, "number": number, "title": title, "shortlist": in.Shortlist,
		})); err != nil {
			return err
		}
		if err := notifyAssignment(ctx, tx, actor, id, number, title, assignee); err != nil {
			return err
		}
		ticket, err = s.getByID(ctx, tx, id)
		return err
	})
	if err != nil {
		return nil, s.sourceConflict(ctx, sourceURL, err)
	}
	return ticket, nil
}

type change struct {
	From any `json:"from"`
	To   any `json:"to"`
}

// Update changes the main fields of a task (not status, not technical solution).
func (s *Service) Update(ctx context.Context, actor workflow.Actor, ref string, in UpdateInput) (*Ticket, error) {
	if err := actor.Require(workflow.PermTicketEdit); err != nil {
		return nil, err
	}
	var ticket *Ticket
	var attemptedSource string
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		id, err := s.ResolveID(ctx, tx, ref)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM tickets WHERE id = $1 FOR UPDATE`, id); err != nil {
			return err
		}
		cur, err := s.getByID(ctx, tx, id)
		if err != nil {
			return err
		}
		if in.IsEmpty() {
			ticket = cur
			return nil
		}
		next := *cur
		changes := map[string]any{}
		if err := in.ShortlistPatch.apply(&next.Shortlist, changes); err != nil {
			return err
		}

		if in.Title != nil {
			title, err := normalizeTitle(*in.Title)
			if err != nil {
				return err
			}
			if title != cur.Title {
				changes["title"] = change{cur.Title, title}
				next.Title = title
			}
		}
		if in.Description != nil && *in.Description != cur.Description {
			if err := validateDescription(*in.Description); err != nil {
				return err
			}
			changes["description"] = map[string]any{"changed": true}
			next.Description = *in.Description
		}
		if in.SourceURL != nil {
			v, err := normalizeURL(*in.SourceURL)
			if err != nil {
				return err
			}
			if v != cur.SourceURL {
				attemptedSource = v
				changes["source_url"] = change{cur.SourceURL, v}
				next.SourceURL = v
			}
		}
		if in.Deadline != nil {
			v, err := ParseDeadline(*in.Deadline, s.loc)
			if err != nil {
				return err
			}
			if !timePtrEqual(v, cur.Deadline) {
				changes["deadline"] = change{cur.Deadline, v}
				next.Deadline = v
			}
		}
		if in.Priority != nil && *in.Priority != cur.Priority {
			if err := validatePriority(*in.Priority); err != nil {
				return err
			}
			changes["priority"] = change{cur.Priority, *in.Priority}
			next.Priority = *in.Priority
		}
		assigneeChanged := false
		if in.AssigneeID != nil {
			var v *string
			if *in.AssigneeID != "" && *in.AssigneeID != "everyone" {
				if err := s.checkUser(ctx, tx, *in.AssigneeID); err != nil {
					return err
				}
				v = in.AssigneeID
			}
			if !strPtrEqual(v, cur.AssigneeID) {
				changes["assignee_id"] = change{cur.AssigneeName, userName(ctx, tx, v)}
				next.AssigneeID = v
				assigneeChanged = true
			}
		}
		if len(changes) == 0 {
			ticket = cur
			return nil
		}
		if _, err := tx.Exec(ctx, `
			UPDATE tickets SET title = $2, description = $3, source_url = $4, deadline = $5, priority = $6,
			       assignee_id = $7, fit_score = $8, complexity = $9, market = $10,
			       applications_count = $11, budget_amount = $12::text::numeric, currency = $13, customer = $14,
			       updated_at = now()
			WHERE id = $1`,
			id, next.Title, next.Description, next.SourceURL, next.Deadline, next.Priority, next.AssigneeID,
			next.FitScore, next.Complexity, next.Market, next.ApplicationsCount, next.BudgetAmount, next.Currency, next.Customer); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.FromActor(actor, "ticket.update", "ticket", id, map[string]any{
			"ticket_id": id, "number": cur.Number, "title": next.Title, "changes": changes,
		})); err != nil {
			return err
		}
		if assigneeChanged {
			if err := notifyAssignment(ctx, tx, actor, id, cur.Number, next.Title, next.AssigneeID); err != nil {
				return err
			}
		}
		ticket, err = s.getByID(ctx, tx, id)
		return err
	})
	if err != nil {
		return nil, s.sourceConflict(ctx, attemptedSource, err)
	}
	return ticket, nil
}

// Delete soft-deletes a task (admin only).
func (s *Service) Delete(ctx context.Context, actor workflow.Actor, ref string) error {
	if err := actor.Require(workflow.PermDelete); err != nil {
		return err
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		id, err := s.ResolveID(ctx, tx, ref)
		if err != nil {
			return err
		}
		var number, title string
		if err := tx.QueryRow(ctx, `UPDATE tickets SET deleted_at = now(), updated_at = now() WHERE id = $1
			RETURNING number, title`, id).Scan(&number, &title); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "ticket.delete", "ticket", id, map[string]any{
			"ticket_id": id, "number": number, "title": title,
		}))
	})
}

func userName(ctx context.Context, q db.Querier, id *string) *string {
	if id == nil {
		return nil
	}
	var n string
	if err := q.QueryRow(ctx, `SELECT full_name FROM users WHERE id = $1`, *id).Scan(&n); err != nil {
		return nil
	}
	return &n
}

func strPtrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func timePtrEqual(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
