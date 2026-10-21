package httpapi

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"onceplatform/internal/audit"
	"onceplatform/internal/tickets"
	"onceplatform/internal/workflow"
)

func (a *api) ticketRoutes(r chi.Router) {
	r.Get("/dashboard", a.dashboard)

	r.Get("/tickets", a.listTickets)
	r.Get("/tickets/export.csv", a.exportTickets)
	r.Get("/tickets/board", a.board)
	r.Post("/tickets", a.createTicket)
	r.Get("/tickets/{ref}", a.getTicket)
	r.Patch("/tickets/{ref}", a.updateTicket)
	r.Delete("/tickets/{ref}", a.deleteTicket)
	r.Post("/tickets/{ref}/status", a.changeStatus)
	r.Get("/tickets/{ref}/history", a.ticketHistory)

	r.Get("/tickets/{ref}/solution/versions", a.listVersions)
	r.Get("/tickets/{ref}/solution/versions/{vid}", a.getVersion)
	r.Post("/tickets/{ref}/solution/versions/{vid}/restore", a.restoreVersion)
	r.Put("/tickets/{ref}/solution", a.saveSolution)

	r.Get("/tickets/{ref}/comments", a.listComments)
	r.Post("/tickets/{ref}/comments", a.addComment)
	r.Patch("/comments/{id}", a.editComment)
	r.Delete("/comments/{id}", a.deleteComment)
}

func (a *api) dashboard(w http.ResponseWriter, r *http.Request) {
	o, err := a.tickets.Overview(r.Context(), principal(r).User.ID, true)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

// listFilter parses task list filters from query parameters.
func (a *api) listFilter(r *http.Request) (tickets.ListFilter, error) {
	q := r.URL.Query()
	f := tickets.ListFilter{
		Statuses:    queryList(r, "status"),
		Priorities:  queryList(r, "priority"),
		AssigneeIDs: queryList(r, "assignee_id"),
		Overdue:     q.Get("overdue") == "1" || q.Get("overdue") == "true",
		Q:           q.Get("q"),
		Sort:        q.Get("sort"),
		Order:       q.Get("order"),
		Page:        queryInt(r, "page", 1),
		PageSize:    queryInt(r, "page_size", 25),
	}
	if f.PageSize > 200 {
		f.PageSize = 200
	}
	me := principal(r).User.ID
	for i, id := range f.AssigneeIDs {
		if id == "me" {
			f.AssigneeIDs[i] = me
		}
	}
	if q.Get("mine") == "1" {
		f.MineUserID = me
	}
	var err error
	loc := a.cfg.Location
	if f.DeadlineFrom, err = tickets.ParseDateBound(q.Get("deadline_from"), loc, false); err != nil {
		return f, err
	}
	if f.DeadlineTo, err = tickets.ParseDateBound(q.Get("deadline_to"), loc, true); err != nil {
		return f, err
	}
	return f, nil
}

func (a *api) listTickets(w http.ResponseWriter, r *http.Request) {
	f, err := a.listFilter(r)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	items, total, err := a.tickets.List(r.Context(), f)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if f.Page < 1 {
		f.Page = 1
	}
	writeJSON(w, http.StatusOK, page[tickets.Ticket]{Items: items, Total: total, Page: f.Page, PageSize: f.PageSize})
}

func (a *api) board(w http.ResponseWriter, r *http.Request) {
	f, err := a.listFilter(r)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	cols, err := a.tickets.Board(r.Context(), f)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"columns": cols})
}

var csvPriorities = map[string]string{"low": "Low", "normal": "Normal", "high": "High", "urgent": "Urgent"}

// exportTickets streams the filtered list as CSV (UTF-8 with BOM and ';'
// delimiter, which Excel opens correctly with European locales).
func (a *api) exportTickets(w http.ResponseWriter, r *http.Request) {
	f, err := a.listFilter(r)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	f.Page, f.PageSize = 1, 10000
	items, _, err := a.tickets.List(r.Context(), f)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	loc := a.cfg.Location
	name := fmt.Sprintf("tasks-%s.csv", time.Now().In(loc).Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	_, _ = w.Write([]byte("\xEF\xBB\xBF"))
	cw := csv.NewWriter(w)
	cw.Comma = ';'
	_ = cw.Write([]string{"Number", "Title", "Status", "Result", "Priority", "Deadline", "Assignee", "Source link",
		"Created by", "Created", "Updated", "Link"})
	fmtTime := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return t.In(loc).Format("02.01.2006 15:04")
	}
	for _, t := range items {
		result := ""
		if t.CloseResult != "" {
			result = workflow.ResultLabel(workflow.CloseResult(t.CloseResult))
		}
		assignee := "Everyone"
		if t.AssigneeName != nil {
			assignee = *t.AssigneeName
		}
		_ = cw.Write([]string{
			t.Number, csvSafe(t.Title), workflow.StatusLabel(t.Status), result, csvPriorities[t.Priority],
			fmtTime(t.Deadline), assignee, csvSafe(t.SourceURL), t.CreatedByName, fmtTime(&t.CreatedAt),
			fmtTime(&t.UpdatedAt), a.cfg.BaseURL + "/tickets/" + t.Number,
		})
	}
	cw.Flush()
}

// csvSafe neutralizes spreadsheet formula injection.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

type ticketResponse struct {
	*tickets.Ticket
	Transitions []workflow.Transition `json:"transitions"`
}

func (a *api) ticketResp(r *http.Request, t *tickets.Ticket) ticketResponse {
	return ticketResponse{Ticket: t, Transitions: workflow.AvailableTransitions(principal(r).User.Role, t.Status)}
}

func (a *api) createTicket(w http.ResponseWriter, r *http.Request) {
	var in tickets.CreateInput
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	t, err := a.tickets.Create(r.Context(), actor(r), in)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, a.ticketResp(r, t))
}

func (a *api) getTicket(w http.ResponseWriter, r *http.Request) {
	t, err := a.tickets.Get(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.ticketResp(r, t))
}

func (a *api) updateTicket(w http.ResponseWriter, r *http.Request) {
	var in tickets.UpdateInput
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	t, err := a.tickets.Update(r.Context(), actor(r), chi.URLParam(r, "ref"), in)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.ticketResp(r, t))
}

func (a *api) deleteTicket(w http.ResponseWriter, r *http.Request) {
	if err := a.tickets.Delete(r.Context(), actor(r), chi.URLParam(r, "ref")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) changeStatus(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Status  string `json:"status"`
		Comment string `json:"comment"`
		Result  string `json:"result"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	t, err := a.tickets.ChangeStatus(r.Context(), actor(r), chi.URLParam(r, "ref"),
		workflow.Status(in.Status), in.Comment, workflow.CloseResult(in.Result))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a.ticketResp(r, t))
}

func (a *api) ticketHistory(w http.ResponseWriter, r *http.Request) {
	statuses, events, err := a.tickets.History(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if events == nil {
		events = []audit.Record{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"statuses": statuses, "events": events})
}

func (a *api) listVersions(w http.ResponseWriter, r *http.Request) {
	list, err := a.tickets.ListSolutionVersions(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) getVersion(w http.ResponseWriter, r *http.Request) {
	v, err := a.tickets.GetSolutionVersion(r.Context(), chi.URLParam(r, "ref"), chi.URLParam(r, "vid"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *api) restoreVersion(w http.ResponseWriter, r *http.Request) {
	v, err := a.tickets.RestoreSolutionVersion(r.Context(), actor(r), chi.URLParam(r, "ref"), chi.URLParam(r, "vid"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *api) saveSolution(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Body string `json:"body"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	v, err := a.tickets.SaveSolution(r.Context(), actor(r), chi.URLParam(r, "ref"), in.Body)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *api) listComments(w http.ResponseWriter, r *http.Request) {
	list, err := a.tickets.ListComments(r.Context(), chi.URLParam(r, "ref"), 0)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) addComment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Body string `json:"body"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	c, err := a.tickets.AddComment(r.Context(), actor(r), chi.URLParam(r, "ref"), in.Body)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (a *api) editComment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Body string `json:"body"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	c, err := a.tickets.EditComment(r.Context(), actor(r), chi.URLParam(r, "id"), in.Body)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *api) deleteComment(w http.ResponseWriter, r *http.Request) {
	if err := a.tickets.DeleteComment(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
