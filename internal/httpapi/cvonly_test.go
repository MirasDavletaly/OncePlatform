package httpapi

import (
	"net/http"
	"net/http/httptest"
	"path"
	"testing"

	"github.com/go-chi/chi/v5"

	"onceplatform/internal/auth"
	"onceplatform/internal/workflow"
)

// The recruiter reaches the CV section and their own session only.
func TestCVAllowed(t *testing.T) {
	for _, p := range []string{"/api/v1/cv/candidates", "/api/v1/cv/documents/x/file", "/api/v1/auth/logout", "/api/v1/auth/password", "/api/v1/auth/me"} {
		if !cvAllowed(path.Clean(p)) {
			t.Errorf("%s must be open to the recruiter", p)
		}
	}
	for _, p := range []string{"/api/v1/tickets", "/api/v1/tickets/T-2026-0001/cv", "/api/v1/search", "/api/v1/users", "/api/v1/me/tokens",
		"/api/v1/dashboard", "/api/v1/notifications", "/api/v1/attachments/x/download", "/api/v1/cv/../tickets", "/api/v1/cvx"} {
		if cvAllowed(path.Clean(p)) {
			t.Errorf("%s must be closed to the recruiter", p)
		}
	}
}

// The check follows the route the router matched, so encoded slashes and dots that make a ticket path look like a
// CV path do not get through (the router layout of router.go: a group with cvOnly under /api/v1).
func TestCVOnlyFollowsTheRoute(t *testing.T) {
	recruiter := &auth.Principal{User: &auth.User{ID: "u", Role: workflow.RoleRecruiter, IsActive: true}, Kind: "session"}
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					next.ServeHTTP(w, req.WithContext(auth.WithPrincipal(req.Context(), recruiter)))
				})
			})
			r.Use(cvOnly)
			ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }
			r.Get("/cv/candidates/{id}", ok)
			r.Get("/tickets/{ref}/attachments", ok)
			r.Get("/tickets/{ref}/solution/versions/{version}", ok)
			r.Get("/auth/me", ok)
		})
	})
	for target, want := range map[string]int{
		"/api/v1/cv/candidates/x": http.StatusNoContent,
		"/api/v1/auth/me":         http.StatusNoContent,
		"/api/v1/tickets/T-2026-0001%2f..%2f..%2fcv%2fx/attachments":          http.StatusForbidden,
		"/api/v1/tickets/T-2026-0001/solution/versions/..%2f..%2f..%2fcv%2fz": http.StatusForbidden,
		"/api/v1/tickets/T-2026-0001/attachments":                             http.StatusForbidden,
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != want {
			t.Errorf("%s: %d, want %d", target, w.Code, want)
		}
	}
}
