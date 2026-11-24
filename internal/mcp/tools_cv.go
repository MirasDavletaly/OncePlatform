package mcp

import (
	"context"
	"encoding/json"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"onceplatform/internal/cv"
)

type setCVRequirementsInput struct {
	TicketID string    `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Roles    []cv.Role `json:"roles" jsonschema:"All key-personnel roles the specification asks for; replaces the saved list (an empty list removes it)"`
}

type matchCandidatesInput struct {
	TicketID string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Limit    int    `json:"limit,omitempty" jsonschema:"Candidates per role, default 10, maximum 50"`
}

type listCandidatesInput struct {
	NeedsTranslation bool `json:"needs_translation,omitempty" jsonschema:"Only CVs whose English or Russian translation is missing or outdated"`
}

type getCandidateInput struct {
	Candidate string `json:"candidate" jsonschema:"Candidate code like CV-0007"`
}

type saveTranslationInput struct {
	Candidate string            `json:"candidate" jsonschema:"Candidate code like CV-0007"`
	Language  string            `json:"language" jsonschema:"Interface language of the translation"`
	Texts     map[string]string `json:"texts" jsonschema:"The translated texts under the same keys as get_candidate returned them (e.g. work.0.position)"`
}

// cvRolesSchema adds the enums of the nested role fields.
func cvRolesSchema() *jsonschema.Schema {
	sch := inputSchema[setCVRequirementsInput](nil)
	role := sch.Properties["roles"].Items
	enum := func(list []string) []any {
		out := make([]any, len(list))
		for i, v := range list {
			out[i] = v
		}
		return out
	}
	role.Properties["profession"].Enum = enum(cv.Professions)
	lang := role.Properties["languages"].Items
	lang.Properties["language"].Enum = enum(cv.Languages)
	lang.Properties["level"].Enum = enum(cv.Levels)
	return sch
}

func (s *server) registerCVTools(srv *sdk.Server) {
	sdk.AddTool(srv, &sdk.Tool{
		Name: "set_cv_requirements",
		Description: "Save the key-personnel requirements of a task (roles with profession, minimum years, required and desirable skills, " +
			"certificates and languages), taken from the technical specification. The portal ranks the team's CV database against them " +
			"on the task's Candidates tab. Replaces the saved roles.",
		InputSchema: cvRolesSchema(),
		Annotations: writeAnn("Set CV requirements", false, true),
	}, s.setCVRequirements)

	sdk.AddTool(srv, &sdk.Tool{
		Name: "match_candidates",
		Description: "Rank the CV database against the key-personnel requirements of a task: per role, candidates by score 0-100 with met " +
			"and missing skills, certificates, languages and experience, and failed hard requirements (exp, cert, lang). Candidates are " +
			"anonymised (code like CV-0007 and job title only): names and contacts never leave the portal.",
		InputSchema: inputSchema[matchCandidatesInput](nil),
		Annotations: readOnly("Match candidates"),
	}, s.matchCandidates)

	sdk.AddTool(srv, &sdk.Tool{
		Name: "list_candidates",
		Description: "List the CV database anonymised (code like CV-0007, job title, parsing status, language of the CV) with the state of " +
			"its English and Russian translations: ok, outdated (the profile changed after translating) or missing.",
		InputSchema: inputSchema[listCandidatesInput](nil),
		Annotations: readOnly("List candidates"),
	}, s.listCandidates)

	sdk.AddTool(srv, &sdk.Tool{
		Name: "get_candidate",
		Description: "The translatable texts of one CV, keyed by their place in the profile (basics.label, work.0.position, work.0.summary, " +
			"projects.0.name, education.0.area, skills.3.name ...), with the language of the CV and the state of its translations. " +
			"Anonymised: names and contacts are not among the texts.",
		InputSchema: inputSchema[getCandidateInput](nil),
		Annotations: readOnly("Get candidate texts"),
	}, s.getCandidate)

	sdk.AddTool(srv, &sdk.Tool{
		Name: "save_candidate_translation",
		Description: "Save the translation of a CV's texts into English or Russian; the portal shows it when its interface is in that " +
			"language and uses it in the Word export. Send every text under its key from get_candidate; a text left out stays in the " +
			"original language. Replaces the previous translation into that language.",
		InputSchema: inputSchema[saveTranslationInput](map[string][]string{"language": cv.TranslationLangs}),
		Annotations: writeAnn("Save CV translation", false, true),
	}, s.saveCandidateTranslation)
}

func cvLanguage(profile json.RawMessage) string {
	var p struct {
		Meta struct {
			Lang string `json:"lang"`
		} `json:"meta"`
	}
	_ = json.Unmarshal(profile, &p)
	return p.Meta.Lang
}

func jobTitle(profile json.RawMessage) string {
	var p struct {
		Basics struct {
			Label string `json:"label"`
		} `json:"basics"`
	}
	_ = json.Unmarshal(profile, &p)
	return p.Basics.Label
}

func (s *server) listCandidates(ctx context.Context, req *sdk.CallToolRequest, in listCandidatesInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	list, err := s.CV.List(ctx, actor)
	if err != nil {
		return nil, nil, s.toolError("list_candidates", err)
	}
	rows := []map[string]any{}
	for _, c := range list {
		pending := c.Status == "ready" && (c.TranslationStatus["en"] != "ok" || c.TranslationStatus["ru"] != "ok")
		if in.NeedsTranslation && !pending {
			continue
		}
		rows = append(rows, map[string]any{"code": c.Code, "job_title": jobTitle(c.Profile), "status": c.Status,
			"cv_language": cvLanguage(c.Profile), "translations": c.TranslationStatus})
	}
	return nil, map[string]any{"candidates": rows, "count": len(rows), "candidates_in_database": len(list)}, nil
}

func (s *server) getCandidate(ctx context.Context, req *sdk.CallToolRequest, in getCandidateInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	c, err := s.CV.GetByRef(ctx, actor, in.Candidate)
	if err != nil {
		return nil, nil, s.toolError("get_candidate", err)
	}
	return nil, map[string]any{"code": c.Code, "status": c.Status, "cv_language": cvLanguage(c.Profile),
		"translations": c.TranslationStatus, "texts": cv.ProfileTexts(c.Profile), "url": s.Cfg.BaseURL + "/cv/" + c.ID}, nil
}

func (s *server) saveCandidateTranslation(ctx context.Context, req *sdk.CallToolRequest, in saveTranslationInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	c, total, err := s.CV.SaveTranslation(ctx, actor, in.Candidate, in.Language, in.Texts)
	if err != nil {
		return nil, nil, s.toolError("save_candidate_translation", err)
	}
	saved := len(c.Translations[in.Language])
	return nil, map[string]any{"saved": true, "code": c.Code, "language": in.Language, "texts_translated": saved, "texts_total": total,
		"translations": c.TranslationStatus, "url": s.Cfg.BaseURL + "/cv/" + c.ID}, nil
}

func (s *server) setCVRequirements(ctx context.Context, req *sdk.CallToolRequest, in setCVRequirementsInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	t, err := s.Tickets.Get(ctx, in.TicketID)
	if err != nil {
		return nil, nil, s.toolError("set_cv_requirements", err)
	}
	if in.Roles == nil {
		in.Roles = []cv.Role{}
	}
	r, err := s.CV.SetRequirements(ctx, actor, t.ID, t.Number, in.Roles)
	if err != nil {
		return nil, nil, s.toolError("set_cv_requirements", err)
	}
	return nil, map[string]any{"saved": true, "ticket_number": t.Number, "roles": r.Roles,
		"url": s.ticketURL(t.Number) + "?tab=candidates"}, nil
}

func (s *server) matchCandidates(ctx context.Context, req *sdk.CallToolRequest, in matchCandidatesInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	t, err := s.Tickets.Get(ctx, in.TicketID)
	if err != nil {
		return nil, nil, s.toolError("match_candidates", err)
	}
	r, matches, total, err := s.CV.Match(ctx, actor, t.ID, true)
	if err != nil {
		return nil, nil, s.toolError("match_candidates", err)
	}
	roles := make([]map[string]any, 0, len(matches))
	for _, m := range matches {
		rows := make([]map[string]any, 0, limit)
		for i, row := range m.Results {
			if i >= limit {
				break
			}
			rows = append(rows, map[string]any{"code": row.Code, "job_title": row.Label, "score": row.Score,
				"hard_requirements_failed": row.Fails, "why": json.RawMessage(row.Why)})
		}
		roles = append(roles, map[string]any{"role": m.Role, "candidates_ranked": len(m.Results), "top": rows})
	}
	out := map[string]any{"ticket_number": t.Number, "candidates_in_database": total, "roles": roles,
		"url": s.ticketURL(t.Number) + "?tab=candidates"}
	if len(r.Roles) == 0 {
		out["note"] = "No key-personnel requirements are saved for this task; read the specification and call set_cv_requirements first."
	}
	return nil, out, nil
}
