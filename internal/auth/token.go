package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// Token prefixes make it obvious what kind of secret a string is and let the
// bearer verifier route it to the right table without guessing.
const (
	PrefixSession      = "ses_"
	PrefixAPIToken     = "pat_"
	PrefixOAuthAccess  = "oat_"
	PrefixOAuthRefresh = "ort_"
	PrefixOAuthCode    = "oac_"
)

// RandomToken returns n random bytes encoded as base64url without padding.
func RandomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// GenerateToken returns a new 32-byte random token with the given prefix and
// its SHA-256 hash. Only the hash is ever stored in the database.
func GenerateToken(prefix string) (plain string, hash []byte, err error) {
	r, err := RandomToken(32)
	if err != nil {
		return "", nil, err
	}
	plain = prefix + r
	return plain, HashToken(plain), nil
}

// HashToken hashes a high-entropy token for storage and lookup. A fast hash
// is appropriate here because tokens carry 256 bits of randomness.
func HashToken(plain string) []byte {
	sum := sha256.Sum256([]byte(plain))
	return sum[:]
}

// HasPrefix reports whether token starts with prefix.
func HasPrefix(token, prefix string) bool { return strings.HasPrefix(token, prefix) }

// CSRF implements signed double-submit CSRF tokens. The token is stored in a
// readable cookie and must be echoed in the X-CSRF-Token header (or a form
// field); its HMAC binds it to the current session so a token planted from
// elsewhere cannot be reused with another session.
type CSRF struct {
	secret []byte
}

// NewCSRF creates a CSRF helper with the given secret.
func NewCSRF(secret []byte) *CSRF { return &CSRF{secret: secret} }

// AnonymousBinding is used before the user has a session.
const AnonymousBinding = "anon"

// Issue creates a new token bound to binding (the session ID or AnonymousBinding).
func (c *CSRF) Issue(binding string) string {
	nonce := make([]byte, 18)
	_, _ = rand.Read(nonce)
	n := base64.RawURLEncoding.EncodeToString(nonce)
	return n + "." + c.sign(n, binding)
}

// Valid reports whether token is a well-formed token issued for binding.
func (c *CSRF) Valid(token, binding string) bool {
	n, sig, ok := strings.Cut(token, ".")
	if !ok || n == "" || sig == "" {
		return false
	}
	return hmac.Equal([]byte(sig), []byte(c.sign(n, binding)))
}

func (c *CSRF) sign(nonce, binding string) string {
	m := hmac.New(sha256.New, c.secret)
	m.Write([]byte("csrf|" + nonce + "|" + binding))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
