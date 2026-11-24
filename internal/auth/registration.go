package auth

import (
	"context"
	"crypto/subtle"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// A shared registration link. Whoever opens it creates their own account with
// the recruiter role (the CV database only), without approval; the admin
// replaces or disables the link when it has gone further than intended. One
// link at a time. Its token is kept as is, so the admin can copy the link
// again: it is meant to be passed around anyway.

// RegistrationLink is the current link's token.
type RegistrationLink struct {
	Token     string    `json:"token"`
	CreatedAt time.Time `json:"created_at"`
}

// RegistrationLink returns the current link, nil when registration is off (admin only).
func (s *Service) RegistrationLink(ctx context.Context, actor workflow.Actor) (*RegistrationLink, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return nil, err
	}
	var l RegistrationLink
	err := s.pool.QueryRow(ctx, `SELECT token, created_at FROM registration_link`).Scan(&l.Token, &l.CreatedAt)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// NewRegistrationLink turns registration on with a new link; the previous one stops working.
func (s *Service) NewRegistrationLink(ctx context.Context, actor workflow.Actor) (*RegistrationLink, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return nil, err
	}
	tok, err := RandomToken(24)
	if err != nil {
		return nil, err
	}
	var l RegistrationLink
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO registration_link (id, token, created_by) VALUES (1, $1, $2)
			ON CONFLICT (id) DO UPDATE SET token = excluded.token, created_by = excluded.created_by, created_at = now()
			RETURNING token, created_at`, tok, actor.UserID).Scan(&l.Token, &l.CreatedAt); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "registration.link_create", "", "", nil))
	})
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// DisableRegistrationLink turns registration off.
func (s *Service) DisableRegistrationLink(ctx context.Context, actor workflow.Actor) error {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return err
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM registration_link`); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "registration.link_disable", "", "", nil))
	})
}

func linkMatches(ctx context.Context, q db.Querier, token string) (bool, error) {
	var cur string
	err := q.QueryRow(ctx, `SELECT token FROM registration_link`).Scan(&cur)
	if db.IsNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	token = strings.TrimSpace(token)
	return token != "" && subtle.ConstantTimeCompare([]byte(cur), []byte(token)) == 1, nil
}

// RegistrationOpen tells whether the token is the current registration link.
func (s *Service) RegistrationOpen(ctx context.Context, token string) (bool, error) {
	return linkMatches(ctx, s.pool, token)
}

// RegisterInput is what the person fills in on the registration page.
type RegisterInput struct {
	Token    string `json:"token"`
	Username string `json:"username"`
	FullName string `json:"full_name"`
	Password string `json:"password"`
}

var errLinkClosed = apperr.Unauthorized("This registration link no longer works. Ask your administrator for a new one.")

// Register creates a recruiter account through the registration link and
// signs the person in. Wrong links count against the sign-in limits of the
// address; registrations with the right link do not (colleagues share an IP).
func (s *Service) Register(ctx context.Context, in RegisterInput, ip, userAgent string) (*LoginResult, error) {
	key := ip + "|register"
	if blocked, wait := s.LoginLimiter.Blocked(key); blocked {
		return nil, apperr.RateLimited(fmt.Sprintf("Too many attempts. Try again in %d min.", int(wait.Minutes())+1))
	}
	if ok, err := s.RegistrationOpen(ctx, in.Token); err != nil {
		return nil, err
	} else if !ok {
		s.LoginLimiter.Hit(key)
		return nil, errLinkClosed
	}
	username, err := NormalizeUsername(in.Username)
	if err != nil {
		return nil, err
	}
	name, err := normalizeName(in.FullName)
	if err != nil {
		return nil, apperr.Validation("Enter your name (up to 200 characters)")
	}
	if err := ValidatePassword(in.Password); err != nil {
		return nil, err
	}
	hash, err := HashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	var res *LoginResult
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		// again inside the transaction: the admin may have just disabled the link
		if ok, err := linkMatches(ctx, tx, in.Token); err != nil || !ok {
			if err == nil {
				err = errLinkClosed
			}
			return err
		}
		var id string
		if err := tx.QueryRow(ctx, `INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
			username, name, workflow.RoleRecruiter, hash).Scan(&id); err != nil {
			if db.IsUniqueViolation(err) {
				return apperr.Conflict("This login is taken: choose another one")
			}
			return err
		}
		if err := audit.Write(ctx, tx, audit.Entry{UserID: id, Action: "user.register", EntityType: "user", EntityID: id,
			Details: map[string]any{"username": username, "full_name": name, "role": workflow.RoleRecruiter}, Via: workflow.ViaWeb, IP: ip}); err != nil {
			return err
		}
		res, err = s.startSession(ctx, tx, id, ip, userAgent)
		return err
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}
