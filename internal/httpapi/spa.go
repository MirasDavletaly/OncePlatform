package httpapi

import (
	"bytes"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// spa serves the embedded single-page application. Unknown paths fall back
// to index.html so that client-side routes (/tickets/T-2026-0001) work on reload.
type spa struct {
	fsys    fs.FS
	index   []byte
	handler http.Handler
	started time.Time
}

const notBuiltPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OncePlatform</title></head>
<body style="font-family:system-ui;padding:40px"><h1>The web interface is not built</h1>
<p>The API works, but the web interface was not embedded into the binary. Build the project with <code>docker compose up -d --build</code>
or run <code>npm ci &amp;&amp; npm run build</code> in <code>web/</code> and rebuild the server.</p></body></html>`

func newSPA(fsys fs.FS, log *slog.Logger) *spa {
	s := &spa{fsys: fsys, started: time.Now()}
	if fsys != nil {
		if b, err := fs.ReadFile(fsys, "index.html"); err == nil {
			s.index = b
		}
	}
	if s.index == nil {
		log.Warn("frontend build not found; serving placeholder page")
		s.index = []byte(notBuiltPage)
	}
	s.handler = middleware.Compress(5, "text/html", "text/css", "application/javascript", "text/javascript",
		"image/svg+xml", "application/json")(http.HandlerFunc(s.serve))
	return s
}

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

func (s *spa) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeErrorCode(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
	p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if strings.HasPrefix(p, "api/") || p == "api" {
		writeErrorCode(w, http.StatusNotFound, "not_found", "API method not found")
		return
	}
	if p != "" && p != "index.html" && s.fsys != nil {
		if data, err := fs.ReadFile(s.fsys, p); err == nil {
			if ct := mime.TypeByExtension(path.Ext(p)); ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			if strings.HasPrefix(p, "assets/") {
				// Vite emits content-hashed file names under assets/.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				// Fixed names (theme-init.js, favicon.svg): revalidate via Last-Modified.
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.ServeContent(w, r, p, s.started, bytes.NewReader(data))
			return
		}
		// A missing file with an extension is a broken asset link, not a client route.
		if strings.HasPrefix(p, "assets/") || path.Ext(p) != "" {
			http.NotFound(w, r)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", s.started, bytes.NewReader(s.index))
}
