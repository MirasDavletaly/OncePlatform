package mcp

import (
	"context"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"onceplatform/internal/apperr"
	"onceplatform/internal/files"
	"onceplatform/internal/tickets"
	"onceplatform/internal/workflow"
)

var (
	statusEnum   = []string{"new", "analysis", "solution", "sent", "closed"}
	resultEnum   = []string{"won", "lost", "cancelled", "no_bid"}
	priorityEnum = tickets.Priorities
)

type noInput struct{}

type listTicketsInput struct {
	tickets.ShortlistFilter
	Status       []string `json:"status,omitempty" jsonschema:"Filter by one or more statuses"`
	Priority     []string `json:"priority,omitempty" jsonschema:"Filter by priority"`
	Assignee     string   `json:"assignee,omitempty" jsonschema:"Assignee: login, full name, user id, 'me' or 'everyone' (tasks for the whole team)"`
	Mine         bool     `json:"mine,omitempty" jsonschema:"Only tasks of the current user plus tasks for everyone"`
	DeadlineFrom string   `json:"deadline_from,omitempty" jsonschema:"Deadline on or after this date (YYYY-MM-DD, portal time zone)"`
	DeadlineTo   string   `json:"deadline_to,omitempty" jsonschema:"Deadline on or before this date (YYYY-MM-DD, portal time zone)"`
	Overdue      bool     `json:"overdue,omitempty" jsonschema:"Only overdue tasks; sent and closed are excluded"`
	Query        string   `json:"query,omitempty" jsonschema:"Free-text search in number, title and description"`
	Sort         string   `json:"sort,omitempty" jsonschema:"Sort field (default created_at)"`
	Order        string   `json:"order,omitempty" jsonschema:"Sort order (default desc)"`
	Limit        int      `json:"limit,omitempty" jsonschema:"Page size, default 20, maximum 100"`
	Offset       int      `json:"offset,omitempty" jsonschema:"Number of tasks to skip"`
}

type ticketRef struct {
	TicketID string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
}

type createTicketInput struct {
	shortlistInput
	Title       string `json:"title" jsonschema:"Short title"`
	Priority    string `json:"priority,omitempty" jsonschema:"Priority, default normal"`
	SourceURL   string `json:"source_url,omitempty" jsonschema:"Link to the tender or request (http/https)"`
	Deadline    string `json:"deadline,omitempty" jsonschema:"Deadline: '2026-11-05 18:00' (portal time zone), RFC 3339, or a date '2026-11-05' meaning 23:59 that day"`
	Assignee    string `json:"assignee,omitempty" jsonschema:"Assignee: login, full name or 'me'; empty or 'everyone' means the whole team"`
	Description string `json:"description,omitempty" jsonschema:"Optional description in Markdown"`
}

type updateTicketInput struct {
	shortlistInput
	ClearFields []string `json:"clear_fields,omitempty" jsonschema:"Clear nullable shortlist fields: fit_score, complexity, applications_count, budget_amount. Do not also provide a value for a cleared field."`
	TicketID    string   `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Title       *string  `json:"title,omitempty" jsonschema:"New title"`
	Priority    *string  `json:"priority,omitempty" jsonschema:"Priority"`
	SourceURL   *string  `json:"source_url,omitempty" jsonschema:"Source link; empty string clears it"`
	Deadline    *string  `json:"deadline,omitempty" jsonschema:"Deadline (same formats as create_ticket); empty string clears it"`
	Assignee    *string  `json:"assignee,omitempty" jsonschema:"Assignee: login, full name or 'me'; 'everyone' assigns the task to the whole team"`
	Description *string  `json:"description,omitempty" jsonschema:"New description (Markdown), replaces the old one"`
}

type changeStatusInput struct {
	LossReason string `json:"loss_reason,omitempty" jsonschema:"Required for result lost: price, competitor, no_response, requirements. Use evidence or ask the user; never invent a reason. Put supporting details in comment."`
	TicketID   string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Status     string `json:"status" jsonschema:"Target status"`
	Result     string `json:"result,omitempty" jsonschema:"Required when status is closed"`
	Comment    string `json:"comment,omitempty" jsonschema:"Required when moving a task back to an earlier status: explain why"`
}

type saveSolutionInput struct {
	TicketID string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Markdown string `json:"markdown" jsonschema:"Full technical solution in Markdown. Replaces the current text; previous versions are kept in history"`
}

type addCommentInput struct {
	TicketID string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Body     string `json:"body" jsonschema:"Comment text in Markdown; @login mentions notify users"`
}

func (s *server) registerTicketTools(srv *sdk.Server) {
	sdk.AddTool(srv, &sdk.Tool{
		Name:        "get_overview",
		Description: "Get a summary of the portal: task counts per status, the current user's open tasks (including tasks for everyone), deadlines within the next 7 days and overdue tasks.",
		InputSchema: inputSchema[noInput](nil),
		Annotations: readOnly("Portal overview"),
	}, s.getOverview)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "list_tickets",
		Description: "List tasks with filters including shortlist score/count ranges, market, customer, amount, loss_reason and canonical source_url. Amount bounds/sorting require currency. Returns 20 tasks by default, at most 100 per call; use offset to page.",
		InputSchema: inputSchema[listTicketsInput](map[string][]string{
			"status": statusEnum, "priority": priorityEnum,
			"sort":  {"created_at", "updated_at", "deadline", "priority", "status", "title", "number", "fit_score", "complexity", "market", "applications_count", "budget_amount", "currency", "customer"},
			"order": {"asc", "desc"},
		}),
		Annotations: readOnly("List tasks"),
	}, s.listTickets)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "get_ticket",
		Description: "Get the full task card: fields, description, technical solution, latest comments, attachments, status history and the status transitions available to the current user.",
		InputSchema: inputSchema[ticketRef](nil),
		Annotations: readOnly("Get task"),
	}, s.getTicket)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "create_ticket",
		Description: "Create a new task (status 'new'). Allowed for admin and coordinator roles.",
		InputSchema: inputSchema[createTicketInput](map[string][]string{"priority": priorityEnum}),
		Annotations: writeAnn("Create task", false, false),
	}, s.createTicket)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "update_ticket",
		Description: "Partially update the main fields of a task; only the provided fields change. Does not change status or the technical solution. Allowed for admin and coordinator roles.",
		InputSchema: inputSchema[updateTicketInput](map[string][]string{"priority": priorityEnum}),
		Annotations: writeAnn("Update task", true, true),
	}, s.updateTicket)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "change_ticket_status",
		Description: "Move a task to another status following the workflow (new → analysis → solution → sent → closed). Closing requires 'result', and 'loss_reason' when lost; moving back requires 'comment'. Permissions depend on the user's role.",
		InputSchema: inputSchema[changeStatusInput](map[string][]string{"status": statusEnum, "result": resultEnum, "loss_reason": workflow.LossReasons}),
		Annotations: writeAnn("Change task status", false, false),
	}, s.changeStatus)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "save_technical_solution",
		Description: "Save the technical solution of a task (Markdown). Creates a new version; older versions are never lost. Allowed for admin and analyst roles.",
		InputSchema: inputSchema[saveSolutionInput](nil),
		Annotations: writeAnn("Save technical solution", false, true),
	}, s.saveSolution)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "add_comment",
		Description: "Add a comment (Markdown) to a task. The comment is marked as written via Claude.",
		InputSchema: inputSchema[addCommentInput](nil),
		Annotations: writeAnn("Add comment", false, false),
	}, s.addComment)
}

func (s *server) getOverview(ctx context.Context, req *sdk.CallToolRequest, _ noInput) (*sdk.CallToolResult, any, error) {
	_, me, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	o, err := s.Tickets.Overview(ctx, me.ID, false)
	if err != nil {
		return nil, nil, s.toolError("get_overview", err)
	}
	return nil, map[string]any{
		"current_user":      map[string]string{"id": me.ID, "login": me.Username, "name": me.FullName, "role": string(me.Role)},
		"counts_by_status":  o.Counts,
		"closed_by_result":  o.ClosedByResult,
		"lost_by_reason":    o.LostByReason,
		"total":             o.Total,
		"my_open_tickets":   s.summaries(o.MyTickets),
		"deadlines_next_7d": s.summaries(o.UpcomingDeadlines),
		"overdue":           s.summaries(o.Overdue),
		"portal_url":        s.Cfg.BaseURL,
		"portal_timezone":   s.Cfg.Timezone,
	}, nil
}

func (s *server) listTickets(ctx context.Context, req *sdk.CallToolRequest, in listTicketsInput) (*sdk.CallToolResult, any, error) {
	_, me, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if in.Offset < 0 {
		in.Offset = 0
	}
	f := tickets.ListFilter{
		ShortlistFilter: in.ShortlistFilter,
		Statuses:        in.Status, Priorities: in.Priority, Overdue: in.Overdue, Q: in.Query, Sort: in.Sort, Order: in.Order,
	}
	if in.Mine {
		f.MineUserID = me.ID
	}
	if in.Assignee != "" {
		id, err := s.resolveUser(ctx, me, in.Assignee)
		if err != nil {
			return nil, nil, s.toolError("list_tickets", err)
		}
		if id == "" {
			f.AssigneeIDs = []string{"everyone"}
		} else {
			f.AssigneeIDs = []string{id}
		}
	}
	loc := s.Tickets.Location()
	if f.DeadlineFrom, err = tickets.ParseDateBound(in.DeadlineFrom, loc, false); err != nil {
		return nil, nil, s.toolError("list_tickets", err)
	}
	if f.DeadlineTo, err = tickets.ParseDateBound(in.DeadlineTo, loc, true); err != nil {
		return nil, nil, s.toolError("list_tickets", err)
	}
	// The service pages by page number; emulate offset/limit.
	f.PageSize = in.Offset + limit
	f.Page = 1
	items, total, err := s.Tickets.List(ctx, f)
	if err != nil {
		return nil, nil, s.toolError("list_tickets", err)
	}
	if in.Offset < len(items) {
		items = items[in.Offset:]
	} else {
		items = nil
	}
	out := map[string]any{"total": total, "offset": in.Offset, "items": s.summaries(items)}
	if next := in.Offset + len(items); next < total {
		out["next_offset"] = next
	}
	return nil, out, nil
}

func (s *server) getTicket(ctx context.Context, req *sdk.CallToolRequest, in ticketRef) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	t, err := s.Tickets.Get(ctx, in.TicketID)
	if err != nil {
		return nil, nil, s.toolError("get_ticket", err)
	}
	comments, err := s.Tickets.ListComments(ctx, t.ID, 10)
	if err != nil {
		return nil, nil, s.toolError("get_ticket", err)
	}
	atts, err := s.Files.List(ctx, files.Target{TicketID: t.ID})
	if err != nil {
		return nil, nil, s.toolError("get_ticket", err)
	}
	statuses, err := s.Tickets.StatusHistory(ctx, t.ID)
	if err != nil {
		return nil, nil, s.toolError("get_ticket", err)
	}
	cm := make([]map[string]any, 0, len(comments))
	for _, c := range comments {
		cm = append(cm, map[string]any{"id": c.ID, "author": c.AuthorName, "body": c.Body, "via": c.Via,
			"created_at": s.fmtTime(&c.CreatedAt)})
	}
	sh := make([]map[string]any, 0, len(statuses))
	for _, h := range statuses {
		row := map[string]any{"to": h.ToStatus, "by": h.ChangedName, "at": s.fmtTime(&h.CreatedAt), "via": h.Via}
		if h.FromStatus != nil {
			row["from"] = *h.FromStatus
		}
		if h.Comment != "" {
			row["comment"] = h.Comment
		}
		if h.CloseResult != "" {
			row["result"] = h.CloseResult
			row["loss_reason"] = h.LossReason
		}
		sh = append(sh, row)
	}
	out := map[string]any{
		"ticket":                s.summary(t),
		"description":           t.Description,
		"technical_solution":    t.TechnicalSolution,
		"created_by":            t.CreatedByName,
		"created_at":            s.fmtTime(&t.CreatedAt),
		"closed_at":             s.fmtTime(t.ClosedAt),
		"comments_total":        t.CommentsCount,
		"latest_comments":       cm,
		"attachments":           s.attachmentList(atts),
		"status_history":        sh,
		"available_transitions": workflow.AvailableTransitions(actor.Role, t.Status),
	}
	return nil, out, nil
}

func (s *server) createTicket(ctx context.Context, req *sdk.CallToolRequest, in createTicketInput) (*sdk.CallToolResult, any, error) {
	actor, me, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	ci := tickets.CreateInput{Shortlist: in.shortlistInput.values(), Title: in.Title, Description: in.Description, SourceURL: in.SourceURL, Priority: in.Priority}
	if in.Deadline != "" {
		ci.Deadline = &in.Deadline
	}
	if in.Assignee != "" {
		id, err := s.resolveUser(ctx, me, in.Assignee)
		if err != nil {
			return nil, nil, s.toolError("create_ticket", err)
		}
		if id != "" {
			ci.AssigneeID = &id
		}
	}
	t, err := s.Tickets.Create(ctx, actor, ci)
	if err != nil {
		return nil, nil, s.toolError("create_ticket", err)
	}
	return nil, map[string]any{"created": true, "ticket": s.summary(t)}, nil
}

func (s *server) updateTicket(ctx context.Context, req *sdk.CallToolRequest, in updateTicketInput) (*sdk.CallToolResult, any, error) {
	actor, me, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	patch, err := in.shortlistInput.patch(in.ClearFields)
	if err != nil {
		return nil, nil, s.toolError("update_ticket", err)
	}
	ui := tickets.UpdateInput{ShortlistPatch: patch, Title: in.Title, Description: in.Description, SourceURL: in.SourceURL,
		Deadline: in.Deadline, Priority: in.Priority}
	if in.Assignee != nil {
		id, err := s.resolveUser(ctx, me, strings.TrimSpace(*in.Assignee))
		if err != nil {
			return nil, nil, s.toolError("update_ticket", err)
		}
		ui.AssigneeID = &id
	}
	if ui.IsEmpty() {
		return nil, nil, s.toolError("update_ticket", apperr.Validation("No fields to update were provided"))
	}
	t, err := s.Tickets.Update(ctx, actor, in.TicketID, ui)
	if err != nil {
		return nil, nil, s.toolError("update_ticket", err)
	}
	return nil, map[string]any{"updated": true, "ticket": s.summary(t)}, nil
}

func (s *server) changeStatus(ctx context.Context, req *sdk.CallToolRequest, in changeStatusInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	t, err := s.Tickets.ChangeStatus(ctx, actor, in.TicketID, workflow.Status(in.Status), in.Comment, workflow.CloseResult(in.Result), in.LossReason)
	if err != nil {
		return nil, nil, s.toolError("change_ticket_status", err)
	}
	return nil, map[string]any{
		"changed":               true,
		"ticket":                s.summary(t),
		"available_transitions": workflow.AvailableTransitions(actor.Role, t.Status),
	}, nil
}

func (s *server) saveSolution(ctx context.Context, req *sdk.CallToolRequest, in saveSolutionInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	v, err := s.Tickets.SaveSolution(ctx, actor, in.TicketID, in.Markdown)
	if err != nil {
		return nil, nil, s.toolError("save_technical_solution", err)
	}
	t, err := s.Tickets.Get(ctx, v.TicketID)
	if err != nil {
		return nil, nil, s.toolError("save_technical_solution", err)
	}
	return nil, map[string]any{
		"saved": true, "version_id": v.ID, "length": v.Length, "saved_at": s.fmtTime(&v.CreatedAt),
		"ticket_number": t.Number, "url": s.ticketURL(t.Number),
	}, nil
}

func (s *server) addComment(ctx context.Context, req *sdk.CallToolRequest, in addCommentInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	c, err := s.Tickets.AddComment(ctx, actor, in.TicketID, in.Body)
	if err != nil {
		return nil, nil, s.toolError("add_comment", err)
	}
	return nil, map[string]any{"created": true, "comment_id": c.ID, "author": c.AuthorName,
		"created_at": s.fmtTime(&c.CreatedAt), "via": c.Via}, nil
}
