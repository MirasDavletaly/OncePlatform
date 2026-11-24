package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"onceplatform/internal/auth"
)

func TestSPACacheHeaders(t *testing.T) {
	s := newSPA(fstest.MapFS{
		"index.html":        {Data: []byte("<!doctype html>")},
		"theme-init.js":     {Data: []byte("x")},
		"assets/app-Ab1.js": {Data: []byte("y")},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	get := func(p string, hdr ...string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, p, nil)
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Set(hdr[i], hdr[i+1])
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}

	for p, want := range map[string]string{
		"/assets/app-Ab1.js": "public, max-age=31536000, immutable",
		"/theme-init.js":     "no-cache",
		"/":                  "no-cache",
		"/tickets/T-1":       "no-cache",
	} {
		w := get(p)
		if w.Code != 200 || w.Header().Get("Cache-Control") != want {
			t.Errorf("%s: %d %q, want 200 %q", p, w.Code, w.Header().Get("Cache-Control"), want)
		}
	}

	w := get("/")
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("index Content-Type %q", ct)
	}
	lm := w.Header().Get("Last-Modified")
	if lm == "" {
		t.Fatal("index has no Last-Modified")
	}
	if w := get("/", "If-Modified-Since", lm); w.Code != http.StatusNotModified {
		t.Errorf("index revalidation: %d, want 304", w.Code)
	}
}

func TestMeAnonymous(t *testing.T) {
	a := &api{auth: &auth.Service{CSRF: auth.NewCSRF([]byte("test-secret"))}}
	w := httptest.NewRecorder()
	a.me(w, httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"user":null`) {
		t.Errorf("anonymous /auth/me: %d %s", w.Code, w.Body.String())
	}
}
