package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"onceplatform/internal/auth"
	"onceplatform/internal/workflow"
)

// reqInfo is filled in by later middleware and read by the access logger.
type reqInfo struct {
	userID string
}

type reqInfoKey struct{}

func requestID(r *http.Request) string { return middleware.GetReqID(r.Context()) }

// accessLog logs every request as a JSON line (except health checks).
func (a *api) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		info := &reqInfo{}
		r = r.WithContext(context.WithValue(r.Context(), reqInfoKey{}, info))
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		level := slog.LevelInfo
		if ww.Status() >= 500 {
			level = slog.LevelError
		}
		a.log.LogAttrs(r.Context(), level, "http request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", ww.Status()),
			slog.Int("bytes", ww.BytesWritten()),
			slog.Int64("duration_ms", time.Since(start).Milliseconds()),
			slog.String("ip", auth.ClientIP(r)),
			slog.String("user_id", info.userID),
			slog.String("request_id", requestID(r)),
		)
	})
}

// recoverer converts panics into 500 responses and logs the stack.
func (a *api) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				a.log.Error("panic", "error", fmt.Sprint(rec), "path", r.URL.Path, "stack", string(debug.Stack()),
					"request_id", requestID(r))
				writeErrorCode(w, http.StatusInternalServerError, "internal", "Internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// contentSecurityPolicy is the default CSP for the SPA and API responses.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; " +
	"base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

// securityHeaders sets CSP and other protective headers. Handlers may
// override them (consent page, inline PDF preview).
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		if auth.IsSecureRequest(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// loadSession resolves the session cookie (if any) into a principal. Invalid
// cookies are cleared; the sliding expiry refreshes the cookie.
func (a *api) loadSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := auth.SessionToken(r)
		if token == "" || strings.HasPrefix(r.URL.Path, "/mcp") || strings.HasPrefix(r.URL.Path, "/assets/") {
			next.ServeHTTP(w, r)
			return
		}
		u, sess, refreshed, err := a.auth.LookupSession(r.Context(), token)
		if err != nil {
			auth.ClearSessionCookie(w, r)
			next.ServeHTTP(w, r)
			return
		}
		if refreshed {
			auth.SetSessionCookie(w, r, token, sess.ExpiresAt)
		}
		if info, ok := r.Context().Value(reqInfoKey{}).(*reqInfo); ok {
			info.userID = u.ID
		}
		ctx := auth.WithPrincipal(r.Context(), &auth.Principal{User: u, SessionID: sess.ID, Kind: "session"})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireUser rejects anonymous requests with 401.
func requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth.PrincipalFrom(r.Context()) == nil {
			writeErrorCode(w, http.StatusUnauthorized, "unauthorized", "Please sign in")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// csrfProtect enforces the double-submit CSRF token on state-changing requests.
func (a *api) csrfProtect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		binding := auth.CSRFBinding(auth.PrincipalFrom(r.Context()))
		if !a.auth.CSRF.CheckCSRF(r, r.Header.Get(auth.CSRFHeaderName), binding) {
			writeErrorCode(w, http.StatusForbidden, "csrf_failed", "Security check failed. Reload the page and try again.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noStore disables caching of API responses.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// mcpCORS allows browser-based MCP clients (authentication is by bearer
// token, never by cookies, so a wildcard origin is safe).
func mcpCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID")
		h.Set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate, MCP-Protocol-Version")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// actor returns the workflow actor of an authenticated web request.
func actor(r *http.Request) workflow.Actor {
	p := auth.PrincipalFrom(r.Context())
	return p.User.Actor(workflow.ViaWeb, auth.ClientIP(r))
}

func principal(r *http.Request) *auth.Principal { return auth.PrincipalFrom(r.Context()) }
