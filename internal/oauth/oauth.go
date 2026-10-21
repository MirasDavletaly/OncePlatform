// Package oauth implements the OAuth 2.1 authorization server used by MCP
// clients such as Claude custom connectors: RFC 9728 protected resource
// metadata, RFC 8414 server metadata, RFC 7591 dynamic client registration,
// authorization code + PKCE (S256), refresh token rotation, RFC 8707
// resource indicators and RFC 7009 revocation. All secrets, codes and tokens
// are stored only as SHA-256 hashes.
package oauth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/auth"
	"onceplatform/internal/config"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// Token lifetimes.
const (
	AccessTokenTTL  = time.Hour
	RefreshTokenTTL = 30 * 24 * time.Hour
	CodeTTL         = 10 * time.Minute
	// refreshGrace: a refresh token presented again within this period after
	// rotation is rejected without revoking the whole token family (tolerates
	// client retries after a lost response).
	refreshGrace = time.Minute
	// Scope is the single scope granted to MCP clients.
	Scope = "mcp"
)

// Server is the OAuth authorization server.
type Server struct {
	pool       *pgxpool.Pool
	log        *slog.Logger
	cfg        *config.Config
	auth       *auth.Service
	regLimiter *auth.Limiter
}

// NewServer creates the OAuth server.
func NewServer(pool *pgxpool.Pool, log *slog.Logger, cfg *config.Config, authSvc *auth.Service) *Server {
	return &Server{
		pool:       pool,
		log:        log,
		cfg:        cfg,
		auth:       authSvc,
		regLimiter: auth.NewLimiter(30, time.Hour, time.Hour),
	}
}

// Client is a registered OAuth client.
type Client struct {
	ID                      string     `json:"id"`
	ClientID                string     `json:"client_id"`
	ClientName              string     `json:"client_name"`
	RedirectURIs            []string   `json:"redirect_uris"`
	GrantTypes              []string   `json:"grant_types"`
	TokenEndpointAuthMethod string     `json:"token_endpoint_auth_method"`
	ClientURI               string     `json:"client_uri"`
	LogoURI                 string     `json:"logo_uri"`
	SoftwareID              string     `json:"software_id"`
	SoftwareVersion         string     `json:"software_version"`
	CreatedAt               time.Time  `json:"created_at"`
	LastUsedAt              *time.Time `json:"last_used_at"`
	RevokedAt               *time.Time `json:"revoked_at"`
	secretHash              []byte
}

const clientColumns = `id, client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method,
	client_uri, logo_uri, software_id, software_version, created_at, last_used_at, revoked_at`

func scanClient(row pgx.Row) (*Client, error) {
	var c Client
	err := row.Scan(&c.ID, &c.ClientID, &c.secretHash, &c.ClientName, &c.RedirectURIs, &c.GrantTypes,
		&c.TokenEndpointAuthMethod, &c.ClientURI, &c.LogoURI, &c.SoftwareID, &c.SoftwareVersion,
		&c.CreatedAt, &c.LastUsedAt, &c.RevokedAt)
	return &c, err
}

func (s *Server) clientByClientID(ctx context.Context, clientID string) (*Client, error) {
	if clientID == "" || len(clientID) > 200 {
		return nil, pgx.ErrNoRows
	}
	return scanClient(s.pool.QueryRow(ctx, `SELECT `+clientColumns+` FROM oauth_clients
		WHERE client_id = $1 AND revoked_at IS NULL`, clientID))
}

func (c *Client) checkSecret(secret string) bool {
	if c.secretHash == nil {
		return false
	}
	return subtle.ConstantTimeCompare(auth.HashToken(secret), c.secretHash) == 1
}

func (c *Client) public() bool { return c.TokenEndpointAuthMethod == "none" }

// canonicalResource validates an RFC 8707 resource parameter. The MCP
// endpoint URL is canonical; the bare base URL is accepted as an alias.
func (s *Server) canonicalResource(resource string) (string, bool) {
	r := strings.TrimRight(strings.TrimSpace(resource), "/")
	switch r {
	case "", s.cfg.MCPResourceURL(), s.cfg.BaseURL:
		return s.cfg.MCPResourceURL(), true
	}
	return "", false
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
	w.Header().Set("Access-Control-Max-Age", "86400")
}

// CORS wraps a public OAuth endpoint with permissive CORS (no cookies are
// involved on these endpoints) and answers preflight requests.
func CORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ProtectedResourceMetadata serves RFC 9728 metadata for the MCP endpoint.
func (s *Server) ProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 s.cfg.MCPResourceURL(),
		"authorization_servers":    []string{s.cfg.BaseURL},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{Scope},
		"resource_name":            "OncePlatform — tasks and tenders portal",
		"resource_documentation":   s.cfg.BaseURL + "/settings/claude",
	})
}

// AuthorizationServerMetadata serves RFC 8414 metadata.
func (s *Server) AuthorizationServerMetadata(w http.ResponseWriter, r *http.Request) {
	b := s.cfg.BaseURL
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         b,
		"authorization_endpoint":                         b + "/oauth/authorize",
		"token_endpoint":                                 b + "/oauth/token",
		"registration_endpoint":                          b + "/oauth/register",
		"revocation_endpoint":                            b + "/oauth/revoke",
		"response_types_supported":                       []string{"code"},
		"response_modes_supported":                       []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none", "client_secret_post", "client_secret_basic"},
		"revocation_endpoint_auth_methods_supported":     []string{"none", "client_secret_post", "client_secret_basic"},
		"scopes_supported":                               []string{Scope},
		"authorization_response_iss_parameter_supported": true,
		"service_documentation":                          b + "/settings/claude",
	})
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

type registrationRequest struct {
	RedirectURIs            []string `json:"redirect_uris"`
	ClientName              string   `json:"client_name"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	Scope                   string   `json:"scope"`
	ClientURI               string   `json:"client_uri"`
	LogoURI                 string   `json:"logo_uri"`
	SoftwareID              string   `json:"software_id"`
	SoftwareVersion         string   `json:"software_version"`
}

func registrationError(w http.ResponseWriter, code, desc string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": code, "error_description": desc})
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// Register handles POST /oauth/register.
func (s *Server) Register(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ip := auth.ClientIP(r)
	if locked, _ := s.regLimiter.Hit(ip); locked {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too_many_requests",
			"error_description": "too many client registrations from this address"})
		return
	}
	var req registrationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		registrationError(w, "invalid_client_metadata", "request body must be a JSON object")
		return
	}
	if len(req.RedirectURIs) == 0 || len(req.RedirectURIs) > 10 {
		registrationError(w, "invalid_redirect_uri", "between 1 and 10 redirect_uris are required")
		return
	}
	for _, u := range req.RedirectURIs {
		if err := ValidateRedirectURI(u); err != nil {
			registrationError(w, "invalid_redirect_uri", err.Error())
			return
		}
	}
	method := req.TokenEndpointAuthMethod
	if method == "" {
		method = "client_secret_basic" // RFC 7591 default
	}
	if !slices.Contains([]string{"none", "client_secret_post", "client_secret_basic"}, method) {
		registrationError(w, "invalid_client_metadata", "unsupported token_endpoint_auth_method")
		return
	}
	grants := req.GrantTypes
	if len(grants) == 0 {
		grants = []string{"authorization_code"}
	}
	for _, g := range grants {
		if g != "authorization_code" && g != "refresh_token" {
			registrationError(w, "invalid_client_metadata", "unsupported grant type "+g)
			return
		}
	}
	if !slices.Contains(grants, "authorization_code") {
		registrationError(w, "invalid_client_metadata", "grant_types must include authorization_code")
		return
	}
	if !slices.Contains(grants, "refresh_token") {
		grants = append(grants, "refresh_token")
	}
	for _, rt := range req.ResponseTypes {
		if rt != "code" {
			registrationError(w, "invalid_client_metadata", "only response_type code is supported")
			return
		}
	}
	name := clip(req.ClientName, 100)
	if name == "" {
		name = "MCP client"
	}
	clientID := "mcp_" + mustRandom(18)
	var secret string
	var secretHash []byte
	if method != "none" {
		secret = "mcs_" + mustRandom(32)
		secretHash = auth.HashToken(secret)
	}
	var id string
	var created time.Time
	err := db.InTx(r.Context(), s.pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types,
			                           token_endpoint_auth_method, scope, client_uri, logo_uri, software_id,
			                           software_version, registration_ip)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, created_at`,
			clientID, secretHash, name, req.RedirectURIs, grants, method, Scope, clip(req.ClientURI, 500),
			clip(req.LogoURI, 500), clip(req.SoftwareID, 200), clip(req.SoftwareVersion, 100), ip).Scan(&id, &created); err != nil {
			return err
		}
		return audit.Write(r.Context(), tx, audit.Entry{Action: "oauth.client_register", EntityType: "oauth_client", EntityID: id,
			Via: workflow.ViaSystem, IP: ip, Details: map[string]any{"client_name": name, "redirect_uris": req.RedirectURIs}})
	})
	if err != nil {
		s.log.Error("oauth client registration failed", "error", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	resp := map[string]any{
		"client_id":                  clientID,
		"client_id_issued_at":        created.Unix(),
		"client_name":                name,
		"redirect_uris":              req.RedirectURIs,
		"grant_types":                grants,
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": method,
		"scope":                      Scope,
	}
	if secret != "" {
		resp["client_secret"] = secret
		resp["client_secret_expires_at"] = 0
	}
	s.log.Info("oauth client registered", "client_id", clientID, "client_name", name, "auth_method", method)
	writeJSON(w, http.StatusCreated, resp)
}

func mustRandom(n int) string {
	s, err := auth.RandomToken(n)
	if err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return s
}

// ---------------------------------------------------------------------------
// Grants (connected applications) and client administration
// ---------------------------------------------------------------------------

// Grant is an application the user has authorized.
type Grant struct {
	ClientID     string     `json:"client_id"` // internal UUID
	ClientName   string     `json:"client_name"`
	ClientURI    string     `json:"client_uri"`
	RedirectHost string     `json:"redirect_host"`
	AuthorizedAt time.Time  `json:"authorized_at"`
	LastUsedAt   *time.Time `json:"last_used_at"`
	ActiveTokens int        `json:"active_tokens"`
}

// ListGrants returns the applications the user has connected.
func (s *Server) ListGrants(ctx context.Context, userID string) ([]Grant, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.client_name, c.client_uri, c.redirect_uris[1], min(t.created_at), max(t.last_used_at),
		       count(*) FILTER (WHERE t.revoked_at IS NULL AND t.expires_at > now())
		FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
		WHERE t.user_id = $1 AND c.revoked_at IS NULL
		GROUP BY c.id
		HAVING count(*) FILTER (WHERE t.revoked_at IS NULL AND t.expires_at > now()) > 0
		ORDER BY min(t.created_at) DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Grant{}
	for rows.Next() {
		var g Grant
		var redirect string
		if err := rows.Scan(&g.ClientID, &g.ClientName, &g.ClientURI, &redirect, &g.AuthorizedAt, &g.LastUsedAt, &g.ActiveTokens); err != nil {
			return nil, err
		}
		g.RedirectHost = origin(redirect)
		out = append(out, g)
	}
	return out, rows.Err()
}

// RevokeGrant revokes all tokens the actor issued to a client.
func (s *Server) RevokeGrant(ctx context.Context, actor workflow.Actor, clientUUID string) error {
	if !db.IsUUID(clientUUID) {
		return apperr.NotFound("Application not found")
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE oauth_tokens SET revoked_at = now()
			WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`, actor.UserID, clientUUID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apperr.NotFound("Application not found or access already revoked")
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "oauth.grant_revoke", "oauth_client", clientUUID, nil))
	})
}

// AdminClient is an OAuth client with usage statistics.
type AdminClient struct {
	Client
	Users        []string `json:"users"`
	ActiveTokens int      `json:"active_tokens"`
}

// ListClients returns all registered clients (admin only).
func (s *Server) ListClients(ctx context.Context, actor workflow.Actor) ([]AdminClient, error) {
	if err := actor.Require(workflow.PermOAuthClientsAdmin); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+prefixColumns("c.", clientColumns)+`,
		       coalesce((SELECT array_agg(DISTINCT u.full_name) FROM oauth_tokens t JOIN users u ON u.id = t.user_id
		                 WHERE t.client_id = c.id), '{}'),
		       (SELECT count(*) FROM oauth_tokens t WHERE t.client_id = c.id AND t.revoked_at IS NULL AND t.expires_at > now())
		FROM oauth_clients c ORDER BY c.created_at DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminClient{}
	for rows.Next() {
		var a AdminClient
		c := &a.Client
		if err := rows.Scan(&c.ID, &c.ClientID, &c.secretHash, &c.ClientName, &c.RedirectURIs, &c.GrantTypes,
			&c.TokenEndpointAuthMethod, &c.ClientURI, &c.LogoURI, &c.SoftwareID, &c.SoftwareVersion,
			&c.CreatedAt, &c.LastUsedAt, &c.RevokedAt, &a.Users, &a.ActiveTokens); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RevokeClient disables a client and revokes all its tokens (admin only).
func (s *Server) RevokeClient(ctx context.Context, actor workflow.Actor, id string) error {
	if err := actor.Require(workflow.PermOAuthClientsAdmin); err != nil {
		return err
	}
	if !db.IsUUID(id) {
		return apperr.NotFound("Client not found")
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		var name string
		err := tx.QueryRow(ctx, `UPDATE oauth_clients SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
			RETURNING client_name`, id).Scan(&name)
		if db.IsNoRows(err) {
			return apperr.NotFound("Client not found or already disabled")
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL`, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "oauth.client_revoke", "oauth_client", id, map[string]any{"client_name": name}))
	})
}

func prefixColumns(prefix, cols string) string {
	parts := strings.Split(cols, ",")
	for i, p := range parts {
		parts[i] = prefix + strings.TrimSpace(p)
	}
	return strings.Join(parts, ", ")
}

// Cleanup removes expired authorization codes and long-expired tokens.
func (s *Server) Cleanup(ctx context.Context) error {
	s.regLimiter.Cleanup()
	if _, err := s.pool.Exec(ctx, `DELETE FROM oauth_auth_codes WHERE expires_at < now() - interval '1 day'`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM oauth_tokens WHERE expires_at < now() - interval '7 days'`)
	return err
}
