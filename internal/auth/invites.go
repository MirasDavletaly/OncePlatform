package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"math/big"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// One-time codes. The admin adds a person and passes them a code instead of a
// password; on the sign-in page the person enters their login, the code and a
// password of their own. A code works once, for InviteTTL; only its SHA-256 is
// stored. The same code also serves as a reset when someone forgets a password.

const InviteTTL = 72 * time.Hour

// no 0/O, 1/I/L: the code is read out or typed from a message
const inviteAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// generateInviteCode returns 10 characters (about 50 bits) as XXXXX-XXXXX.
func generateInviteCode() (string, error) {
	var b strings.Builder
	max := big.NewInt(int64(len(inviteAlphabet)))
	for i := 0; i < 10; i++ {
		if i == 5 {
			b.WriteByte('-')
		}
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(inviteAlphabet[n.Int64()])
	}
	return b.String(), nil
}

// inviteHash: case, spaces and dashes do not matter when the code is typed.
func inviteHash(code string) []byte {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	sum := sha256.Sum256([]byte(b.String()))
	return sum[:]
}

// IssueInvite creates a new one-time code for the user (admin only), replacing
// a previous one. The code is returned once and never stored.
func (s *Service) IssueInvite(ctx context.Context, actor workflow.Actor, id string) (string, time.Time, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return "", time.Time{}, err
	}
	u, err := s.GetUser(ctx, id)
	if err != nil {
		return "", time.Time{}, err
	}
	if !u.IsActive {
		return "", time.Time{}, apperr.Validation("The account is deactivated: activate it first")
	}
	code, err := generateInviteCode()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(InviteTTL)
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE users SET invite_hash = $2, invite_expires_at = $3, updated_at = now() WHERE id = $1`,
			id, inviteHash(code), expires); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "user.invite", "user", id,
			map[string]any{"username": u.Username, "expires_at": expires.UTC().Format(time.RFC3339)}))
	})
	if err != nil {
		return "", time.Time{}, err
	}
	return code, expires, nil
}

// Activate signs a person in with their one-time code and sets their password:
// the code is used up, other sessions end. Attempts count against the same
// limits as passwords.
func (s *Service) Activate(ctx context.Context, username, code, password, ip, userAgent string) (*LoginResult, error) {
	username = strings.TrimSpace(username)
	userKey := strings.ToLower(username)
	key := ip + "|" + userKey
	if err := s.signInBlocked(ip, key, userKey); err != nil {
		return nil, err
	}
	if !validLogin(username) {
		s.IPLimiter.Hit(ip)
		return nil, apperr.Unauthorized("Wrong login or code, or the code has expired. Ask your administrator for a new one.")
	}
	// the password is checked first: a weak one must not use up an attempt
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	var (
		userID  string
		stored  []byte
		expires *time.Time
		active  bool
	)
	err := s.pool.QueryRow(ctx, `SELECT id, invite_hash, invite_expires_at, is_active FROM users WHERE lower(username) = lower($1)`, username).
		Scan(&userID, &stored, &expires, &active)
	if err != nil && !db.IsNoRows(err) {
		return nil, err
	}
	ok := err == nil && active && len(stored) > 0 && expires != nil && time.Now().Before(*expires) &&
		subtle.ConstantTimeCompare(stored, inviteHash(code)) == 1
	if !ok {
		s.LoginLimiter.Hit(key)
		s.UserLimiter.Hit(userKey)
		s.IPLimiter.Hit(ip)
		_ = audit.Write(ctx, s.pool, audit.Entry{UserID: userID, Action: "auth.activate_failed", EntityType: "user", EntityID: userID,
			Details: map[string]any{"username": username}, Via: workflow.ViaWeb, IP: ip})
		return nil, apperr.Unauthorized("Wrong login or code, or the code has expired. Ask your administrator for a new one.")
	}
	s.LoginLimiter.Reset(key)
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	var res *LoginResult
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		// used up exactly once: a second request with the same code finds no row
		tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, invite_hash = NULL, invite_expires_at = NULL, updated_at = now()
			WHERE id = $1 AND invite_hash = $3`, userID, hash, stored)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apperr.Unauthorized("This code has already been used")
		}
		if err := endAccess(ctx, tx, userID, ""); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.Entry{UserID: userID, Action: "user.activate", EntityType: "user", EntityID: userID,
			Via: workflow.ViaWeb, IP: ip}); err != nil {
			return err
		}
		res, err = s.startSession(ctx, tx, userID, ip, userAgent)
		return err
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}
