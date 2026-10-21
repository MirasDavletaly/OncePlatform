package httpapi

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/auth"
	"onceplatform/internal/config"
	"onceplatform/internal/files"
	"onceplatform/internal/notify"
	"onceplatform/internal/oauth"
	"onceplatform/internal/search"
	"onceplatform/internal/tickets"
)

// Deps are the dependencies of the HTTP layer.
type Deps struct {
	Cfg     *config.Config
	Log     *slog.Logger
	Pool    *pgxpool.Pool
	Version string
	Auth    *auth.Service
	OAuth   *oauth.Server
	Tickets *tickets.Service
	Files   *files.Service
	Search  *search.Service
	Notify  *notify.Service
	MCP     http.Handler
	Web     fs.FS // built SPA (may be nil when the frontend was not built)
}

type api struct {
	cfg     *config.Config
	log     *slog.Logger
	pool    *pgxpool.Pool
	version string
	auth    *auth.Service
	oauth   *oauth.Server
	tickets *tickets.Service
	files   *files.Service
	search  *search.Service
	notify  *notify.Service
}

// NewRouter builds the root HTTP handler.
func NewRouter(d Deps) http.Handler {
	a := &api{
		cfg: d.Cfg, log: d.Log, pool: d.Pool, version: d.Version, auth: d.Auth, oauth: d.OAuth,
		tickets: d.Tickets, files: d.Files, search: d.Search, notify: d.Notify,
	}
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(a.accessLog)
	r.Use(a.recoverer)
	r.Use(securityHeaders)
	r.Use(a.loadSession)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", a.readyz)

	// OAuth 2.1 / MCP authorization discovery (RFC 9728, RFC 8414).
	prm := oauth.CORS(d.OAuth.ProtectedResourceMetadata)
	asm := oauth.CORS(d.OAuth.AuthorizationServerMetadata)
	r.Method(http.MethodGet, "/.well-known/oauth-protected-resource", prm)
	r.Method(http.MethodOptions, "/.well-known/oauth-protected-resource", prm)
	r.Method(http.MethodGet, "/.well-known/oauth-protected-resource/*", prm)
	r.Method(http.MethodGet, "/.well-known/oauth-authorization-server", asm)
	r.Method(http.MethodOptions, "/.well-known/oauth-authorization-server", asm)
	r.Method(http.MethodGet, "/.well-known/oauth-authorization-server/*", asm)

	r.Route("/oauth", func(r chi.Router) {
		r.HandleFunc("/register", oauth.CORS(d.OAuth.Register))
		r.Get("/authorize", d.OAuth.Authorize)
		r.Post("/authorize", d.OAuth.AuthorizeSubmit)
		r.HandleFunc("/token", oauth.CORS(d.OAuth.Token))
		r.HandleFunc("/revoke", oauth.CORS(d.OAuth.Revoke))
	})

	if d.MCP != nil {
		r.Handle("/mcp", mcpCORS(d.MCP))
	}

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(noStore)
		r.Use(middleware.Compress(5, "application/json"))
		r.Use(a.csrfProtect)

		r.Post("/auth/login", a.login)
		r.Get("/auth/csrf", a.csrf)
		r.Get("/meta", a.meta)

		r.Group(func(r chi.Router) {
			r.Use(requireUser)
			a.authRoutes(r)
			a.ticketRoutes(r)
			a.fileRoutes(r)
			a.miscRoutes(r)
		})

		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			writeErrorCode(w, http.StatusNotFound, "not_found", "API method not found")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
			writeErrorCode(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		})
	})

	spa := newSPA(d.Web, d.Log)
	r.NotFound(spa.ServeHTTP)
	r.MethodNotAllowed(spa.ServeHTTP)
	return r
}

func (a *api) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.pool.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "database": "down"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "database": "up"})
}
