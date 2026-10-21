package oauth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/audit"
	"onceplatform/internal/auth"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

type tokenError struct {
	status int
	code   string
	desc   string
}

func (e *tokenError) write(w http.ResponseWriter) {
	if e.status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Basic realm="oauth"`)
	}
	writeJSON(w, e.status, map[string]string{"error": e.code, "error_description": e.desc})
}

func invalidGrant(desc string) *tokenError {
	return &tokenError{http.StatusBadRequest, "invalid_grant", desc}
}

// authenticateClient authenticates the client at the token/revocation endpoint
// using client_secret_basic, client_secret_post or none (public clients).
func (s *Server) authenticateClient(ctx context.Context, r *http.Request) (*Client, *tokenError) {
	clientID, secret, basic := r.BasicAuth()
	if basic {
		if id, err := url.QueryUnescape(clientID); err == nil {
			clientID = id
		}
		if sec, err := url.QueryUnescape(secret); err == nil {
			secret = sec
		}
	} else {
		clientID = r.PostForm.Get("client_id")
		secret = r.PostForm.Get("client_secret")
	}
	if clientID == "" {
		return nil, &tokenError{http.StatusUnauthorized, "invalid_client", "client authentication required"}
	}
	c, err := s.clientByClientID(ctx, clientID)
	if err != nil {
		return nil, &tokenError{http.StatusUnauthorized, "invalid_client", "unknown or disabled client"}
	}
	if c.public() {
		return c, nil
	}
	if secret == "" || !c.checkSecret(secret) {
		return nil, &tokenError{http.StatusUnauthorized, "invalid_client", "invalid client credentials"}
	}
	return c, nil
}

// Token handles POST /oauth/token.
func (s *Server) Token(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		(&tokenError{http.StatusBadRequest, "invalid_request", "malformed form body"}).write(w)
		return
	}
	client, terr := s.authenticateClient(r.Context(), r)
	if terr != nil {
		terr.write(w)
		return
	}
	var resp map[string]any
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		resp, terr = s.exchangeCode(r, client)
	case "refresh_token":
		resp, terr = s.refresh(r, client)
	default:
		terr = &tokenError{http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token"}
	}
	if terr != nil {
		terr.write(w)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) exchangeCode(r *http.Request, client *Client) (map[string]any, *tokenError) {
	ctx := r.Context()
	code := r.PostForm.Get("code")
	verifier := r.PostForm.Get("code_verifier")
	redirectURI := r.PostForm.Get("redirect_uri")
	if code == "" || verifier == "" {
		return nil, &tokenError{http.StatusBadRequest, "invalid_request", "code and code_verifier are required"}
	}
	familyID, err := db.NewUUID()
	if err != nil {
		return nil, &tokenError{http.StatusInternalServerError, "server_error", ""}
	}
	var (
		clientID, userID, storedRedirect, scope, resource, challenge, method string
		expires                                                              time.Time
	)
	err = s.pool.QueryRow(ctx, `
		UPDATE oauth_auth_codes SET used_at = now(), family_id = $2
		WHERE code_hash = $1 AND used_at IS NULL
		RETURNING client_id, user_id, redirect_uri, scope, resource, code_challenge, code_challenge_method, expires_at`,
		auth.HashToken(code), familyID).
		Scan(&clientID, &userID, &storedRedirect, &scope, &resource, &challenge, &method, &expires)
	if db.IsNoRows(err) {
		// Either unknown or already used. A reused code revokes everything issued from it.
		var prevFamily *string
		if err := s.pool.QueryRow(ctx, `SELECT family_id FROM oauth_auth_codes WHERE code_hash = $1`, auth.HashToken(code)).
			Scan(&prevFamily); err == nil && prevFamily != nil {
			_, _ = s.pool.Exec(ctx, `UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, *prevFamily)
			s.log.Warn("authorization code reuse detected; tokens revoked", "client_id", client.ClientID)
		}
		return nil, invalidGrant("authorization code is invalid or has already been used")
	}
	if err != nil {
		s.log.Error("code exchange failed", "error", err.Error())
		return nil, &tokenError{http.StatusInternalServerError, "server_error", ""}
	}
	if clientID != client.ID {
		return nil, invalidGrant("authorization code was issued to another client")
	}
	if time.Now().After(expires) {
		return nil, invalidGrant("authorization code has expired")
	}
	if redirectURI != "" && redirectURI != storedRedirect {
		return nil, invalidGrant("redirect_uri does not match the authorization request")
	}
	if !VerifyPKCE(verifier, challenge, method) {
		return nil, invalidGrant("PKCE verification failed")
	}
	if rp := r.PostForm.Get("resource"); rp != "" {
		if res, ok := s.canonicalResource(rp); !ok || res != resource {
			return nil, &tokenError{http.StatusBadRequest, "invalid_target", "resource does not match the authorization request"}
		}
	}
	var active bool
	if err := s.pool.QueryRow(ctx, `SELECT is_active FROM users WHERE id = $1`, userID).Scan(&active); err != nil || !active {
		return nil, invalidGrant("user account is not active")
	}
	resp, err := s.issueTokens(ctx, client, userID, familyID, scope, resource)
	if err != nil {
		s.log.Error("issue tokens failed", "error", err.Error())
		return nil, &tokenError{http.StatusInternalServerError, "server_error", ""}
	}
	_ = audit.Write(ctx, s.pool, audit.Entry{UserID: userID, Action: "oauth.token_issue", EntityType: "oauth_client",
		EntityID: client.ID, Via: workflow.ViaMCP, IP: auth.ClientIP(r), Details: map[string]any{"client_name": client.ClientName}})
	return resp, nil
}

func (s *Server) refresh(r *http.Request, client *Client) (map[string]any, *tokenError) {
	ctx := r.Context()
	token := r.PostForm.Get("refresh_token")
	if token == "" || !auth.HasPrefix(token, auth.PrefixOAuthRefresh) {
		return nil, invalidGrant("refresh token is invalid")
	}
	var (
		id, familyID, clientID, userID, scope, resource string
		expires                                         time.Time
		revoked                                         *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT id, family_id, client_id, user_id, scope, resource, expires_at, revoked_at
		FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'`, auth.HashToken(token)).
		Scan(&id, &familyID, &clientID, &userID, &scope, &resource, &expires, &revoked)
	if db.IsNoRows(err) {
		return nil, invalidGrant("refresh token is invalid")
	}
	if err != nil {
		s.log.Error("refresh lookup failed", "error", err.Error())
		return nil, &tokenError{http.StatusInternalServerError, "server_error", ""}
	}
	if clientID != client.ID {
		return nil, invalidGrant("refresh token was issued to another client")
	}
	if revoked != nil {
		if time.Since(*revoked) > refreshGrace {
			_, _ = s.pool.Exec(ctx, `UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, familyID)
			s.log.Warn("refresh token reuse detected; token family revoked", "client_id", client.ClientID, "user_id", userID)
		}
		return nil, invalidGrant("refresh token has been revoked")
	}
	if time.Now().After(expires) {
		return nil, invalidGrant("refresh token has expired")
	}
	if rp := r.PostForm.Get("resource"); rp != "" {
		if res, ok := s.canonicalResource(rp); !ok || res != resource {
			return nil, &tokenError{http.StatusBadRequest, "invalid_target", "resource does not match the original grant"}
		}
	}
	if sc := strings.TrimSpace(r.PostForm.Get("scope")); sc != "" && sc != scope {
		for _, part := range strings.Fields(sc) {
			if part != Scope {
				return nil, &tokenError{http.StatusBadRequest, "invalid_scope", "requested scope exceeds the original grant"}
			}
		}
	}
	var active bool
	if err := s.pool.QueryRow(ctx, `SELECT is_active FROM users WHERE id = $1`, userID).Scan(&active); err != nil || !active {
		return nil, invalidGrant("user account is not active")
	}
	tag, err := s.pool.Exec(ctx, `UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
	if err != nil {
		return nil, &tokenError{http.StatusInternalServerError, "server_error", ""}
	}
	if tag.RowsAffected() == 0 {
		return nil, invalidGrant("refresh token has already been used")
	}
	resp, err := s.issueTokens(ctx, client, userID, familyID, scope, resource)
	if err != nil {
		s.log.Error("issue tokens failed", "error", err.Error())
		return nil, &tokenError{http.StatusInternalServerError, "server_error", ""}
	}
	return resp, nil
}

func (s *Server) issueTokens(ctx context.Context, client *Client, userID, familyID, scope, resource string) (map[string]any, error) {
	access, accessHash, err := auth.GenerateToken(auth.PrefixOAuthAccess)
	if err != nil {
		return nil, err
	}
	refresh, refreshHash, err := auth.GenerateToken(auth.PrefixOAuthRefresh)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, scope, resource, expires_at)
			VALUES ($1, 'access', $3, $4, $5, $6, $7, $8), ($2, 'refresh', $3, $4, $5, $6, $7, $9)`,
			accessHash, refreshHash, familyID, client.ID, userID, scope, resource,
			now.Add(AccessTokenTTL), now.Add(RefreshTokenTTL)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE oauth_clients SET last_used_at = now() WHERE id = $1`, client.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(AccessTokenTTL.Seconds()),
		"refresh_token": refresh,
		"scope":         scope,
	}, nil
}

// Revoke handles POST /oauth/revoke (RFC 7009). It always answers 200 for
// tokens that are unknown or belong to another client.
func (s *Server) Revoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		(&tokenError{http.StatusBadRequest, "invalid_request", "malformed form body"}).write(w)
		return
	}
	client, terr := s.authenticateClient(r.Context(), r)
	if terr != nil {
		terr.write(w)
		return
	}
	token := r.PostForm.Get("token")
	if token != "" {
		var familyID string
		err := s.pool.QueryRow(r.Context(), `SELECT family_id FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2`,
			auth.HashToken(token), client.ID).Scan(&familyID)
		if err == nil {
			// Revoking a refresh token ends the whole grant; an access token only itself.
			if auth.HasPrefix(token, auth.PrefixOAuthRefresh) {
				_, err = s.pool.Exec(r.Context(), `UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, familyID)
			} else {
				_, err = s.pool.Exec(r.Context(), `UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, auth.HashToken(token))
			}
			if err != nil {
				s.log.Error("token revocation failed", "error", err.Error())
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

// ErrInvalidAccessToken is returned for unknown, expired or revoked tokens.
var ErrInvalidAccessToken = errors.New("invalid access token")

// AccessInfo describes a verified OAuth access token.
type AccessInfo struct {
	User       *auth.User
	ClientName string
	ExpiresAt  time.Time
}

// VerifyAccessToken validates an OAuth access token for the MCP resource.
func (s *Server) VerifyAccessToken(ctx context.Context, token string) (*AccessInfo, error) {
	if !auth.HasPrefix(token, auth.PrefixOAuthAccess) {
		return nil, ErrInvalidAccessToken
	}
	u := &auth.User{}
	info := &AccessInfo{User: u}
	var (
		tokenID  string
		resource string
		lastUsed *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT t.id, t.resource, t.expires_at, t.last_used_at, c.client_name,
		       u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.language, u.last_login_at, u.created_at, u.updated_at
		FROM oauth_tokens t
		JOIN oauth_clients c ON c.id = t.client_id
		JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()
		  AND c.revoked_at IS NULL AND u.is_active`, auth.HashToken(token)).
		Scan(&tokenID, &resource, &info.ExpiresAt, &lastUsed, &info.ClientName,
			&u.ID, &u.Username, &u.Email, &u.FullName, &u.Role, &u.IsActive, &u.Language, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt)
	if db.IsNoRows(err) {
		return nil, ErrInvalidAccessToken
	}
	if err != nil {
		return nil, err
	}
	if resource != s.cfg.MCPResourceURL() {
		return nil, ErrInvalidAccessToken
	}
	if lastUsed == nil || time.Since(*lastUsed) > time.Minute {
		_, _ = s.pool.Exec(ctx, `UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1`, tokenID)
	}
	return info, nil
}
