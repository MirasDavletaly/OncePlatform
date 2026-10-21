package auth

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=") {
		t.Fatalf("unexpected hash format: %s", hash)
	}
	ok, err := VerifyPassword("correct horse battery", hash)
	if err != nil || !ok {
		t.Fatalf("correct password rejected: ok=%v err=%v", ok, err)
	}
	ok, err = VerifyPassword("wrong password!!", hash)
	if err != nil || ok {
		t.Fatalf("wrong password accepted: ok=%v err=%v", ok, err)
	}
	hash2, _ := HashPassword("correct horse battery")
	if hash == hash2 {
		t.Fatal("hashes of the same password must differ (random salt)")
	}
	for _, bad := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA", "$argon2id$v=19$m=x$a$b"} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Errorf("malformed hash %q should error", bad)
		}
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("short"); err == nil {
		t.Error("short password accepted")
	}
	if err := ValidatePassword("          "); err == nil {
		t.Error("whitespace password accepted")
	}
	if err := ValidatePassword("Пароль12"); err != nil {
		t.Errorf("8-rune Cyrillic password rejected: %v", err)
	}
	if err := ValidatePassword(strings.Repeat("a", MaxPasswordLength+1)); err == nil {
		t.Error("overlong password accepted")
	}
}

func TestGeneratePassword(t *testing.T) {
	p, err := GeneratePassword(16)
	if err != nil || len(p) != 16 {
		t.Fatalf("got %q, %v", p, err)
	}
	if err := ValidatePassword(p); err != nil {
		t.Errorf("generated password violates policy: %v", err)
	}
}

func TestTokens(t *testing.T) {
	plain, hash, err := GenerateToken(PrefixAPIToken)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(plain, PrefixAPIToken) || len(plain) < 40 {
		t.Fatalf("bad token %q", plain)
	}
	if !bytes.Equal(hash, HashToken(plain)) {
		t.Fatal("hash must be deterministic")
	}
	if len(hash) != 32 {
		t.Fatalf("expected SHA-256 hash, got %d bytes", len(hash))
	}
	other, _, _ := GenerateToken(PrefixAPIToken)
	if other == plain {
		t.Fatal("tokens must be random")
	}
	if bytes.Equal(HashToken(other), hash) {
		t.Fatal("different tokens must hash differently")
	}
}

func TestCSRF(t *testing.T) {
	c := NewCSRF([]byte("0123456789abcdef0123456789abcdef"))
	tok := c.Issue("session-1")
	if !c.Valid(tok, "session-1") {
		t.Fatal("token should be valid for its binding")
	}
	if c.Valid(tok, "session-2") {
		t.Fatal("token must not be valid for another session")
	}
	if c.Valid(tok+"x", "session-1") || c.Valid("garbage", "session-1") || c.Valid("", "session-1") {
		t.Fatal("tampered tokens must be rejected")
	}
	other := NewCSRF([]byte("another-secret-another-secret-xx"))
	if other.Valid(tok, "session-1") {
		t.Fatal("token signed with a different secret must be rejected")
	}
}

func TestLimiter(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	l := NewLimiter(5, time.Minute, 5*time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < 4; i++ {
		if locked, _ := l.Hit("k"); locked {
			t.Fatalf("locked after %d hits", i+1)
		}
	}
	if locked, _ := l.Hit("k"); !locked {
		t.Fatal("5th failure within a minute must lock")
	}
	if b, _ := l.Blocked("k"); !b {
		t.Fatal("key should be blocked")
	}
	if b, _ := l.Blocked("other"); b {
		t.Fatal("other keys must not be blocked")
	}
	now = now.Add(5*time.Minute + time.Second)
	if b, _ := l.Blocked("k"); b {
		t.Fatal("lock should expire")
	}
	// Hits spread over more than the window do not lock.
	for i := 0; i < 10; i++ {
		now = now.Add(20 * time.Second)
		if locked, _ := l.Hit("slow"); locked {
			t.Fatalf("slow hits locked at %d", i)
		}
	}
	l.Reset("k")
	l.Cleanup()
}
