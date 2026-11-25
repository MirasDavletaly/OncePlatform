package auth

import (
	"context"
	"fmt"
	"log/slog"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/config"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

const (
	SessionTTL = 7 * 24 * time.Hour
	// sessionMaxAge ends a session however active it is: a stolen cookie
	// cannot be kept alive forever by the sliding expiry.
	sessionMaxAge = 30 * 24 * time.Hour
	// sessionRefreshAfter controls how often the sliding expiry is pushed
	// forward (to avoid a database write on every request).
	sessionRefreshAfter = 10 * time.Minute

	// Per client address regardless of the login: random logins (each a new
	// limiter key) and one-time code guesses are capped too.
	ipMaxAttempts = 60
	ipWindow      = 10 * time.Minute
	ipLockout     = 15 * time.Minute

	loginMaxAttempts = 5
	loginWindow      = time.Minute
	loginLockout     = 5 * time.Minute

	// Per-login cap regardless of the client IP: the per-IP limiter alone
	// allows 4 guesses a minute forever and nothing against rotating IPs.
	userMaxAttempts = 20
	userWindow      = time.Hour
	userLockout     = time.Hour
)

// Languages supported by the interface.
var Languages = []string{"en", "ru"}

// User is a portal user. Users sign in with their username (login).
type User struct {
	ID          string        `json:"id"`
	Username    string        `json:"username"`
	Email       string        `json:"email"`
	FullName    string        `json:"full_name"`
	Role        workflow.Role `json:"role"`
	IsActive    bool          `json:"is_active"`
	Language    string        `json:"language"`
	LastLoginAt *time.Time    `json:"last_login_at"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
	// a one-time code was issued and not used yet (InviteExpiresAt: until when it works)
	InvitePending   bool       `json:"invite_pending"`
	InviteExpiresAt *time.Time `json:"invite_expires_at,omitempty"`
}

// Actor returns the workflow actor for this user acting through via.
func (u *User) Actor(via workflow.Via, ip string) workflow.Actor {
	return workflow.Actor{UserID: u.ID, Name: u.FullName, Role: u.Role, Via: via, IP: ip}
}

// Service implements authentication and user management.
type Service struct {
	pool         *pgxpool.Pool
	log          *slog.Logger
	CSRF         *CSRF
	LoginLimiter *Limiter // keyed by IP + login
	UserLimiter  *Limiter // keyed by login only
	IPLimiter    *Limiter // keyed by IP only: failed sign-ins, codes and registration links
}

// NewService creates the auth service.
func NewService(pool *pgxpool.Pool, log *slog.Logger, csrfSecret []byte) *Service {
	return &Service{
		pool:         pool,
		log:          log,
		CSRF:         NewCSRF(csrfSecret),
		LoginLimiter: NewLimiter(loginMaxAttempts, loginWindow, loginLockout),
		UserLimiter:  NewLimiter(userMaxAttempts, userWindow, userLockout),
		IPLimiter:    NewLimiter(ipMaxAttempts, ipWindow, ipLockout),
	}
}

// endAccess signs a user out everywhere except keepSessionID (empty: all
// sessions) and revokes their personal API tokens and Claude (OAuth) tokens:
// after a password change, a reset or a deactivation nothing issued before
// keeps working.
func endAccess(ctx context.Context, tx pgx.Tx, userID, keepSessionID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND id::text <> $2`, userID, keepSessionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	return err
}

// validLogin: a login that could exist. Anything else is refused before the
// limiters and the audit log see it (a 60 KB "login" must not be kept in memory).
func validLogin(username string) bool {
	return usernameRe.MatchString(strings.TrimSpace(username))
}

const userColumns = `id, username, email, full_name, role, is_active, language, last_login_at, created_at, updated_at,
	(invite_hash IS NOT NULL AND invite_expires_at > now()), invite_expires_at`

func scanUser(row pgx.Row) (*User, error) {
	var u User
	if err := row.Scan(&u.ID, &u.Username, &u.Email, &u.FullName, &u.Role, &u.IsActive, &u.Language,
		&u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt, &u.InvitePending, &u.InviteExpiresAt); err != nil {
		return nil, err
	}
	return &u, nil
}

// GetUser loads a user by ID.
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
	if !db.IsUUID(id) {
		return nil, apperr.NotFound("User not found")
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
	if db.IsNoRows(err) {
		return nil, apperr.NotFound("User not found")
	}
	return u, err
}

// ListUsers returns users ordered by name.
func (s *Service) ListUsers(ctx context.Context, includeInactive bool) ([]User, error) {
	q := `SELECT ` + userColumns + ` FROM users`
	if !includeInactive {
		q += ` WHERE is_active`
	}
	rows, err := s.pool.Query(ctx, q+` ORDER BY full_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

// CountUsers returns the number of users.
func (s *Service) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

var usernameRe = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N}._-]{1,49}$`)

// NormalizeUsername trims and validates a login. Logins are unique
// case-insensitively; the original spelling is kept for display.
func NormalizeUsername(username string) (string, error) {
	username = strings.TrimSpace(username)
	if !usernameRe.MatchString(username) {
		return "", apperr.Validation("Login must be 2–50 characters: letters, digits, dot, dash or underscore")
	}
	return username, nil
}

// NormalizeEmail lowercases and validates an optional email address.
func NormalizeEmail(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return "", nil
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return "", apperr.Validation("Invalid email address")
	}
	return email, nil
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 200 {
		return "", apperr.Validation("Enter the user's name (up to 200 characters)")
	}
	return name, nil
}

// CreateUserInput holds fields for a new user.
type CreateUserInput struct {
	Username string        `json:"username"`
	Email    string        `json:"email"`
	FullName string        `json:"full_name"`
	Role     workflow.Role `json:"role"`
	Password string        `json:"password"`
	// Invite: no password; the person gets a one-time code (IssueInvite) and sets their own
	Invite bool `json:"invite"`
}

// CreateUser creates a user (admin only, or system bootstrap when actor is nil).
func (s *Service) CreateUser(ctx context.Context, actor *workflow.Actor, in CreateUserInput) (*User, error) {
	if actor != nil {
		if err := actor.Require(workflow.PermUsersManage); err != nil {
			return nil, err
		}
	}
	username, err := NormalizeUsername(in.Username)
	if err != nil {
		return nil, err
	}
	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return nil, err
	}
	if in.FullName == "" {
		in.FullName = username
	}
	name, err := normalizeName(in.FullName)
	if err != nil {
		return nil, err
	}
	if !in.Role.Valid() {
		return nil, apperr.Validation("Unknown role")
	}
	if in.Invite { // a password nobody knows until the person sets theirs with the code
		if in.Password, err = GeneratePassword(32); err != nil {
			return nil, err
		}
	}
	if err := ValidatePassword(in.Password); err != nil {
		return nil, err
	}
	hash, err := HashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	var u *User
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		u, err = scanUser(tx.QueryRow(ctx, `
			INSERT INTO users (username, email, full_name, role, password_hash)
			VALUES ($1, $2, $3, $4, $5) RETURNING `+userColumns, username, email, name, in.Role, hash))
		if err != nil {
			if db.IsUniqueViolation(err) {
				return apperr.Conflict("A user with this login already exists")
			}
			return err
		}
		details := map[string]any{"username": username, "full_name": name, "role": in.Role}
		e := audit.Entry{Action: "user.create", EntityType: "user", EntityID: u.ID, Via: workflow.ViaSystem, Details: details}
		if actor != nil {
			e = audit.FromActor(*actor, "user.create", "user", u.ID, details)
		}
		return audit.Write(ctx, tx, e)
	})
	if err != nil {
		return nil, err
	}
	return u, nil
}

// UpdateUserInput holds optional fields to change.
type UpdateUserInput struct {
	Username *string        `json:"username"`
	Email    *string        `json:"email"`
	FullName *string        `json:"full_name"`
	Role     *workflow.Role `json:"role"`
	IsActive *bool          `json:"is_active"`
}

// UpdateUser changes a user's login, profile, role or active flag (admin only).
func (s *Service) UpdateUser(ctx context.Context, actor workflow.Actor, id string, in UpdateUserInput) (*User, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return nil, err
	}
	cur, err := s.GetUser(ctx, id)
	if err != nil {
		return nil, err
	}
	changes := map[string]any{}
	username, email, name, role, active := cur.Username, cur.Email, cur.FullName, cur.Role, cur.IsActive
	if in.Username != nil {
		v, err := NormalizeUsername(*in.Username)
		if err != nil {
			return nil, err
		}
		if v != username {
			changes["username"] = map[string]any{"from": username, "to": v}
			username = v
		}
	}
	if in.Email != nil {
		v, err := NormalizeEmail(*in.Email)
		if err != nil {
			return nil, err
		}
		if v != email {
			changes["email"] = map[string]any{"from": email, "to": v}
			email = v
		}
	}
	if in.FullName != nil {
		v, err := normalizeName(*in.FullName)
		if err != nil {
			return nil, err
		}
		if v != name {
			changes["full_name"] = map[string]any{"from": name, "to": v}
			name = v
		}
	}
	if in.Role != nil {
		if !in.Role.Valid() {
			return nil, apperr.Validation("Unknown role")
		}
		if *in.Role != role {
			if cur.ID == actor.UserID {
				return nil, apperr.Validation("You cannot change your own role")
			}
			changes["role"] = map[string]any{"from": role, "to": *in.Role}
			role = *in.Role
		}
	}
	if in.IsActive != nil && *in.IsActive != active {
		if cur.ID == actor.UserID && !*in.IsActive {
			return nil, apperr.Validation("You cannot deactivate your own account")
		}
		changes["is_active"] = map[string]any{"from": active, "to": *in.IsActive}
		active = *in.IsActive
	}
	if len(changes) == 0 {
		return cur, nil
	}
	var u *User
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if cur.Role == workflow.RoleAdmin && (role != workflow.RoleAdmin || !active) {
			var admins int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'admin' AND is_active AND id <> $1`, id).Scan(&admins); err != nil {
				return err
			}
			if admins == 0 {
				return apperr.Validation("At least one active administrator must remain")
			}
		}
		var err error
		u, err = scanUser(tx.QueryRow(ctx, `
			UPDATE users SET username = $2, email = $3, full_name = $4, role = $5, is_active = $6, updated_at = now()
			WHERE id = $1 RETURNING `+userColumns, id, username, email, name, role, active))
		if err != nil {
			if db.IsUniqueViolation(err) {
				return apperr.Conflict("A user with this login already exists")
			}
			return err
		}
		if !active {
			if err := endAccess(ctx, tx, id, ""); err != nil {
				return err
			}
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "user.update", "user", id, map[string]any{"changes": changes, "username": username}))
	})
	if err != nil {
		return nil, err
	}
	return u, nil
}

// SetLanguage stores the interface language of the actor.
func (s *Service) SetLanguage(ctx context.Context, actor workflow.Actor, lang string) (*User, error) {
	valid := false
	for _, l := range Languages {
		if l == lang {
			valid = true
		}
	}
	if !valid {
		return nil, apperr.Validation("Unsupported language")
	}
	return scanUser(s.pool.QueryRow(ctx, `UPDATE users SET language = $2, updated_at = now() WHERE id = $1 RETURNING `+userColumns,
		actor.UserID, lang))
}

// ResetPassword sets a new password for a user (admin only). If password is
// empty a random one is generated. All sessions of the user are terminated.
func (s *Service) ResetPassword(ctx context.Context, actor workflow.Actor, id, password string) (string, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return "", err
	}
	if _, err := s.GetUser(ctx, id); err != nil {
		return "", err
	}
	if password == "" {
		var err error
		if password, err = GeneratePassword(12); err != nil {
			return "", err
		}
	}
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return "", err
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		// a password set by the admin cancels a pending one-time code
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, invite_hash = NULL, invite_expires_at = NULL, updated_at = now()
			WHERE id = $1`, id, hash); err != nil {
			return err
		}
		if err := endAccess(ctx, tx, id, ""); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "user.password_reset", "user", id, nil))
	})
	if err != nil {
		return "", err
	}
	return password, nil
}

// ChangePassword changes the actor's own password after verifying the
// current one. Other sessions of the user are terminated.
func (s *Service) ChangePassword(ctx context.Context, actor workflow.Actor, keepSessionID, current, next string) error {
	// a stolen session must not be a way to guess the password: wrong current passwords count like failed sign-ins
	key := "password|" + actor.UserID
	if blocked, wait := s.UserLimiter.Blocked(key); blocked {
		return apperr.RateLimited(fmt.Sprintf("Too many attempts. Try again in %d min.", int(wait.Minutes())+1))
	}
	var hash string
	if err := s.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, actor.UserID).Scan(&hash); err != nil {
		return err
	}
	ok, err := VerifyPassword(current, hash)
	if err != nil {
		return err
	}
	if !ok {
		s.UserLimiter.Hit(key)
		return apperr.New(422, "wrong_password", "The current password is incorrect")
	}
	if err := ValidatePassword(next); err != nil {
		return err
	}
	if current == next {
		return apperr.Validation("The new password must differ from the current one")
	}
	newHash, err := HashPassword(next)
	if err != nil {
		return err
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		// a pending one-time code is cancelled too: the person has a password of their own now
		if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, invite_hash = NULL, invite_expires_at = NULL, updated_at = now()
			WHERE id = $1`, actor.UserID, newHash); err != nil {
			return err
		}
		if err := endAccess(ctx, tx, actor.UserID, keepSessionID); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "user.password_change", "user", actor.UserID, nil))
	})
}

// EnsureInitialUsers creates the team accounts when the users table is empty.
func (s *Service) EnsureInitialUsers(ctx context.Context, users []config.InitialUser, password string) (int, error) {
	n, err := s.CountUsers(ctx)
	if err != nil || n > 0 {
		return 0, err
	}
	if len(users) == 0 || password == "" {
		s.log.Warn("no users exist and INITIAL_USERS/INITIAL_PASSWORD are not set; nobody can log in")
		return 0, nil
	}
	created := 0
	for _, iu := range users {
		if _, err := s.CreateUser(ctx, nil, CreateUserInput{Username: iu.Username, FullName: iu.FullName,
			Role: workflow.Role(iu.Role), Password: password}); err != nil {
			return created, err
		}
		s.log.Info("initial user created", "username", iu.Username, "role", iu.Role)
		created++
	}
	return created, nil
}

// Cleanup deletes expired sessions and resets idle limiter entries.
func (s *Service) Cleanup(ctx context.Context) error {
	s.LoginLimiter.Cleanup()
	s.UserLimiter.Cleanup()
	s.IPLimiter.Cleanup()
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	return err
}
