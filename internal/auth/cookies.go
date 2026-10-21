package auth

import (
	"net"
	"net/http"
	"strings"
	"time"
)

// Cookie names. The session cookie is HttpOnly; the CSRF cookie must be
// readable by the frontend so it can echo the value in X-CSRF-Token.
const (
	SessionCookieName = "portal_session"
	CSRFCookieName    = "portal_csrf"
	CSRFHeaderName    = "X-CSRF-Token"
	CSRFFormField     = "csrf_token"
)

// trustedNets are networks from which X-Forwarded-* headers are trusted:
// loopback and private ranges (the Caddy container on the Docker network).
var trustedNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, cidr := range []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"} {
		_, n, _ := net.ParseCIDR(cidr)
		out = append(out, n)
	}
	return out
}()

func peerIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

// FromTrustedProxy reports whether the direct peer is a trusted reverse proxy.
func FromTrustedProxy(r *http.Request) bool {
	ip := peerIP(r)
	if ip == nil {
		return false
	}
	for _, n := range trustedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ClientIP returns the client address, honoring X-Forwarded-For / X-Real-IP
// only when the request comes through a trusted proxy.
func ClientIP(r *http.Request) string {
	if FromTrustedProxy(r) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(ip) != nil {
				return ip
			}
		}
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(xr) != nil {
			return xr
		}
	}
	if ip := peerIP(r); ip != nil {
		return ip.String()
	}
	return r.RemoteAddr
}

// IsSecureRequest reports whether the browser reached the portal over HTTPS
// (directly or via the TLS-terminating proxy). Cookies get the Secure flag
// on HTTPS; plain-HTTP access by IP (first-time setup) still works.
func IsSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return FromTrustedProxy(r) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// SetSessionCookie sets the HttpOnly session cookie.
func SetSessionCookie(w http.ResponseWriter, r *http.Request, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		Secure:   IsSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearSessionCookie removes the session cookie.
func ClearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: IsSecureRequest(r), SameSite: http.SameSiteLaxMode,
	})
}

// SetCSRFCookie sets the readable CSRF cookie.
func SetCSRFCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     CSRFCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(SessionTTL.Seconds()),
		HttpOnly: false,
		Secure:   IsSecureRequest(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// SessionToken returns the session cookie value, if any.
func SessionToken(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// CSRFBinding returns the binding for CSRF tokens of the request's principal.
func CSRFBinding(p *Principal) string {
	if p != nil && p.SessionID != "" {
		return p.SessionID
	}
	return AnonymousBinding
}

// EnsureCSRFCookie returns a CSRF token valid for binding, reusing the
// request's cookie when it is still valid and issuing a new one otherwise.
func (c *CSRF) EnsureCSRFCookie(w http.ResponseWriter, r *http.Request, binding string) string {
	if ck, err := r.Cookie(CSRFCookieName); err == nil && c.Valid(ck.Value, binding) {
		return ck.Value
	}
	tok := c.Issue(binding)
	SetCSRFCookie(w, r, tok)
	return tok
}

// CheckCSRF verifies the double-submit token: the submitted value (header or
// form field) must equal the cookie and be valid for binding.
func (c *CSRF) CheckCSRF(r *http.Request, submitted, binding string) bool {
	ck, err := r.Cookie(CSRFCookieName)
	if err != nil || ck.Value == "" || submitted == "" {
		return false
	}
	if ck.Value != submitted {
		return false
	}
	return c.Valid(submitted, binding)
}
