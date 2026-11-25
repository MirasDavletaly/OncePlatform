package cv

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// Professions of the engine taxonomy (cvengine/gen.js PROFS; a test keeps
// both lists equal).
var Professions = []string{"python", "java", "frontend", "qa_auto", "qa_manual", "devops", "analyst", "ba", "support",
	"mobile", "ml", "pm", "dba", "backend"}

// Languages and Levels the engine recognises in CVs.
var (
	Languages = []string{"kk", "ru", "en", "de", "tr", "ko", "uz", "zh", "fr"}
	Levels    = []string{"A1", "A2", "B1", "B2", "C1", "C2", "fluent", "native"}
)

// LangReq is a required language with an optional minimum level.
type LangReq struct {
	Language string `json:"language" jsonschema:"Language code: kk, ru, en, de, tr, ko, uz, zh or fr"`
	Level    string `json:"level,omitempty" jsonschema:"Minimum level: A1, A2, B1, B2, C1, C2, fluent or native; empty = any"`
}

// Role is one key-personnel position a tender asks for.
type Role struct {
	Title        string    `json:"title" jsonschema:"Role as named in the specification, e.g. Project manager"`
	Profession   string    `json:"profession,omitempty" jsonschema:"Closest profession of the taxonomy (experience in it counts in full); empty when none fits"`
	Count        int       `json:"count,omitempty" jsonschema:"How many people the role needs (default 1)"`
	MinYears     float64   `json:"min_years,omitempty" jsonschema:"Minimum years of experience in the profession (or in total when no profession is set)"`
	SkillsMust   []string  `json:"skills_must,omitempty" jsonschema:"Required skills and technologies"`
	SkillsNice   []string  `json:"skills_nice,omitempty" jsonschema:"Desirable skills"`
	Certificates []string  `json:"certificates,omitempty" jsonschema:"Required certificates, e.g. PMP, ITIL 4 Foundation, CCNA"`
	Languages    []LangReq `json:"languages,omitempty" jsonschema:"Required languages and levels"`
	Notes        string    `json:"notes,omitempty" jsonschema:"Other conditions to check by hand (education, project experience), quoted from the specification"`
}

func cleanList(list []string, field string, max int) ([]string, error) {
	out := []string{}
	for _, s := range list {
		s = strings.Join(strings.Fields(s), " ")
		if s == "" || slices.ContainsFunc(out, func(x string) bool { return strings.EqualFold(x, s) }) {
			continue
		}
		if utf8.RuneCountInString(s) > 150 {
			return nil, apperr.Validationf("%s: %q is too long (maximum 150 characters)", field, s)
		}
		out = append(out, s)
	}
	if len(out) > max {
		return nil, apperr.Validationf("%s: at most %d items", field, max)
	}
	return out, nil
}

// ValidateRoles normalises roles and rejects invalid ones.
func ValidateRoles(roles []Role) ([]Role, error) {
	if len(roles) > 30 {
		return nil, apperr.Validation("At most 30 roles per task")
	}
	out := make([]Role, 0, len(roles))
	for i, r := range roles {
		n := i + 1
		r.Title = strings.Join(strings.Fields(r.Title), " ")
		if r.Title == "" || utf8.RuneCountInString(r.Title) > 200 {
			return nil, apperr.Validationf("Role %d: the title is required (maximum 200 characters)", n)
		}
		if r.Profession != "" && !slices.Contains(Professions, r.Profession) {
			return nil, apperr.Validationf("Role %d: unknown profession %q (allowed: %s)", n, r.Profession, strings.Join(Professions, ", "))
		}
		if r.Count == 0 {
			r.Count = 1
		}
		if r.Count < 1 || r.Count > 100 {
			return nil, apperr.Validationf("Role %d: count must be between 1 and 100", n)
		}
		if r.MinYears < 0 || r.MinYears > 50 {
			return nil, apperr.Validationf("Role %d: min_years must be between 0 and 50", n)
		}
		var err error
		if r.SkillsMust, err = cleanList(r.SkillsMust, fmt.Sprintf("Role %d skills_must", n), 50); err != nil {
			return nil, err
		}
		if r.SkillsNice, err = cleanList(r.SkillsNice, fmt.Sprintf("Role %d skills_nice", n), 50); err != nil {
			return nil, err
		}
		if r.Certificates, err = cleanList(r.Certificates, fmt.Sprintf("Role %d certificates", n), 30); err != nil {
			return nil, err
		}
		langs := []LangReq{}
		for _, l := range r.Languages {
			l.Language, l.Level = strings.ToLower(strings.TrimSpace(l.Language)), strings.TrimSpace(l.Level)
			if strings.HasPrefix(l.Level, "a") || strings.HasPrefix(l.Level, "b") || strings.HasPrefix(l.Level, "c") {
				l.Level = strings.ToUpper(l.Level)
			}
			if !slices.Contains(Languages, l.Language) {
				return nil, apperr.Validationf("Role %d: unknown language %q (allowed: %s)", n, l.Language, strings.Join(Languages, ", "))
			}
			if l.Level != "" && !slices.Contains(Levels, l.Level) {
				return nil, apperr.Validationf("Role %d: unknown level %q (allowed: %s)", n, l.Level, strings.Join(Levels, ", "))
			}
			if !slices.ContainsFunc(langs, func(x LangReq) bool { return x.Language == l.Language }) {
				langs = append(langs, l)
			}
		}
		if len(langs) > 10 {
			return nil, apperr.Validationf("Role %d: at most 10 languages", n)
		}
		r.Languages = langs
		r.Notes = strings.TrimSpace(r.Notes)
		if utf8.RuneCountInString(r.Notes) > 2000 {
			return nil, apperr.Validationf("Role %d: notes are too long (maximum 2,000 characters)", n)
		}
		out = append(out, r)
	}
	return out, nil
}

// Requirements are the roles of a task.
type Requirements struct {
	Roles         []Role     `json:"roles"`
	UpdatedByName string     `json:"updated_by_name,omitempty"`
	Via           string     `json:"via,omitempty"`
	UpdatedAt     *time.Time `json:"updated_at"`
}

// GetRequirements returns the roles of a task (empty when none are set).
func (s *Service) GetRequirements(ctx context.Context, ticketID string) (*Requirements, error) {
	r := &Requirements{Roles: []Role{}}
	var raw []byte
	var at time.Time
	err := s.pool.QueryRow(ctx, `SELECT r.roles, u.full_name, r.via, r.updated_at FROM ticket_cv_requirements r
		JOIN users u ON u.id = r.updated_by WHERE r.ticket_id = $1`, ticketID).Scan(&raw, &r.UpdatedByName, &r.Via, &at)
	if db.IsNoRows(err) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	r.UpdatedAt = &at
	if err := json.Unmarshal(raw, &r.Roles); err != nil {
		return nil, err
	}
	return r, nil
}

// SetRequirements replaces the roles of a task.
func (s *Service) SetRequirements(ctx context.Context, actor workflow.Actor, ticketID, number string, roles []Role) (*Requirements, error) {
	if err := actor.Require(workflow.PermFilesComments); err != nil {
		return nil, err
	}
	roles, err := ValidateRoles(roles)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(roles)
	if err != nil {
		return nil, err
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ticket_cv_requirements (ticket_id, roles, updated_by, via) VALUES ($1, $2, $3, $4)
			ON CONFLICT (ticket_id) DO UPDATE SET roles = $2, updated_by = $3, via = $4, updated_at = now()`,
			ticketID, raw, actor.UserID, string(actor.Via)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET updated_at = now() WHERE id = $1`, ticketID); err != nil {
			return err
		}
		titles := make([]string, len(roles))
		for i, r := range roles {
			titles[i] = r.Title
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "ticket.cv_requirements", "ticket", ticketID,
			map[string]any{"ticket_id": ticketID, "number": number, "roles": titles}))
	})
	if err != nil {
		return nil, err
	}
	return s.GetRequirements(ctx, ticketID)
}

// MatchRow is one candidate scored against a role.
type MatchRow struct {
	CandidateID string             `json:"candidate_id"`
	Code        string             `json:"code"`
	Name        string             `json:"name,omitempty"`
	Label       string             `json:"label,omitempty"`
	Score       int                `json:"score"`
	Fails       []string           `json:"fails"`
	Parts       map[string]float64 `json:"parts"`
	Why         json.RawMessage    `json:"why"`
}

// RoleMatch is the ranking of all parsed candidates for a role: the ones
// meeting every hard requirement first, by score.
type RoleMatch struct {
	Role    Role       `json:"role"`
	Results []MatchRow `json:"results"`
}

// Match ranks the parsed candidates for every role of a task. Names are
// included only for viewers with cv.manage and never when anon is set (MCP).
func (s *Service) Match(ctx context.Context, actor workflow.Actor, ticketID string, anon bool) (*Requirements, []RoleMatch, int, error) {
	if err := actor.Require(workflow.PermCVView); err != nil {
		return nil, nil, 0, err
	}
	req, err := s.GetRequirements(ctx, ticketID)
	if err != nil {
		return nil, nil, 0, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id, number, full_name, profile FROM candidates WHERE status = 'ready' AND profile IS NOT NULL`)
	if err != nil {
		return nil, nil, 0, err
	}
	type info struct {
		code, name, label, anonLabel string
	}
	labelOf := func(raw []byte) string {
		var p struct {
			Basics struct {
				Label string `json:"label"`
			} `json:"basics"`
		}
		_ = json.Unmarshal(raw, &p)
		return p.Basics.Label
	}
	byID := map[string]info{}
	var cands []engineCandidate
	for rows.Next() {
		var id, name string
		var number int
		var profile []byte
		if err := rows.Scan(&id, &number, &name, &profile); err != nil {
			rows.Close()
			return nil, nil, 0, err
		}
		// the title as it may go out anonymised: a misread title line can be the name or the address
		anonymized := anonymizeProfile(profile, name)
		byID[id] = info{Code(number), name, labelOf(profile), labelOf(anonymized)}
		// scored on the anonymised profile: requirements are free text, and matching them against the real texts
		// would tell which code has a given name or phone
		cands = append(cands, engineCandidate{ID: id, Profile: anonymized})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, 0, err
	}
	out := make([]RoleMatch, len(req.Roles))
	for i, r := range req.Roles {
		out[i] = RoleMatch{Role: r, Results: []MatchRow{}}
	}
	if len(req.Roles) == 0 || len(cands) == 0 {
		return req, out, len(cands), nil
	}
	res, err := s.engine.Match(ctx, req.Roles, cands)
	if err != nil {
		return nil, nil, 0, err
	}
	showNames := !anon && actor.Can(workflow.PermCVManage)
	for i := range out {
		if i >= len(res) {
			break
		}
		for _, r := range res[i] {
			c := byID[r.ID]
			row := MatchRow{CandidateID: r.ID, Code: c.code, Label: c.anonLabel, Score: r.Score, Fails: r.Fails, Parts: r.Parts, Why: r.Why}
			if showNames {
				row.Name, row.Label = c.name, c.label
			}
			if row.Fails == nil {
				row.Fails = []string{}
			}
			out[i].Results = append(out[i].Results, row)
		}
	}
	return req, out, len(cands), nil
}
