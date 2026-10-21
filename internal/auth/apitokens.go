package auth

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// APIToken is a personal access token (metadata only; the secret is shown once).
type APIToken struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	LastUsedAt *time.Time `json:"last_used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
	CreatedAt  time.Time  `json:"created_at"`
}

const apiTokenColumns = `id, name, prefix, last_used_at, expires_at, revoked_at, created_at`

func scanAPIToken(row pgx.Row) (*APIToken, error) {
	var t APIToken
	err := row.Scan(&t.ID, &t.Name, &t.Prefix, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt, &t.CreatedAt)
	return &t, err
}

// CreateAPIToken issues a personal API token for the actor. The plain token
// is returned once and only its hash is stored.
func (s *Service) CreateAPIToken(ctx context.Context, actor workflow.Actor, name string, expiresInDays int) (string, *APIToken, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 {
		return "", nil, apperr.Validation("Enter a token name (up to 100 characters)")
	}
	if expiresInDays < 0 || expiresInDays > 3650 {
		return "", nil, apperr.Validation("Token lifetime must be 1–3650 days (0 means no expiry)")
	}
	plain, hash, err := GenerateToken(PrefixAPIToken)
	if err != nil {
		return "", nil, err
	}
	prefix := plain[:len(PrefixAPIToken)+6]
	var expires *time.Time
	if expiresInDays > 0 {
		t := time.Now().Add(time.Duration(expiresInDays) * 24 * time.Hour)
		expires = &t
	}
	var tok *APIToken
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		tok, err = scanAPIToken(tx.QueryRow(ctx, `
			INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
			VALUES ($1, $2, $3, $4, $5) RETURNING `+apiTokenColumns, actor.UserID, name, hash, prefix, expires))
		if err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "api_token.create", "api_token", tok.ID,
			map[string]any{"name": name, "prefix": prefix}))
	})
	if err != nil {
		return "", nil, err
	}
	return plain, tok, nil
}

// ListAPITokens returns the user's tokens, newest first.
func (s *Service) ListAPITokens(ctx context.Context, userID string) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+apiTokenColumns+` FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		t, err := scanAPIToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// RevokeAPIToken revokes one of the actor's tokens.
func (s *Service) RevokeAPIToken(ctx context.Context, actor workflow.Actor, id string) error {
	if !db.IsUUID(id) {
		return apperr.NotFound("Token not found")
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, id, actor.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apperr.NotFound("Token not found or already revoked")
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "api_token.revoke", "api_token", id, nil))
	})
}

// VerifyAPIToken resolves a plain API token to its active user.
func (s *Service) VerifyAPIToken(ctx context.Context, plain string) (*User, *APIToken, error) {
	if !HasPrefix(plain, PrefixAPIToken) {
		return nil, nil, apperr.Unauthorized("invalid token")
	}
	u := &User{}
	t := &APIToken{}
	err := s.pool.QueryRow(ctx, `
		SELECT t.id, t.name, t.prefix, t.last_used_at, t.expires_at, t.revoked_at, t.created_at,
		       u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.language, u.last_login_at, u.created_at, u.updated_at
		FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1 AND t.revoked_at IS NULL
		  AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.is_active`, HashToken(plain)).
		Scan(&t.ID, &t.Name, &t.Prefix, &t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt, &t.CreatedAt,
			&u.ID, &u.Username, &u.Email, &u.FullName, &u.Role, &u.IsActive, &u.Language, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt)
	if db.IsNoRows(err) {
		return nil, nil, apperr.Unauthorized("invalid token")
	}
	if err != nil {
		return nil, nil, err
	}
	if t.LastUsedAt == nil || time.Since(*t.LastUsedAt) > time.Minute {
		_, _ = s.pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, t.ID)
	}
	return u, t, nil
}
