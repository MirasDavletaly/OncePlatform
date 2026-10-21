// Package seed fills an empty database with demo tasks, comments and
// solution versions (SEED_DEMO=true), so the interface can be explored right
// after installation. It uses the team accounts created from INITIAL_USERS.
package seed

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/files"
	"onceplatform/internal/tickets"
	"onceplatform/internal/workflow"
)

// Services used by the seeder.
type Services struct {
	Pool    *pgxpool.Pool
	Log     *slog.Logger
	Loc     *time.Location
	Tickets *tickets.Service
	Files   *files.Service
}

type comment struct {
	by   workflow.Actor
	body string
}

type step struct {
	to      workflow.Status
	by      workflow.Actor
	comment string
	result  workflow.CloseResult
}

type demoTicket struct {
	in        tickets.CreateInput
	steps     []step
	comments  []comment
	solutions []string
	tzFile    string
}

// Demo seeds demo tasks unless tasks already exist.
func Demo(ctx context.Context, s Services) error {
	var n int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM tickets`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		s.Log.Info("demo seed skipped: tasks already exist")
		return nil
	}

	// One actor per role, taken from the existing team accounts.
	actors := map[workflow.Role]workflow.Actor{}
	rows, err := s.Pool.Query(ctx, `SELECT id, full_name, role FROM users WHERE is_active ORDER BY created_at`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var a workflow.Actor
		if err := rows.Scan(&a.UserID, &a.Name, &a.Role); err != nil {
			rows.Close()
			return err
		}
		if _, ok := actors[a.Role]; !ok {
			a.Via, a.IP = workflow.ViaSystem, "seed"
			actors[a.Role] = a
		}
	}
	rows.Close()
	admin, ok := actors[workflow.RoleAdmin]
	if !ok {
		s.Log.Warn("demo seed skipped: no active admin user")
		return nil
	}
	coord, ok := actors[workflow.RoleCoordinator]
	if !ok {
		coord = admin
	}
	analyst, ok := actors[workflow.RoleAnalyst]
	if !ok {
		analyst = admin
	}

	now := time.Now().In(s.Loc)
	deadline := func(days, hour int) *string {
		d := now.AddDate(0, 0, days)
		v := time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, s.Loc).Format("2006-01-02 15:04")
		return &v
	}
	user := func(a workflow.Actor) *string { id := a.UserID; return &id }

	toSolution := []step{{workflow.StatusAnalysis, coord, "", ""}, {workflow.StatusSolution, analyst, "", ""}}
	toSent := append(append([]step{}, toSolution...), step{workflow.StatusSent, analyst, "", ""})

	list := []demoTicket{
		{in: tickets.CreateInput{Title: "AI chatbot for citizen requests (Kazakh and Russian)",
			Description: "Public tender for an AI chatbot that answers citizen requests in Kazakh and Russian.\n\n**Scope:** eOtinish integration, knowledge base, operator panel.\n\n**Delivery:** 120 calendar days.",
			SourceURL:   "https://goszakup.gov.kz/ru/announce/index/15784512", Deadline: deadline(2, 10),
			Priority: "urgent", AssigneeID: user(analyst)},
			steps: toSolution,
			comments: []comment{
				{coord, "I uploaded the technical specification. @Miras please check the experience requirements — do we need acts for similar projects?"},
				{analyst, "Checked: they want 2 similar contracts from the last 5 years. Our Steppe Analytics project qualifies. Working on the solution."},
			},
			solutions: []string{
				"# Technical solution\n\n## Architecture\n- LLM with RAG over the akimat knowledge base\n- Channels: web widget, Telegram",
				"# Technical solution\n\n## Architecture\n- LLM with RAG over the akimat knowledge base (Kazakh and Russian)\n- Channels: web widget, Telegram, WhatsApp\n- Operator panel with hand-over to a human\n\n## Timeline\n1. Analysis — 20 days\n2. Development — 70 days\n3. Pilot operation — 30 days\n\n## Team\nPM, 2 backend, 1 frontend, ML engineer, analyst.",
			},
			tzFile: "# Technical specification\n\n1. The chatbot must support Kazakh and Russian.\n2. Response time — at most 5 seconds.\n3. Integration with eOtinish via API.\n4. Data must be stored in Kazakhstan.\n5. Warranty period — 12 months.\n",
		},
		{in: tickets.CreateInput{Title: "Tech Garden: electricity consumption forecasting",
			Description: "Astana Hub technology task from an energy company: hourly consumption forecast per substation with MAPE < 5%.",
			SourceURL:   "https://astanahub.com", Deadline: deadline(6, 18), Priority: "high"},
			steps:    []step{{workflow.StatusAnalysis, coord, "", ""}},
			comments: []comment{{admin, "Interesting one, high priority. Everyone — please estimate the effort by Friday."}},
		},
		{in: tickets.CreateInput{Title: "Supply and installation of metering system for 12 substations",
			Description: "Samruk-Kazyna procurement: equipment and software for an automated electricity metering system.",
			Deadline:    deadline(-2, 12), Priority: "high", AssigneeID: user(coord)},
			comments: []comment{{coord, "The deadline has passed — we could not form a consortium in time. I suggest closing it as \"no bid\"."}},
		},
		{in: tickets.CreateInput{Title: "Information security audit of a medical information system",
			Description: "The client asks for a commercial proposal: security audit and preparation for a personal data compliance check.",
			Deadline:    deadline(10, 18), Priority: "normal", AssigneeID: user(analyst)},
			steps:     toSent,
			solutions: []string{"# Security audit proposal\n\n- Architecture review\n- External penetration test\n- Report and remediation plan\n\nDuration — 4 weeks."},
		},
		{in: tickets.CreateInput{Title: "Electronic document management system rollout",
			Description: "Price offers for a document management system for 150 users.",
			SourceURL:   "https://goszakup.gov.kz/ru/announce/index/15601234", Deadline: deadline(-20, 10),
			Priority: "normal", AssigneeID: user(analyst)},
			steps:    append(append([]step{}, toSent...), step{workflow.StatusClosed, admin, "", workflow.ResultWon}),
			comments: []comment{{admin, "We won! The contract is being signed. Thank you, team."}},
		},
		{in: tickets.CreateInput{Title: "Server infrastructure upgrade",
			Description: "Supply of server hardware and virtualization.", Deadline: deadline(-35, 10), Priority: "low"},
			steps:    append(append([]step{}, toSent...), step{workflow.StatusClosed, admin, "", workflow.ResultLost}),
			comments: []comment{{analyst, "Lost on price: the winner went 18% lower."}},
		},
		{in: tickets.CreateInput{Title: "Computer vision for PPE control at a plant",
			Description: "Detect helmets and vests on video streams for an industrial customer.",
			Deadline:    deadline(14, 18), Priority: "normal"},
		},
		{in: tickets.CreateInput{Title: "Sales dashboard in Power BI for a distributor",
			Description: "Request via WhatsApp: a sales dashboard fed from 1C.",
			Deadline:    deadline(1, 15), Priority: "high", AssigneeID: user(analyst)},
			steps: toSolution,
		},
		{in: tickets.CreateInput{Title: "Commercial proposal template 2026",
			Description: "Update the proposal template: new company details, case studies, an AI section.",
			Priority:    "low", AssigneeID: user(coord)},
			steps: []step{{workflow.StatusAnalysis, coord, "", ""}},
		},
		{in: tickets.CreateInput{Title: "Mobile app for doctor appointments",
			Description: "iOS/Android app integrated with the clinic information system.",
			Deadline:    deadline(4, 18), Priority: "normal", AssigneeID: user(analyst)},
			steps: []step{{workflow.StatusAnalysis, coord, "", ""}, {workflow.StatusSolution, analyst, "", ""},
				{workflow.StatusAnalysis, analyst, "The customer sent a new version of the specification; the integration requirements need re-checking.", ""}},
		},
		{in: tickets.CreateInput{Title: "Open data portal development",
			Description: "The tender was cancelled by the customer after the clarifications were published.",
			Deadline:    deadline(-10, 10), Priority: "normal"},
			steps: []step{{workflow.StatusAnalysis, coord, "", ""}, {workflow.StatusClosed, admin, "", workflow.ResultCancelled}},
		},
		{in: tickets.CreateInput{Title: "Consultation on the Astana Hub acceleration program",
			Description: "A client wants to understand the Tech Garden participation requirements.",
			Deadline:    deadline(21, 18), Priority: "low", AssigneeID: user(admin)},
		},
	}

	for i, dt := range list {
		t, err := s.Tickets.Create(ctx, coord, dt.in)
		if err != nil {
			return fmt.Errorf("demo task %d: %w", i, err)
		}
		if dt.tzFile != "" && s.Files != nil {
			if _, err := s.Files.Upload(ctx, coord, files.UploadInput{Target: files.Target{TicketID: t.ID},
				Name: "Technical specification.md", Category: "tz", Body: strings.NewReader(dt.tzFile)}); err != nil {
				return fmt.Errorf("demo attachment: %w", err)
			}
		}
		for _, st := range dt.steps {
			if _, err := s.Tickets.ChangeStatus(ctx, st.by, t.ID, st.to, st.comment, st.result); err != nil {
				return fmt.Errorf("demo status %s→%s: %w", t.Number, st.to, err)
			}
		}
		for _, sol := range dt.solutions {
			if _, err := s.Tickets.SaveSolution(ctx, analyst, t.ID, sol); err != nil {
				return fmt.Errorf("demo solution: %w", err)
			}
		}
		for _, cm := range dt.comments {
			if _, err := s.Tickets.AddComment(ctx, cm.by, t.ID, cm.body); err != nil {
				return fmt.Errorf("demo comment: %w", err)
			}
		}
	}
	s.Log.Info("demo data created", "tasks", len(list))
	return nil
}
