package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"onceplatform/internal/auth"
	"onceplatform/internal/files"
	"onceplatform/internal/search"
	"onceplatform/internal/tickets"
	"onceplatform/internal/workflow"
)

func (a *api) authRoutes(r chi.Router) {
	r.Post("/auth/logout", a.logout)
	r.Get("/auth/me", a.me)
	r.Patch("/auth/me", a.updateMe)
	r.Post("/auth/password", a.changePassword)

	r.Get("/users", a.listUsers)
	r.Post("/users", a.createUser)
	r.Patch("/users/{id}", a.updateUser)
	r.Post("/users/{id}/reset-password", a.resetPassword)

	r.Get("/me/tokens", a.listTokens)
	r.Post("/me/tokens", a.createToken)
	r.Delete("/me/tokens/{id}", a.revokeToken)
	r.Get("/me/oauth-grants", a.listGrants)
	r.Delete("/me/oauth-grants/{clientId}", a.revokeGrant)
}

type meResponse struct {
	User        *auth.User            `json:"user"`
	Permissions []workflow.Permission `json:"permissions"`
	CSRFToken   string                `json:"csrf_token,omitempty"`
}

func (a *api) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	res, err := a.auth.Login(r.Context(), in.Username, in.Password, auth.ClientIP(r), r.UserAgent())
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	auth.SetSessionCookie(w, r, res.Token, res.Session.ExpiresAt)
	csrf := a.auth.CSRF.Issue(res.Session.ID)
	auth.SetCSRFCookie(w, r, csrf)
	writeJSON(w, http.StatusOK, meResponse{User: res.User, Permissions: workflow.PermissionsFor(res.User.Role), CSRFToken: csrf})
}

func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	if err := a.auth.Logout(r.Context(), auth.SessionToken(r), auth.ClientIP(r)); err != nil {
		a.writeError(w, r, err)
		return
	}
	auth.ClearSessionCookie(w, r)
	auth.SetCSRFCookie(w, r, a.auth.CSRF.Issue(auth.AnonymousBinding))
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) me(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	csrf := a.auth.CSRF.EnsureCSRFCookie(w, r, auth.CSRFBinding(p))
	writeJSON(w, http.StatusOK, meResponse{User: p.User, Permissions: workflow.PermissionsFor(p.User.Role), CSRFToken: csrf})
}

// updateMe changes the user's own preferences (interface language).
func (a *api) updateMe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Language string `json:"language"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	u, err := a.auth.SetLanguage(r.Context(), actor(r), in.Language)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, meResponse{User: u, Permissions: workflow.PermissionsFor(u.Role)})
}

func (a *api) csrf(w http.ResponseWriter, r *http.Request) {
	tok := a.auth.CSRF.EnsureCSRFCookie(w, r, auth.CSRFBinding(principal(r)))
	writeJSON(w, http.StatusOK, map[string]string{"csrf_token": tok})
}

func (a *api) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	if err := a.auth.ChangePassword(r.Context(), actor(r), principal(r).SessionID, in.CurrentPassword, in.NewPassword); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) meta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"app_name":           "OncePlatform",
		"version":            a.version,
		"base_url":           a.cfg.BaseURL,
		"mcp_url":            a.cfg.MCPResourceURL(),
		"https":              a.cfg.HTTPS(),
		"timezone":           a.cfg.Timezone,
		"upload_max_mb":      a.cfg.UploadMaxMB,
		"allowed_extensions": files.AllowedExtensions(),
		"statuses":           workflow.Statuses,
		"close_results":      workflow.CloseResults,
		"priorities":         tickets.Priorities,
		"languages":          auth.Languages,
		"file_categories":    files.Categories,
		"roles":              workflow.Roles,
		"search_marks":       []string{search.MarkStart, search.MarkStop},
	})
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

func (a *api) listUsers(w http.ResponseWriter, r *http.Request) {
	act := actor(r)
	includeInactive := r.URL.Query().Get("include_inactive") == "1" && act.Can(workflow.PermUsersManage)
	users, err := a.auth.ListUsers(r.Context(), includeInactive)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	if !act.Can(workflow.PermUsersManage) {
		for i := range users {
			users[i].LastLoginAt = nil
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": users})
}

func (a *api) createUser(w http.ResponseWriter, r *http.Request) {
	var in auth.CreateUserInput
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	act := actor(r)
	u, err := a.auth.CreateUser(r.Context(), &act, in)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (a *api) updateUser(w http.ResponseWriter, r *http.Request) {
	var in auth.UpdateUserInput
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	u, err := a.auth.UpdateUser(r.Context(), actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *api) resetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if r.ContentLength != 0 {
		if err := decode(w, r, &in); err != nil {
			a.writeError(w, r, err)
			return
		}
	}
	pw, err := a.auth.ResetPassword(r.Context(), actor(r), chi.URLParam(r, "id"), in.Password)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"password": pw})
}

// ---------------------------------------------------------------------------
// Personal API tokens and connected OAuth applications
// ---------------------------------------------------------------------------

func (a *api) listTokens(w http.ResponseWriter, r *http.Request) {
	list, err := a.auth.ListAPITokens(r.Context(), principal(r).User.ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) createToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name          string `json:"name"`
		ExpiresInDays int    `json:"expires_in_days"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	plain, tok, err := a.auth.CreateAPIToken(r.Context(), actor(r), in.Name, in.ExpiresInDays)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": plain, "item": tok})
}

func (a *api) revokeToken(w http.ResponseWriter, r *http.Request) {
	if err := a.auth.RevokeAPIToken(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) listGrants(w http.ResponseWriter, r *http.Request) {
	list, err := a.oauth.ListGrants(r.Context(), principal(r).User.ID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) revokeGrant(w http.ResponseWriter, r *http.Request) {
	if err := a.oauth.RevokeGrant(r.Context(), actor(r), chi.URLParam(r, "clientId")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
