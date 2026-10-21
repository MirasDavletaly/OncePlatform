package auth

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// Session is a browser login session.
type Session struct {
	ID        string
	UserID    string
	ExpiresAt time.Time
}

// LoginResult is returned by a successful login.
type LoginResult struct {
	User    *User
	Token   string // plain session token for the cookie; never stored
	Session *Session
}

// Login verifies credentials (with rate limiting per IP + login) and creates a session.
func (s *Service) Login(ctx context.Context, username, password, ip, userAgent string) (*LoginResult, error) {
	username = strings.TrimSpace(username)
	key := ip + "|" + strings.ToLower(username)
	if blocked, wait := s.LoginLimiter.Blocked(key); blocked {
		mins := int(wait.Minutes()) + 1
		return nil, apperr.RateLimited(fmt.Sprintf("Too many sign-in attempts. Try again in %d min.", mins))
	}

	var (
		userID string
		hash   string
		active bool
	)
	err := s.pool.QueryRow(ctx, `SELECT id, password_hash, is_active FROM users WHERE lower(username) = lower($1)`, username).
		Scan(&userID, &hash, &active)
	found := err == nil
	if err != nil && !db.IsNoRows(err) {
		return nil, err
	}
	if !found {
		hash = dummyHash
	}
	ok, verr := VerifyPassword(password, hash)
	if verr != nil {
		s.log.Error("password hash verification error", "user_id", userID, "error", verr.Error())
		ok = false
	}
	if !found || !ok || !active {
		s.LoginLimiter.Hit(key)
		details := map[string]any{"username": username}
		if found && ok && !active {
			details["reason"] = "inactive"
		}
		_ = audit.Write(ctx, s.pool, audit.Entry{UserID: userID, Action: "auth.login_failed", EntityType: "user",
			EntityID: userID, Details: details, Via: workflow.ViaWeb, IP: ip})
		if found && ok && !active {
			return nil, apperr.Unauthorized("This account is deactivated. Please contact your administrator.")
		}
		return nil, apperr.Unauthorized("Wrong login or password")
	}
	s.LoginLimiter.Reset(key)

	token, tokenHash, err := GenerateToken(PrefixSession)
	if err != nil {
		return nil, err
	}
	if len(userAgent) > 400 {
		userAgent = userAgent[:400]
	}
	res := &LoginResult{Token: token, Session: &Session{UserID: userID}}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
			VALUES ($1, $2, now() + $3::interval, $4, $5) RETURNING id, expires_at`,
			userID, tokenHash, fmt.Sprintf("%d seconds", int(SessionTTL.Seconds())), ip, userAgent).
			Scan(&res.Session.ID, &res.Session.ExpiresAt); err != nil {
			return err
		}
		u, err := scanUser(tx.QueryRow(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING `+userColumns, userID))
		if err != nil {
			return err
		}
		res.User = u
		return audit.Write(ctx, tx, audit.Entry{UserID: userID, Action: "auth.login", EntityType: "user",
			EntityID: userID, Via: workflow.ViaWeb, IP: ip})
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// LookupSession resolves a session token to its user. When the sliding expiry
// was pushed forward, refreshed is true and the cookie should be re-issued.
func (s *Service) LookupSession(ctx context.Context, token string) (u *User, sess *Session, refreshed bool, err error) {
	if !HasPrefix(token, PrefixSession) {
		return nil, nil, false, apperr.Unauthorized("Invalid session")
	}
	var lastSeen time.Time
	sess = &Session{}
	u = &User{}
	err = s.pool.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.expires_at, s.last_seen_at,
		       u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.language, u.last_login_at, u.created_at, u.updated_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`, HashToken(token)).
		Scan(&sess.ID, &sess.UserID, &sess.ExpiresAt, &lastSeen,
			&u.ID, &u.Username, &u.Email, &u.FullName, &u.Role, &u.IsActive, &u.Language, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt)
	if db.IsNoRows(err) {
		return nil, nil, false, apperr.Unauthorized("Your session has expired, please sign in again")
	}
	if err != nil {
		return nil, nil, false, err
	}
	if time.Since(lastSeen) > sessionRefreshAfter {
		if err := s.pool.QueryRow(ctx, `
			UPDATE sessions SET last_seen_at = now(), expires_at = now() + $2::interval
			WHERE id = $1 RETURNING expires_at`, sess.ID, fmt.Sprintf("%d seconds", int(SessionTTL.Seconds()))).
			Scan(&sess.ExpiresAt); err != nil {
			return nil, nil, false, err
		}
		refreshed = true
	}
	return u, sess, refreshed, nil
}

// Logout terminates the session identified by token.
func (s *Service) Logout(ctx context.Context, token, ip string) error {
	if token == "" {
		return nil
	}
	var userID string
	err := s.pool.QueryRow(ctx, `DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id`, HashToken(token)).Scan(&userID)
	if db.IsNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return audit.Write(ctx, s.pool, audit.Entry{UserID: userID, Action: "auth.logout", EntityType: "user",
		EntityID: userID, Via: workflow.ViaWeb, IP: ip})
}
