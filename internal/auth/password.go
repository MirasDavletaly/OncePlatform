// Package auth implements users, password hashing, browser sessions, CSRF
// protection, login rate limiting and personal API tokens.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"

	"onceplatform/internal/apperr"
)

// Argon2id parameters (RFC 9106 / OWASP recommendations for interactive logins).
const (
	argonMemory  = 32 * 1024 // KiB
	argonTime    = 3
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16

	MinPasswordLength = 8
	MaxPasswordLength = 256
)

var errInvalidHash = errors.New("invalid password hash format")

// argonSlots caps concurrent argon2 computations. Each one allocates
// argonMemory KiB, so without a cap a flood of anonymous login requests
// (random logins bypass the per-login limiter) can exhaust the host's RAM.
// ponytail: fixed 4 slots (~128 MiB); size from available RAM if the host changes.
var argonSlots = make(chan struct{}, 4)

func idKey(password, salt []byte, time, memory uint32, threads uint8, keyLen uint32) []byte {
	argonSlots <- struct{}{}
	defer func() { <-argonSlots }()
	return argon2.IDKey(password, salt, time, memory, threads, keyLen)
}

// HashPassword returns an encoded argon2id hash in PHC string format.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := idKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword checks password against an encoded argon2id hash in constant time.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errInvalidHash
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false, errInvalidHash
	}
	if memory == 0 || memory > 1<<20 || iterations == 0 || iterations > 20 || threads == 0 {
		return false, errInvalidHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errInvalidHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, errInvalidHash
	}
	got := idKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is used to equalize timing when a login email does not exist.
var dummyHash = func() string {
	h, err := HashPassword("timing-equalizer-password")
	if err != nil {
		panic(err)
	}
	return h
}()

// ValidatePassword enforces the password policy.
func ValidatePassword(password string) error {
	n := utf8.RuneCountInString(password)
	if n < MinPasswordLength {
		return apperr.Validationf("The password must be at least %d characters long", MinPasswordLength)
	}
	if n > MaxPasswordLength {
		return apperr.Validationf("The password is too long (maximum %d characters)", MaxPasswordLength)
	}
	if strings.TrimSpace(password) == "" {
		return apperr.Validation("The password cannot consist of spaces only")
	}
	return nil
}

const passwordAlphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// GeneratePassword returns a random password of the given length without
// ambiguous characters (used for admin password resets).
func GeneratePassword(length int) (string, error) {
	var b strings.Builder
	max := big.NewInt(int64(len(passwordAlphabet)))
	for i := 0; i < length; i++ {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(passwordAlphabet[n.Int64()])
	}
	return b.String(), nil
}
