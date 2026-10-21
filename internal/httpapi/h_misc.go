package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"onceplatform/internal/audit"
	"onceplatform/internal/tickets"
	"onceplatform/internal/workflow"
)

func (a *api) miscRoutes(r chi.Router) {
	r.Get("/search", a.searchAll)

	r.Get("/notifications", a.listNotifications)
	r.Get("/notifications/unread-count", a.unreadCount)
	r.Post("/notifications/read-all", a.readAllNotifications)
	r.Post("/notifications/{id}/read", a.readNotification)

	r.Get("/admin/audit", a.auditLog)
	r.Get("/admin/oauth-clients", a.oauthClients)
	r.Delete("/admin/oauth-clients/{id}", a.revokeOAuthClient)
}

func (a *api) searchAll(w http.ResponseWriter, r *http.Request) {
	res, err := a.search.Search(r.Context(), r.URL.Query().Get("q"), queryList(r, "kind"),
		queryInt(r, "limit", 10), queryInt(r, "offset", 0))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *api) listNotifications(w http.ResponseWriter, r *http.Request) {
	p, size := queryInt(r, "page", 1), queryInt(r, "page_size", 30)
	unreadOnly := r.URL.Query().Get("unread") == "1"
	userID := principal(r).User.ID
	list, total, err := a.notify.List(r.Context(), userID, unreadOnly, p, size)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	unread, err := a.notify.UnreadCount(r.Context(), userID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": list, "total": total, "page": max(p, 1), "page_size": size, "unread": unread,
	})
}

func (a *api) unreadCount(w http.ResponseWriter, r *http.Request) {
	n, err := a.notify.UnreadCount(r.Context(), principal(r).User.ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"unread": n})
}

func (a *api) readNotification(w http.ResponseWriter, r *http.Request) {
	if err := a.notify.MarkRead(r.Context(), principal(r).User.ID, chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) readAllNotifications(w http.ResponseWriter, r *http.Request) {
	if err := a.notify.MarkAllRead(r.Context(), principal(r).User.ID); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) auditLog(w http.ResponseWriter, r *http.Request) {
	act := actor(r)
	if err := act.Require(workflow.PermAuditView); err != nil {
		a.writeError(w, r, err)
		return
	}
	q := r.URL.Query()
	f := audit.Filter{
		UserID: q.Get("user_id"), Action: q.Get("action"), EntityType: q.Get("entity_type"),
		EntityID: q.Get("entity_id"), Via: q.Get("via"),
		Page: queryInt(r, "page", 1), PageSize: queryInt(r, "page_size", 50),
	}
	var err error
	if f.From, err = tickets.ParseDateBound(q.Get("from"), a.cfg.Location, false); err != nil {
		a.writeError(w, r, err)
		return
	}
	if f.To, err = tickets.ParseDateBound(q.Get("to"), a.cfg.Location, true); err != nil {
		a.writeError(w, r, err)
		return
	}
	list, total, err := audit.List(r.Context(), a.pool, f)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if f.PageSize < 1 || f.PageSize > 200 {
		f.PageSize = 50
	}
	writeJSON(w, http.StatusOK, page[audit.Record]{Items: list, Total: total, Page: max(f.Page, 1), PageSize: f.PageSize})
}

func (a *api) oauthClients(w http.ResponseWriter, r *http.Request) {
	list, err := a.oauth.ListClients(r.Context(), actor(r))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) revokeOAuthClient(w http.ResponseWriter, r *http.Request) {
	if err := a.oauth.RevokeClient(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
