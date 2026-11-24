// Command server runs the OncePlatform portal: REST API, embedded web UI,
// OAuth 2.1 authorization server and MCP endpoint on a single port.
//
// Subcommands (for operations inside the container):
//
//	server                         start the portal (default)
//	server healthcheck             exit 0 if /healthz answers (Docker HEALTHCHECK)
//	server reset-password LOGIN [PASSWORD]
//	                               set a new password (generated if omitted)
//	server version                 print the version
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // embedded time zone database (Asia/Almaty etc.)

	"onceplatform/internal/auth"
	"onceplatform/internal/config"
	"onceplatform/internal/cv"
	"onceplatform/internal/db"
	"onceplatform/internal/files"
	"onceplatform/internal/httpapi"
	"onceplatform/internal/mcp"
	"onceplatform/internal/notify"
	"onceplatform/internal/oauth"
	"onceplatform/internal/search"
	"onceplatform/internal/seed"
	"onceplatform/internal/tickets"
	"onceplatform/internal/webui"
	"onceplatform/internal/workflow"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	var err error
	switch cmd {
	case "", "serve":
		err = serve()
	case "healthcheck":
		err = healthcheck()
	case "reset-password":
		err = resetPassword(args[1:])
	case "version":
		fmt.Println(version)
	default:
		err = fmt.Errorf("unknown command %q (use: serve, healthcheck, reset-password, version)", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func newLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := newLogger(cfg.LogLevel)
	slog.SetDefault(log)
	log.Info("starting OncePlatform", "version", version, "base_url", cfg.BaseURL, "listen", cfg.ListenAddr,
		"timezone", cfg.Timezone)
	if cfg.GeneratedCSRFSecret {
		log.Warn("CSRF_SECRET is not set; a random secret was generated (users will need to reload pages after a restart)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, 90*time.Second, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, log); err != nil {
		return err
	}

	authSvc := auth.NewService(pool, log, cfg.CSRFSecret)
	if _, err := authSvc.EnsureInitialUsers(ctx, cfg.InitialUsers, cfg.InitialPassword); err != nil {
		return fmt.Errorf("create initial users: %w", err)
	}
	ticketSvc := tickets.NewService(pool, log, cfg.Location)
	notifySvc := notify.NewService(pool, log, cfg.Location)
	searchSvc := search.NewService(pool)
	fileSvc, err := files.NewService(pool, log, cfg.StoragePath, cfg.UploadMaxBytes(), cfg.Location)
	if err != nil {
		return err
	}
	cvSvc, err := cv.NewService(pool, log, cfg.StoragePath, cfg.UploadMaxBytes(), cfg.Location,
		&cv.Engine{Node: cfg.NodeBin, Dir: cfg.CVEngineDir})
	if err != nil {
		return err
	}
	oauthSrv := oauth.NewServer(pool, log, cfg, authSvc)

	if cfg.SeedDemo {
		if err := seed.Demo(ctx, seed.Services{Pool: pool, Log: log, Loc: cfg.Location,
			Tickets: ticketSvc, Files: fileSvc}); err != nil {
			log.Error("demo seed failed", "error", err.Error())
		}
	}

	mcpHandler := mcp.NewHandler(mcp.Deps{
		Cfg: cfg, Log: log, Version: version, Auth: authSvc, OAuth: oauthSrv, Tickets: ticketSvc,
		Files: fileSvc, CV: cvSvc, Search: searchSvc,
	})
	router := httpapi.NewRouter(httpapi.Deps{
		Cfg: cfg, Log: log, Pool: pool, Version: version, Auth: authSvc, OAuth: oauthSrv, Tickets: ticketSvc,
		Files: fileSvc, CV: cvSvc, Search: searchSvc, Notify: notifySvc,
		MCP: mcpHandler, Web: webui.FS(),
	})

	go fileSvc.RunExtractor(ctx, 2)
	go cvSvc.Run(ctx)
	go notifySvc.Run(ctx)
	go maintenance(ctx, log, authSvc, oauthSrv)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	errCh := make(chan error, 1)
	go func() {
		log.Info("http server listening", "addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		if err != nil {
			return err
		}
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err.Error())
	}
	return nil
}

// maintenance removes expired sessions, OAuth codes and tokens every hour.
func maintenance(ctx context.Context, log *slog.Logger, a *auth.Service, o *oauth.Server) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.Cleanup(ctx); err != nil && ctx.Err() == nil {
				log.Error("session cleanup failed", "error", err.Error())
			}
			if err := o.Cleanup(ctx); err != nil && ctx.Err() == nil {
				log.Error("oauth cleanup failed", "error", err.Error())
			}
		}
	}
}

func healthcheck() error {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %d", resp.StatusCode)
	}
	return nil
}

func resetPassword(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: server reset-password LOGIN [NEW_PASSWORD]")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := newLogger(slog.LevelWarn)
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL, 30*time.Second, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, log); err != nil {
		return err
	}
	authSvc := auth.NewService(pool, log, cfg.CSRFSecret)
	var id string
	if err := pool.QueryRow(ctx, `SELECT id FROM users WHERE lower(username) = lower($1)`, args[0]).Scan(&id); err != nil {
		return fmt.Errorf("user %s not found", args[0])
	}
	password := ""
	if len(args) > 1 {
		password = args[1]
	}
	system := workflow.Actor{UserID: id, Name: "cli", Role: workflow.RoleAdmin, Via: workflow.ViaSystem, IP: "cli"}
	pw, err := authSvc.ResetPassword(ctx, system, id, password)
	if err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET is_active = true WHERE id = $1`, id); err != nil {
		return err
	}
	fmt.Printf("Password for %s has been reset.\nNew password: %s\n", args[0], pw)
	return nil
}
