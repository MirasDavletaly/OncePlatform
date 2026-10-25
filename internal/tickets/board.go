package tickets

import (
	"context"
	"strconv"

	"onceplatform/internal/audit"
	"onceplatform/internal/workflow"
)

// BoardColumn is one kanban column.
type BoardColumn struct {
	Status workflow.Status `json:"status"`
	Total  int             `json:"total"`
	Items  []Ticket        `json:"items"`
}

// Board returns tickets grouped by status for the kanban view. The closed
// column only shows tickets closed during the last 30 days.
func (s *Service) Board(ctx context.Context, f ListFilter) ([]BoardColumn, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	f.Statuses = nil
	where, args := f.where()
	where += ` AND (t.status <> 'closed' OR t.closed_at > now() - interval '30 days')`
	rows, err := s.pool.Query(ctx, selectBrief+where+`
		ORDER BY array_position(ARRAY['urgent','high','normal','low'], t.priority),
		         t.deadline ASC NULLS LAST, t.created_at DESC
		LIMIT 2000`, args...)
	if err != nil {
		return nil, err
	}
	items, err := collectTickets(rows)
	if err != nil {
		return nil, err
	}
	cols := make([]BoardColumn, len(workflow.Statuses))
	idx := map[workflow.Status]int{}
	for i, st := range workflow.Statuses {
		cols[i] = BoardColumn{Status: st, Items: []Ticket{}}
		idx[st] = i
	}
	for _, t := range items {
		if i, ok := idx[t.Status]; ok {
			cols[i].Items = append(cols[i].Items, t)
			cols[i].Total++
		}
	}
	return cols, nil
}

// Overview is the dashboard summary.
type Overview struct {
	LostByReason      map[string]int `json:"lost_by_reason"`
	Counts            map[string]int `json:"counts"`
	ClosedByResult    map[string]int `json:"closed_by_result"`
	Total             int            `json:"total"`
	MyTickets         []Ticket       `json:"my_tickets"`
	UpcomingDeadlines []Ticket       `json:"upcoming_deadlines"`
	Overdue           []Ticket       `json:"overdue"`
	Activity          []audit.Record `json:"activity,omitempty"`
}

// Overview returns counts per status, the user's open tickets, deadlines in
// the next 7 days and overdue tickets. Activity is included when withActivity.
func (s *Service) Overview(ctx context.Context, userID string, withActivity bool) (*Overview, error) {
	o := &Overview{
		Counts:         map[string]int{},
		ClosedByResult: map[string]int{},
	}
	for _, st := range workflow.Statuses {
		o.Counts[string(st)] = 0
	}
	rows, err := s.pool.Query(ctx, `SELECT status, close_result, count(*) FROM tickets WHERE deleted_at IS NULL GROUP BY 1, 2`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var st, res string
		var n int
		if err := rows.Scan(&st, &res, &n); err != nil {
			rows.Close()
			return nil, err
		}
		o.Counts[st] += n
		o.Total += n
		if res != "" {
			o.ClosedByResult[res] += n
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	o.LostByReason = map[string]int{"price": 0, "competitor": 0, "no_response": 0, "requirements": 0, "unknown": 0}
	reasonRows, err := s.pool.Query(ctx, `SELECT COALESCE(NULLIF(loss_reason, ''), 'unknown'), count(*) FROM tickets WHERE deleted_at IS NULL AND close_result = 'lost' GROUP BY 1`)
	if err != nil {
		return nil, err
	}
	for reasonRows.Next() {
		var reason string
		var n int
		if err := reasonRows.Scan(&reason, &n); err != nil {
			reasonRows.Close()
			return nil, err
		}
		o.LostByReason[reason] = n
	}
	reasonRows.Close()
	if err := reasonRows.Err(); err != nil {
		return nil, err
	}

	query := func(cond string, order string, limit int, args ...any) ([]Ticket, error) {
		rows, err := s.pool.Query(ctx, selectBrief+` WHERE t.deleted_at IS NULL AND `+cond+` ORDER BY `+order+
			` LIMIT `+strconv.Itoa(limit), args...)
		if err != nil {
			return nil, err
		}
		return collectTickets(rows)
	}
	if o.MyTickets, err = query(`(t.assignee_id = $1 OR t.assignee_id IS NULL) AND t.status <> 'closed'`,
		`t.deadline ASC NULLS LAST, t.updated_at DESC`, 20, userID); err != nil {
		return nil, err
	}
	if o.UpcomingDeadlines, err = query(`t.status NOT IN ('sent', 'closed') AND t.deadline >= now() AND t.deadline < now() + interval '7 days'`,
		`t.deadline ASC`, 50); err != nil {
		return nil, err
	}
	if o.Overdue, err = query(`t.status NOT IN ('sent', 'closed') AND t.deadline < now()`, `t.deadline ASC`, 50); err != nil {
		return nil, err
	}
	if withActivity {
		if o.Activity, err = audit.Activity(ctx, s.pool, 25); err != nil {
			return nil, err
		}
	}
	return o, nil
}
