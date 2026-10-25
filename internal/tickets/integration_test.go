package tickets

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"onceplatform/internal/apperr"
	"onceplatform/internal/migrations"
	"onceplatform/internal/workflow"
)

// Uses only a newly created schema, never existing application tables.
// TEST_DATABASE_URL must point to a disposable PostgreSQL database.
func TestPostgresShortlistAndWorkflow(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("shortlist_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`); err != nil {
			t.Error(err)
		}
	}()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, 1); err != nil {
		t.Fatal(err)
	}
	var user string
	if err := pool.QueryRow(ctx, `INSERT INTO users(username,full_name,role,password_hash) VALUES('test','Test','admin','unused') RETURNING id`).Scan(&user); err != nil {
		t.Fatal(err)
	}
	// The upgrade must retain both historical duplicates and old lost tasks.
	for i, source := range []string{"https://Example.org:443/legacy", "https://example.org/legacy"} {
		if _, err := pool.Exec(ctx, `INSERT INTO tickets(number,title,source_url,created_by) VALUES($1,'Legacy',$2,$3)`, fmt.Sprintf("LEGACY-%d", i), source, user); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tickets(number,title,created_by,status,close_result) VALUES('OLD-LOST','Old loss',$1,'closed','lost')`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, slog.Default(), time.FixedZone("Portal", 5*3600))
	actor := workflow.Actor{UserID: user, Name: "Test", Role: workflow.RoleAdmin, Via: workflow.ViaMCP}
	create := func(in CreateInput) *Ticket {
		t.Helper()
		if in.Title == "" {
			in.Title = "Test task"
		}
		tk, err := svc.Create(ctx, actor, in)
		if err != nil {
			t.Fatal(err)
		}
		return tk
	}
	assertConflict := func(err error) {
		t.Helper()
		e, ok := apperr.As(err)
		if !ok || e.Code != "duplicate_source_url" || e.Status != 409 || e.Details["ticket"] == nil {
			t.Fatalf("expected detailed duplicate conflict, got %v", err)
		}
	}

	t.Run("upgrade preserves legacy duplicates", func(t *testing.T) {
		var n int
		if err := pool.QueryRow(ctx, `SELECT references_count FROM ticket_source_claims WHERE source_key='https://example.org/legacy'`).Scan(&n); err != nil || n != 2 {
			t.Fatalf("count %d: %v", n, err)
		}
		_, err := svc.Create(ctx, actor, CreateInput{Title: "Duplicate", SourceURL: "example.org/legacy"})
		assertConflict(err)
		if _, err := pool.Exec(ctx, `UPDATE tickets SET title='Edited', source_url=source_url WHERE number='LEGACY-0'`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE tickets SET deleted_at=now() WHERE number='LEGACY-0'`); err != nil {
			t.Fatal(err)
		}
		_, err = svc.Create(ctx, actor, CreateInput{Title: "Still duplicate", SourceURL: "example.org/legacy"})
		assertConflict(err)
		if _, err := pool.Exec(ctx, `UPDATE tickets SET source_url='' WHERE number='LEGACY-1'`); err != nil {
			t.Fatal(err)
		}
		create(CreateInput{SourceURL: "example.org/legacy"})
	})

	t.Run("canonical URL preserves task identity", func(t *testing.T) {
		for _, tc := range []struct{ input, expected string }{
			{" EXAMPLE.org:443 ", "https://example.org/"}, {"HTTP://Example.org:80?task=1", "http://example.org/?task=1"},
			{"https://example.org/Task/7?x=1#reply", "https://example.org/Task/7?x=1#reply"},
		} {
			var key string
			if err := pool.QueryRow(ctx, `SELECT ticket_source_key($1)`, tc.input).Scan(&key); err != nil || key != tc.expected {
				t.Fatalf("%q -> %q, %v", tc.input, key, err)
			}
		}
		create(CreateInput{SourceURL: "https://example.org/Task?x=1"})
		create(CreateInput{SourceURL: "https://example.org/Task?x=2"})
		create(CreateInput{SourceURL: "https://example.org/task?x=1"})
	})

	t.Run("create edit filter export data and audit", func(t *testing.T) {
		tk := create(CreateInput{SourceURL: "https://example.org/shortlist", Deadline: ptr("2026-10-25"), Shortlist: Shortlist{FitScore: ptr(5), Complexity: ptr(2), Market: "KZ 50%", ApplicationsCount: ptr(0), BudgetAmount: ptr("9007199254740992.01"), Currency: "usd", Customer: "Client"}})
		if tk.BudgetAmount == nil || *tk.BudgetAmount != "9007199254740992.01" || tk.Currency != "USD" {
			t.Fatalf("precision lost: %+v", tk.Shortlist)
		}
		create(CreateInput{Shortlist: Shortlist{FitScore: ptr(5), Currency: "USD"}}) // unknown count excluded
		create(CreateInput{Shortlist: Shortlist{FitScore: ptr(5), ApplicationsCount: ptr(0), BudgetAmount: ptr("10"), Currency: "KZT"}})
		f := ListFilter{ShortlistFilter: ShortlistFilter{FitMin: ptr(4), ApplicationsMax: ptr(3), Currency: "USD", Market: "50%", Customer: "client", BudgetMin: ptr("9007199254740992.01")}, Sort: "budget_amount", Order: "asc"}
		items, total, err := svc.List(ctx, f)
		if err != nil || total != 1 || len(items) != 1 || items[0].ID != tk.ID {
			t.Fatalf("filter: %d %+v %v", total, items, err)
		}
		found, err := svc.FindSource(ctx, "https://EXAMPLE.org:443/shortlist", "")
		if err != nil || found == nil || found.ID != tk.ID {
			t.Fatalf("source lookup: %+v %v", found, err)
		}
		items, total, err = svc.List(ctx, ListFilter{ShortlistFilter: ShortlistFilter{SourceURL: "example.org/shortlist"}})
		if err != nil || total != 1 || items[0].ID != tk.ID {
			t.Fatalf("sync lookup: %d %v", total, err)
		}
		if same, err := svc.FindSource(ctx, tk.SourceURL, tk.ID); err != nil || same != nil {
			t.Fatalf("self excluded: %+v %v", same, err)
		}
		var patch UpdateInput
		if err := json.Unmarshal([]byte(`{"fit_score":null,"applications_count":3,"customer":"Updated"}`), &patch); err != nil {
			t.Fatal(err)
		}
		tk, err = svc.Update(ctx, actor, tk.ID, patch)
		if err != nil || tk.FitScore != nil || *tk.Complexity != 2 || *tk.ApplicationsCount != 3 || *tk.BudgetAmount != "9007199254740992.01" {
			t.Fatalf("patch: %+v %v", tk, err)
		}
		var auditCount int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE entity_id=$1 AND action='ticket.update' AND details->'changes' ? 'fit_score'`, tk.ID).Scan(&auditCount); err != nil || auditCount != 1 {
			t.Fatalf("audit: %d %v", auditCount, err)
		}
	})

	t.Run("concurrent service and direct writes", func(t *testing.T) {
		var success, conflicts atomic.Int32
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := svc.Create(ctx, actor, CreateInput{Title: "Concurrent", SourceURL: "https://example.org/race"})
				if err == nil {
					success.Add(1)
				} else if e, ok := apperr.As(err); ok && e.Code == "duplicate_source_url" {
					conflicts.Add(1)
				} else {
					t.Errorf("create: %v", err)
				}
			}()
		}
		wg.Wait()
		if success.Load() != 1 || conflicts.Load() != 7 {
			t.Fatalf("success=%d conflicts=%d", success.Load(), conflicts.Load())
		}
		success.Store(0)
		conflicts.Store(0)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				_, err := pool.Exec(ctx, `INSERT INTO tickets(number,title,source_url,created_by) VALUES($1,'Raw race','https://example.org/raw-race',$2)`, fmt.Sprintf("RAW-%d", i), user)
				if err == nil {
					success.Add(1)
				} else if e, ok := apperr.As(svc.sourceConflict(ctx, "https://example.org/raw-race", err)); ok && e.Code == "duplicate_source_url" {
					conflicts.Add(1)
				} else {
					t.Errorf("raw create: %v", err)
				}
			}(i)
		}
		wg.Wait()
		if success.Load() != 1 || conflicts.Load() != 7 {
			t.Fatalf("raw success=%d conflicts=%d", success.Load(), conflicts.Load())
		}
	})

	t.Run("sorting ranges week boundaries board and permissions", func(t *testing.T) {
		low := create(CreateInput{Deadline: ptr("2026-10-19 00:00"), Shortlist: Shortlist{Market: "sort-fixture", FitScore: ptr(1), Complexity: ptr(2), ApplicationsCount: ptr(10), BudgetAmount: ptr("2"), Currency: "USD", Customer: "B"}})
		high := create(CreateInput{Deadline: ptr("2026-10-25 23:59"), Shortlist: Shortlist{Market: "sort-fixture", FitScore: ptr(5), Complexity: ptr(5), ApplicationsCount: ptr(2), BudgetAmount: ptr("10"), Currency: "USD", Customer: "A"}})
		unknown := create(CreateInput{Deadline: ptr("2026-10-26 00:00"), Shortlist: Shortlist{Market: "sort-fixture", Currency: "USD", Customer: "C"}})
		for _, tc := range []struct {
			sort, order string
			ids         []string
		}{
			{"fit_score", "asc", []string{low.ID, high.ID, unknown.ID}}, {"fit_score", "desc", []string{high.ID, low.ID, unknown.ID}},
			{"complexity", "asc", []string{low.ID, high.ID, unknown.ID}}, {"applications_count", "asc", []string{high.ID, low.ID, unknown.ID}},
			{"budget_amount", "asc", []string{low.ID, high.ID, unknown.ID}}, {"budget_amount", "desc", []string{high.ID, low.ID, unknown.ID}},
			{"customer", "asc", []string{high.ID, low.ID, unknown.ID}},
		} {
			items, total, err := svc.List(ctx, ListFilter{ShortlistFilter: ShortlistFilter{Market: "sort-fixture", Currency: "USD"}, Sort: tc.sort, Order: tc.order})
			if err != nil || total != 3 {
				t.Fatalf("sort %s: %d %v", tc.sort, total, err)
			}
			for i, id := range tc.ids {
				if items[i].ID != id {
					t.Fatalf("sort %s %s: unexpected row %d", tc.sort, tc.order, i)
				}
			}
		}
		from, err := ParseDateBound("2026-10-19", svc.loc, false)
		if err != nil {
			t.Fatal(err)
		}
		to, err := ParseDateBound("2026-10-25", svc.loc, true)
		if err != nil {
			t.Fatal(err)
		}
		f := ListFilter{ShortlistFilter: ShortlistFilter{Market: "SORT-Fixture"}, DeadlineFrom: from, DeadlineTo: to}
		_, total, err := svc.List(ctx, f)
		if err != nil || total != 2 {
			t.Fatalf("week boundary: %d %v", total, err)
		}
		f.FitMin = ptr(4)
		f.FitMax = ptr(5)
		f.ComplexityMin = ptr(3)
		f.ComplexityMax = ptr(5)
		f.ApplicationsMin = ptr(0)
		f.ApplicationsMax = ptr(3)
		items, total, err := svc.List(ctx, f)
		if err != nil || total != 1 || items[0].ID != high.ID {
			t.Fatalf("combined range: %d %v", total, err)
		}
		cols, err := svc.Board(ctx, f)
		if err != nil || cols[0].Total != 1 || cols[0].Items[0].ID != high.ID {
			t.Fatalf("board: %+v %v", cols, err)
		}
		analyst := actor
		analyst.Role = workflow.RoleAnalyst
		_, err = svc.Update(ctx, analyst, low.ID, UpdateInput{ShortlistPatch: ShortlistPatch{FitScore: Optional[int]{Set: true, Value: ptr(5)}}})
		if e, ok := apperr.As(err); !ok || e.Status != 403 {
			t.Fatalf("analyst could edit shortlist: %v", err)
		}
	})

	t.Run("concurrent updates claim one new source", func(t *testing.T) {
		var ids []string
		for i := 0; i < 4; i++ {
			ids = append(ids, create(CreateInput{}).ID)
		}
		var success, conflicts atomic.Int32
		var wg sync.WaitGroup
		for _, id := range ids {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				_, err := svc.Update(ctx, actor, id, UpdateInput{SourceURL: ptr("https://example.org/update-race")})
				if err == nil {
					success.Add(1)
				} else if e, ok := apperr.As(err); ok && e.Code == "duplicate_source_url" {
					conflicts.Add(1)
				} else {
					t.Errorf("update race: %v", err)
				}
			}(id)
		}
		wg.Wait()
		if success.Load() != 1 || conflicts.Load() != 3 {
			t.Fatalf("update success=%d conflicts=%d", success.Load(), conflicts.Load())
		}
	})

	t.Run("conflicting update rolls back and deletion releases", func(t *testing.T) {
		a := create(CreateInput{SourceURL: "https://example.org/a"})
		b := create(CreateInput{SourceURL: "https://example.org/b"})
		_, err := svc.Update(ctx, actor, b.ID, UpdateInput{Title: ptr("Must roll back"), SourceURL: &a.SourceURL})
		assertConflict(err)
		current, err := svc.Get(ctx, b.ID)
		if err != nil || current.Title == "Must roll back" || current.SourceURL != b.SourceURL {
			t.Fatalf("rollback: %+v %v", current, err)
		}
		_, err = svc.Create(ctx, actor, CreateInput{Title: "Original still reserved", SourceURL: b.SourceURL})
		assertConflict(err)
		if err := svc.Delete(ctx, actor, a.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Update(ctx, actor, b.ID, UpdateInput{SourceURL: &a.SourceURL}); err != nil {
			t.Fatal(err)
		}
		create(CreateInput{SourceURL: b.SourceURL})
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET source_url='https://example.org/rolled-back' WHERE id=$1`, b.ID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		create(CreateInput{SourceURL: "https://example.org/rolled-back"})
	})

	t.Run("sent is not overdue and loss reason persists", func(t *testing.T) {
		tk := create(CreateInput{Deadline: ptr("2020-01-01"), SourceURL: "https://example.org/status"})
		f := ListFilter{ShortlistFilter: ShortlistFilter{SourceURL: tk.SourceURL}, Overdue: true}
		_, total, err := svc.List(ctx, f)
		if err != nil || total != 1 {
			t.Fatalf("new overdue: %d %v", total, err)
		}
		if _, err := svc.ChangeStatus(ctx, actor, tk.ID, workflow.StatusSent, "", "", ""); err != nil {
			t.Fatal(err)
		}
		_, total, err = svc.List(ctx, f)
		if err != nil || total != 0 {
			t.Fatalf("sent overdue: %d %v", total, err)
		}
		o, err := svc.Overview(ctx, user, false)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range o.Overdue {
			if item.ID == tk.ID {
				t.Fatal("sent in overview overdue")
			}
		}
		if _, err := svc.ChangeStatus(ctx, actor, tk.ID, workflow.StatusClosed, "", workflow.ResultLost, ""); err == nil {
			t.Fatal("lost without reason accepted")
		}
		tk, err = svc.Get(ctx, tk.ID)
		if err != nil || tk.Status != workflow.StatusSent {
			t.Fatalf("failed close changed status: %+v %v", tk, err)
		}
		tk, err = svc.ChangeStatus(ctx, actor, tk.ID, workflow.StatusClosed, "Customer confirmed price", workflow.ResultLost, "price")
		if err != nil || tk.LossReason != "price" {
			t.Fatalf("close: %+v %v", tk, err)
		}
		history, err := svc.StatusHistory(ctx, tk.ID)
		if err != nil || history[len(history)-1].LossReason != "price" || history[len(history)-1].Via != "mcp" {
			t.Fatalf("history: %+v %v", history, err)
		}
		o, err = svc.Overview(ctx, user, false)
		if err != nil || o.LostByReason["price"] != 1 || o.LostByReason["unknown"] != 1 {
			t.Fatalf("loss counts: %+v %v", o, err)
		}
		_, total, err = svc.List(ctx, ListFilter{ShortlistFilter: ShortlistFilter{LossReason: "price"}})
		if err != nil || total != 1 {
			t.Fatalf("reason filter: %d %v", total, err)
		}
		tk, err = svc.ChangeStatus(ctx, actor, tk.ID, workflow.StatusAnalysis, "Reopened for review", "", "")
		if err != nil || tk.LossReason != "" {
			t.Fatalf("reopen: %+v %v", tk, err)
		}
		_, total, err = svc.List(ctx, f)
		if err != nil || total != 1 {
			t.Fatalf("reopened overdue: %d %v", total, err)
		}
	})

	t.Run("migration rollback and reapply", func(t *testing.T) {
		if _, err := provider.DownTo(ctx, 1); err != nil {
			t.Fatal(err)
		}
		if _, err := provider.Up(ctx); err != nil {
			t.Fatal(err)
		}
	})
}
