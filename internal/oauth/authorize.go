package oauth

import (
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"

	"onceplatform/internal/audit"
	"onceplatform/internal/auth"
	"onceplatform/internal/workflow"
)

// authRequest holds validated parameters of an authorization request.
type authRequest struct {
	client        *Client
	redirectURI   string
	state         string
	challenge     string
	method        string
	scope         string
	resource      string
	responseType  string
	rawClientID   string
	rawRedirect   string
	rawResource   string
	rawScope      string
	rawChallenge  string
	rawMethodName string
}

// authError is an error shown either on our own page (when the redirect URI
// cannot be trusted) or sent back to the client's redirect URI.
type authError struct {
	code, desc string
	redirect   bool
}

func (s *Server) parseAuthRequest(r *http.Request, v url.Values) (*authRequest, *authError) {
	ar := &authRequest{
		rawClientID:   v.Get("client_id"),
		rawRedirect:   v.Get("redirect_uri"),
		state:         v.Get("state"),
		rawChallenge:  v.Get("code_challenge"),
		rawMethodName: v.Get("code_challenge_method"),
		rawScope:      v.Get("scope"),
		rawResource:   v.Get("resource"),
		responseType:  v.Get("response_type"),
	}
	c, err := s.clientByClientID(r.Context(), ar.rawClientID)
	if err != nil {
		return nil, &authError{code: "invalid_client", desc: "This application is not registered on the portal or was disabled by the administrator."}
	}
	ar.client = c
	switch {
	case ar.rawRedirect == "" && len(c.RedirectURIs) == 1:
		ar.redirectURI = c.RedirectURIs[0]
	case ar.rawRedirect != "":
		for _, reg := range c.RedirectURIs {
			if redirectMatches(reg, ar.rawRedirect) {
				ar.redirectURI = ar.rawRedirect
				break
			}
		}
	}
	if ar.redirectURI == "" {
		return nil, &authError{code: "invalid_request", desc: "The return address (redirect_uri) does not match the one registered for this application."}
	}
	if len(ar.state) > 2000 {
		return ar, &authError{code: "invalid_request", desc: "state is too long", redirect: true}
	}
	if ar.responseType != "code" {
		return ar, &authError{code: "unsupported_response_type", desc: "only response_type=code is supported", redirect: true}
	}
	if ar.rawChallenge == "" {
		return ar, &authError{code: "invalid_request", desc: "PKCE code_challenge is required", redirect: true}
	}
	if ar.rawMethodName != "S256" {
		return ar, &authError{code: "invalid_request", desc: "code_challenge_method must be S256", redirect: true}
	}
	if !ValidChallenge(ar.rawChallenge) {
		return ar, &authError{code: "invalid_request", desc: "malformed code_challenge", redirect: true}
	}
	ar.challenge, ar.method = ar.rawChallenge, "S256"
	res, ok := s.canonicalResource(ar.rawResource)
	if !ok {
		return ar, &authError{code: "invalid_target", desc: "resource must be " + s.cfg.MCPResourceURL(), redirect: true}
	}
	ar.resource = res
	// Only the "mcp" scope exists; unknown requested scopes are ignored.
	ar.scope = Scope
	return ar, nil
}

func (s *Server) redirectError(w http.ResponseWriter, r *http.Request, ar *authRequest, e *authError) {
	u, _ := url.Parse(ar.redirectURI)
	q := u.Query()
	q.Set("error", e.code)
	if e.desc != "" {
		q.Set("error_description", e.desc)
	}
	if ar.state != "" {
		q.Set("state", ar.state)
	}
	q.Set("iss", s.cfg.BaseURL)
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

// Authorize handles GET /oauth/authorize: validates the request, sends
// anonymous users to the portal login page and shows the consent screen.
func (s *Server) Authorize(w http.ResponseWriter, r *http.Request) {
	ar, aerr := s.parseAuthRequest(r, r.URL.Query())
	if aerr != nil {
		if aerr.redirect {
			s.redirectError(w, r, ar, aerr)
		} else {
			s.renderError(w, aerr.desc)
		}
		return
	}
	p := auth.PrincipalFrom(r.Context())
	if p == nil || p.Kind != "session" {
		http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	csrfToken := s.auth.CSRF.EnsureCSRFCookie(w, r, auth.CSRFBinding(p))
	s.renderConsent(w, consentData{
		ClientName:   ar.client.ClientName,
		ClientURI:    safeHTTPURL(ar.client.ClientURI),
		RedirectHost: hostOf(ar.redirectURI),
		UserName:     p.User.FullName,
		UserLogin:    p.User.Username,
		CSRF:         csrfToken,
		Params: []hidden{
			{"response_type", "code"},
			{"client_id", ar.rawClientID},
			{"redirect_uri", ar.redirectURI},
			{"state", ar.state},
			{"code_challenge", ar.challenge},
			{"code_challenge_method", ar.method},
			{"scope", ar.rawScope},
			{"resource", ar.rawResource},
		},
		FormOrigin: origin(ar.redirectURI),
	})
}

// AuthorizeSubmit handles POST /oauth/authorize (the consent decision).
func (s *Server) AuthorizeSubmit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		s.renderError(w, "Invalid request.")
		return
	}
	p := auth.PrincipalFrom(r.Context())
	if p == nil || p.Kind != "session" {
		s.renderError(w, "Your session has expired. Go back to the application and start connecting again.")
		return
	}
	if !s.auth.CSRF.CheckCSRF(r, r.PostForm.Get(auth.CSRFFormField), auth.CSRFBinding(p)) {
		s.renderError(w, "The form security check failed (CSRF). Reload the connection page and try again.")
		return
	}
	ar, aerr := s.parseAuthRequest(r, r.PostForm)
	if aerr != nil {
		if aerr.redirect {
			s.redirectError(w, r, ar, aerr)
		} else {
			s.renderError(w, aerr.desc)
		}
		return
	}
	actor := p.User.Actor(workflow.ViaWeb, auth.ClientIP(r))
	if r.PostForm.Get("decision") != "allow" {
		_ = audit.Write(r.Context(), s.pool, audit.FromActor(actor, "oauth.consent_denied", "oauth_client", ar.client.ID,
			map[string]any{"client_name": ar.client.ClientName}))
		s.redirectError(w, r, ar, &authError{code: "access_denied", desc: "the user denied access"})
		return
	}
	code := auth.PrefixOAuthCode + mustRandom(32)
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, scope, resource, code_challenge,
		                              code_challenge_method, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		auth.HashToken(code), ar.client.ID, p.User.ID, ar.redirectURI, ar.scope, ar.resource, ar.challenge, ar.method,
		time.Now().Add(CodeTTL)); err != nil {
		s.log.Error("store authorization code failed", "error", err.Error())
		s.renderError(w, "Internal server error. Please try again later.")
		return
	}
	_ = audit.Write(r.Context(), s.pool, audit.FromActor(actor, "oauth.consent", "oauth_client", ar.client.ID,
		map[string]any{"client_name": ar.client.ClientName, "redirect_uri": ar.redirectURI}))
	u, _ := url.Parse(ar.redirectURI)
	q := u.Query()
	q.Set("code", code)
	if ar.state != "" {
		q.Set("state", ar.state)
	}
	q.Set("iss", s.cfg.BaseURL)
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Host
}

func safeHTTPURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	return u.String()
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

type hidden struct{ Name, Value string }

type consentData struct {
	ClientName   string
	ClientURI    string
	RedirectHost string
	UserName     string
	UserLogin    string
	CSRF         string
	Params       []hidden
	FormOrigin   string
}

const pageCSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--text:#111827;--muted:#6b7280;--border:#e5e7eb;--accent:#4f46e5;--accent-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--card:#141a24;--text:#e5e7eb;--muted:#9ca3af;--border:#273042;--accent:#6366f1}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:460px;width:100%;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
.brand{font-weight:700;font-size:14px;color:var(--muted);letter-spacing:.02em;margin-bottom:18px}
h1{font-size:20px;line-height:1.3;margin:0 0 12px}
p{margin:0 0 12px;color:var(--muted)}
.box{border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin:16px 0}
.box dt{font-size:12px;color:var(--muted)}.box dd{margin:0 0 8px;font-weight:500;word-break:break-all}.box dd:last-child{margin:0}
ul{margin:8px 0 16px;padding-left:20px;color:var(--muted)}
.actions{display:flex;gap:10px;margin-top:20px}
button{flex:1;padding:11px 14px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text);font:inherit;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.warn{font-size:13px}`

var consentTmpl = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an application — OncePlatform</title><style>` + pageCSS + `</style></head>
<body><main class="card">
<div class="brand">OncePlatform · task portal</div>
<h1>Allow "{{.ClientName}}" to access the portal on your behalf?</h1>
<p>The application will be able to view and change tasks, comments and files with your permissions. Deleting is not possible through the application.</p>
<dl class="box">
<dt>Application</dt><dd>{{.ClientName}}{{if .ClientURI}} · {{.ClientURI}}{{end}}</dd>
<dt>The answer will be sent to</dt><dd>{{.RedirectHost}}</dd>
<dt>Signed in as</dt><dd>{{.UserName}} ({{.UserLogin}})</dd>
</dl>
<p class="warn">Allow access only if you started the connection yourself (for example, added a connector in Claude). You can revoke access in your profile under "Connected apps".</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="csrf_token" value="{{.CSRF}}">
{{range .Params}}<input type="hidden" name="{{.Name}}" value="{{.Value}}">
{{end}}<div class="actions">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow" class="primary">Allow</button>
</div></form>
</main></body></html>`))

var errorTmpl = template.Must(template.New("error").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connection error — OncePlatform</title><style>` + pageCSS + `</style></head>
<body><main class="card"><div class="brand">OncePlatform · task portal</div>
<h1>Could not connect the application</h1><p>{{.}}</p>
<p><a href="/">Open the portal</a></p></main></body></html>`))

func pageHeaders(w http.ResponseWriter, formOrigins ...string) {
	formAction := "'self'"
	for _, o := range formOrigins {
		if o != "" && !strings.ContainsAny(o, " ;'") {
			formAction += " " + o
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action "+formAction)
}

func (s *Server) renderConsent(w http.ResponseWriter, d consentData) {
	pageHeaders(w, d.FormOrigin)
	if err := consentTmpl.Execute(w, d); err != nil {
		s.log.Error("render consent page", "error", err.Error())
	}
}

func (s *Server) renderError(w http.ResponseWriter, msg string) {
	pageHeaders(w)
	w.WriteHeader(http.StatusBadRequest)
	if err := errorTmpl.Execute(w, msg); err != nil {
		s.log.Error("render oauth error page", "error", err.Error())
	}
}
