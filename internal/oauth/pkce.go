package oauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var verifierRe = regexp.MustCompile(`^[A-Za-z0-9\-._~]{43,128}$`)
var challengeRe = regexp.MustCompile(`^[A-Za-z0-9\-_]{43}$`)

// S256Challenge computes the PKCE S256 code challenge of a verifier.
func S256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// ValidChallenge reports whether c is a syntactically valid S256 challenge.
func ValidChallenge(c string) bool { return challengeRe.MatchString(c) }

// VerifyPKCE checks a code_verifier against the stored S256 challenge
// (RFC 7636). Only S256 is supported; "plain" is rejected by design.
func VerifyPKCE(verifier, challenge, method string) bool {
	if method != "S256" || !verifierRe.MatchString(verifier) || !ValidChallenge(challenge) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(S256Challenge(verifier)), []byte(challenge)) == 1
}

// claudeHosts are the only https return addresses a client may register: the
// portal's OAuth server exists for Claude connectors, and an open list let
// anyone register "Claude" with their own (or a look-alike) host and ask a
// team member for consent.
var claudeHosts = map[string]bool{"claude.ai": true, "claude.com": true}

// ValidateRedirectURI enforces the redirect URI policy: https on Claude's
// hosts, or http only for loopback hosts (Claude Code and other local clients).
// No fragments and no credentials in the URL.
func ValidateRedirectURI(raw string) error {
	if raw == "" || len(raw) > 2000 {
		return errors.New("redirect_uri is empty or too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("redirect_uri is not a valid URL")
	}
	if u.Fragment != "" || strings.Contains(raw, "#") {
		return errors.New("redirect_uri must not contain a fragment")
	}
	if u.User != nil {
		return errors.New("redirect_uri must not contain credentials")
	}
	if u.Host == "" {
		return errors.New("redirect_uri must be absolute")
	}
	switch u.Scheme {
	case "https":
		if claudeHosts[u.Hostname()] {
			return nil
		}
		return errors.New("https redirect_uri is allowed only on claude.ai or claude.com")
	case "http":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		return errors.New("http redirect_uri is allowed only for localhost / 127.0.0.1")
	}
	return errors.New("redirect_uri must use https (or http://localhost)")
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// redirectMatches compares a requested redirect URI with a registered one.
// Loopback redirect URIs match regardless of port (RFC 8252 §7.3).
func redirectMatches(registered, requested string) bool {
	if registered == requested {
		return true
	}
	ru, err1 := url.Parse(registered)
	qu, err2 := url.Parse(requested)
	if err1 != nil || err2 != nil {
		return false
	}
	if ru.Scheme == "http" && qu.Scheme == "http" && isLoopbackHost(ru.Hostname()) && ru.Hostname() == qu.Hostname() {
		return ru.Path == qu.Path && ru.RawQuery == qu.RawQuery
	}
	return false
}

// origin returns scheme://host of a URL (used for the consent page CSP).
func origin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
