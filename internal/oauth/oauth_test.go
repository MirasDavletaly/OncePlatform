package oauth

import (
	"testing"

	"onceplatform/internal/config"
)

func TestPKCE(t *testing.T) {
	// Test vector from RFC 7636, Appendix B.
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	challenge := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := S256Challenge(verifier); got != challenge {
		t.Fatalf("S256Challenge = %s, want %s", got, challenge)
	}
	if !VerifyPKCE(verifier, challenge, "S256") {
		t.Fatal("valid verifier rejected")
	}
	if VerifyPKCE(verifier, challenge, "plain") {
		t.Fatal("plain method must be rejected")
	}
	if VerifyPKCE(verifier+"x", challenge, "S256") {
		t.Fatal("wrong verifier accepted")
	}
	if VerifyPKCE("short", S256Challenge("short"), "S256") {
		t.Fatal("verifier shorter than 43 chars must be rejected")
	}
	if VerifyPKCE(verifier, "not-a-challenge", "S256") {
		t.Fatal("malformed challenge accepted")
	}
	if !ValidChallenge(challenge) || ValidChallenge(challenge+"=") {
		t.Fatal("ValidChallenge mismatch")
	}
}

func TestValidateRedirectURI(t *testing.T) {
	good := []string{
		"https://claude.ai/api/mcp/auth_callback",
		"https://example.com/cb?x=1",
		"http://localhost:33418/callback",
		"http://127.0.0.1:6274/oauth/callback",
		"http://[::1]:8080/cb",
	}
	for _, u := range good {
		if err := ValidateRedirectURI(u); err != nil {
			t.Errorf("%s rejected: %v", u, err)
		}
	}
	bad := []string{
		"", "http://evil.com/cb", "javascript:alert(1)", "claude://callback", "/relative",
		"https://example.com/cb#frag", "https://user:pass@example.com/cb", "ftp://example.com",
	}
	for _, u := range bad {
		if err := ValidateRedirectURI(u); err == nil {
			t.Errorf("%q accepted", u)
		}
	}
}

func TestRedirectMatches(t *testing.T) {
	if !redirectMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback") {
		t.Error("exact match failed")
	}
	if redirectMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback2") {
		t.Error("different path matched")
	}
	if !redirectMatches("http://127.0.0.1:1111/cb", "http://127.0.0.1:2222/cb") {
		t.Error("loopback redirect must match on any port (RFC 8252)")
	}
	if redirectMatches("http://127.0.0.1:1111/cb", "http://127.0.0.1:2222/other") {
		t.Error("loopback with different path matched")
	}
	if redirectMatches("https://a.com:443/cb", "https://a.com:8443/cb") {
		t.Error("non-loopback port change must not match")
	}
}

func TestCanonicalResource(t *testing.T) {
	s := &Server{cfg: &config.Config{BaseURL: "https://portal.example.kz"}}
	for _, in := range []string{"", "https://portal.example.kz/mcp", "https://portal.example.kz/mcp/", "https://portal.example.kz"} {
		if r, ok := s.canonicalResource(in); !ok || r != "https://portal.example.kz/mcp" {
			t.Errorf("canonicalResource(%q) = %q, %v", in, r, ok)
		}
	}
	if _, ok := s.canonicalResource("https://other.example.com/mcp"); ok {
		t.Error("foreign resource accepted")
	}
}
