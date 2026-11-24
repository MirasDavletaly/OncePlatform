package httpapi

import (
	"path"
	"testing"
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
