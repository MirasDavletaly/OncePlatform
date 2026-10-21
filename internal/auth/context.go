package auth

import "context"

// Principal describes the authenticated caller of an HTTP request.
type Principal struct {
	User      *User
	SessionID string // set for browser sessions
	Kind      string // "session", "api_token" or "oauth"
}

type principalKey struct{}

// WithPrincipal stores p in ctx.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the principal stored in ctx, or nil.
func PrincipalFrom(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey{}).(*Principal)
	return p
}
