// Package config loads application settings from environment variables.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime settings. Every value comes from the environment
// (see .env.example); there are no config files.
type Config struct {
	Domain      string
	BaseURL     string // public URL of the portal without trailing slash, e.g. https://portal.example.kz
	Timezone    string
	Location    *time.Location
	ListenAddr  string
	DatabaseURL string

	CSRFSecret []byte

	// InitialUsers are created on the first start, when the users table is
	// empty, all with InitialPassword (they can change it in the profile).
	InitialUsers    []InitialUser
	InitialPassword string

	UploadMaxMB int64
	StoragePath string

	// CVEngineDir holds the CV rules engine (cvengine/cli.mjs), run with NodeBin.
	CVEngineDir string
	NodeBin     string

	SeedDemo bool
	LogLevel slog.Level

	// GeneratedCSRFSecret is true when CSRF_SECRET was missing and a random
	// one was generated for this process.
	GeneratedCSRFSecret bool
}

// Load reads the configuration from the environment and validates it.
func Load() (*Config, error) {
	c := &Config{
		Domain:          strings.TrimSpace(os.Getenv("DOMAIN")),
		Timezone:        env("APP_TIMEZONE", "Asia/Almaty"),
		ListenAddr:      env("LISTEN_ADDR", ":8080"),
		DatabaseURL:     strings.TrimSpace(os.Getenv("DATABASE_URL")),
		InitialPassword: os.Getenv("INITIAL_PASSWORD"),
		StoragePath:     env("STORAGE_PATH", "/data/uploads"),
		CVEngineDir:     env("CV_ENGINE_DIR", "/app/cvengine"),
		NodeBin:         env("NODE_BIN", "node"),
	}

	base := strings.TrimRight(strings.TrimSpace(os.Getenv("APP_BASE_URL")), "/")
	if base == "" {
		if c.Domain != "" {
			base = "https://" + c.Domain
		} else {
			base = "http://localhost:8080"
		}
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("APP_BASE_URL must be an absolute http(s) URL, got %q", base)
	}
	if u.Path != "" && u.Path != "/" {
		return nil, fmt.Errorf("APP_BASE_URL must not contain a path, got %q", base)
	}
	c.BaseURL = u.Scheme + "://" + u.Host

	loc, err := time.LoadLocation(c.Timezone)
	if err != nil {
		return nil, fmt.Errorf("APP_TIMEZONE %q: %w", c.Timezone, err)
	}
	c.Location = loc

	if c.DatabaseURL == "" {
		user := env("POSTGRES_USER", "portal")
		pass := os.Getenv("POSTGRES_PASSWORD")
		name := env("POSTGRES_DB", "portal")
		host := env("POSTGRES_HOST", "db")
		if pass == "" {
			return nil, errors.New("DATABASE_URL or POSTGRES_PASSWORD must be set")
		}
		c.DatabaseURL = (&url.URL{
			Scheme:   "postgres",
			User:     url.UserPassword(user, pass),
			Host:     host + ":5432",
			Path:     "/" + name,
			RawQuery: "sslmode=disable",
		}).String()
	}

	secret := strings.TrimSpace(os.Getenv("CSRF_SECRET"))
	if secret == "" {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		c.CSRFSecret = buf
		c.GeneratedCSRFSecret = true
	} else {
		if len(secret) < 32 {
			return nil, errors.New("CSRF_SECRET must be at least 32 characters (use: openssl rand -hex 32)")
		}
		if b, err := hex.DecodeString(secret); err == nil && len(b) >= 16 {
			c.CSRFSecret = b
		} else {
			c.CSRFSecret = []byte(secret)
		}
	}

	c.InitialUsers, err = parseInitialUsers(env("INITIAL_USERS", DefaultInitialUsers))
	if err != nil {
		return nil, err
	}

	c.UploadMaxMB, err = envInt("UPLOAD_MAX_MB", 50)
	if err != nil {
		return nil, err
	}
	if c.UploadMaxMB < 1 || c.UploadMaxMB > 2048 {
		return nil, errors.New("UPLOAD_MAX_MB must be between 1 and 2048")
	}

	c.SeedDemo, err = envBool("SEED_DEMO", false)
	if err != nil {
		return nil, err
	}

	switch strings.ToLower(env("LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "warn", "warning":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		c.LogLevel = slog.LevelInfo
	}

	return c, nil
}

// InitialUser describes a user created on the first start.
type InitialUser struct {
	Username string
	Role     string
	FullName string
}

// DefaultInitialUsers is the team created when INITIAL_USERS is not set.
const DefaultInitialUsers = "Alessio:admin,Dinara:coordinator,Miras:analyst"

// parseInitialUsers parses "login:role[:Full name],login:role[:Full name]".
func parseInitialUsers(spec string) ([]InitialUser, error) {
	var out []InitialUser
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		parts := strings.SplitN(item, ":", 3)
		if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
			return nil, fmt.Errorf("INITIAL_USERS: expected login:role[:Full name], got %q", item)
		}
		u := InitialUser{Username: strings.TrimSpace(parts[0]), Role: strings.TrimSpace(parts[1])}
		switch u.Role {
		case "admin", "coordinator", "analyst":
		default:
			return nil, fmt.Errorf("INITIAL_USERS: unknown role %q (admin, coordinator, analyst)", u.Role)
		}
		if len(parts) == 3 {
			u.FullName = strings.TrimSpace(parts[2])
		}
		if u.FullName == "" {
			u.FullName = u.Username
		}
		out = append(out, u)
	}
	return out, nil
}

// MCPResourceURL is the canonical URI of the MCP resource server (RFC 8707/9728).
func (c *Config) MCPResourceURL() string { return c.BaseURL + "/mcp" }

// ResourceMetadataURL is the RFC 9728 protected resource metadata document URL.
func (c *Config) ResourceMetadataURL() string {
	return c.BaseURL + "/.well-known/oauth-protected-resource"
}

// UploadMaxBytes is the per-file upload limit in bytes.
func (c *Config) UploadMaxBytes() int64 { return c.UploadMaxMB << 20 }

// HTTPS reports whether the public base URL uses TLS.
func (c *Config) HTTPS() bool { return strings.HasPrefix(c.BaseURL, "https://") }

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int64) (int64, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer, got %q", key, v)
	}
	return n, nil
}

func envBool(key string, def bool) (bool, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false, got %q", key, v)
	}
	return b, nil
}
