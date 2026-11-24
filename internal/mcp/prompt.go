package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"onceplatform/internal/files"
)

func (s *server) registerPrompts(srv *sdk.Server) {
	srv.AddPrompt(&sdk.Prompt{
		Name:        "analyze_tender",
		Title:       "Tender analysis",
		Description: "Read the task card and its technical specification files and prepare a structured tender analysis: requirements, risks, timeline, required resources, questions to the customer and a bid / no-bid recommendation.",
		Arguments: []*sdk.PromptArgument{{
			Name:        "ticket_id",
			Title:       "Task",
			Description: "Task UUID or number like T-2026-0001",
			Required:    true,
		}},
	}, s.analyzeTender)
	srv.AddPrompt(&sdk.Prompt{
		Name:        "translate_cvs",
		Title:       "Translate CVs",
		Description: "Translate the CV database into English and Russian so that the portal shows every CV in the language of its interface: all CVs whose translation is missing or outdated, or one CV.",
		Arguments: []*sdk.PromptArgument{{
			Name:        "candidate",
			Title:       "Candidate",
			Description: "One candidate code like CV-0007; empty for every CV that needs it",
		}},
	}, s.translateCVs)
}

func (s *server) translateCVs(ctx context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
	if _, _, err := caller(req.Extra); err != nil {
		return nil, err
	}
	which := "Call list_candidates with needs_translation=true and work through every CV it returns."
	if c := strings.TrimSpace(req.Params.Arguments["candidate"]); c != "" {
		which = fmt.Sprintf("Translate candidate %s.", c)
	}
	text := which + `

For each CV:
1. Call get_candidate: it returns the CV's texts under keys (basics.label, work.0.position, work.0.summary, projects.0.name, education.0.area, skills.3.name ...) and cv_language.
2. Translate every text into English and, separately, into Russian (a CV in Kazakh needs both; a text already in the target language is copied as it is).
3. Call save_candidate_translation twice, language "en" and language "ru", with all texts under exactly the same keys.

How to translate:
- Keep the meaning and the facts; do not add, drop or embellish anything.
- Proper names of companies, products and projects keep their name; translate only the legal form and generic words: ТОО → LLP / ТОО, АО → JSC / АО; university names in their established form (Евразийский национальный университет имени Л.Н. Гумилева → L.N. Gumilyov Eurasian National University).
- Technologies, standards and certificate names stay as they are (Jira, Scrum, PMP, ITIL 4 Foundation).
- Job titles in the usual form of the target language (Руководитель проектов → Project Manager).
- Texts are anonymised: names and contacts are masked as [name], [e-mail] and [phone]; keep these placeholders exactly as they are.

Finish with a short report: how many CVs were translated and any texts you were unsure about.`
	return &sdk.GetPromptResult{
		Description: "Translate CVs into English and Russian",
		Messages:    []*sdk.PromptMessage{{Role: "user", Content: &sdk.TextContent{Text: text}}},
	}, nil
}

func (s *server) analyzeTender(ctx context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
	if _, _, err := caller(req.Extra); err != nil {
		return nil, err
	}
	ref := strings.TrimSpace(req.Params.Arguments["ticket_id"])
	if ref == "" {
		return nil, fmt.Errorf("argument ticket_id is required")
	}
	t, err := s.Tickets.Get(ctx, ref)
	if err != nil {
		return nil, s.toolError("analyze_tender", err)
	}
	atts, err := s.Files.List(ctx, files.Target{TicketID: t.ID})
	if err != nil {
		return nil, s.toolError("analyze_tender", err)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Prepare a structured tender analysis for task %s \"%s\" on the OncePlatform portal.\n\n", t.Number, t.Title)
	b.WriteString("## What the task card says\n")
	fmt.Fprintf(&b, "- Status: %s; priority: %s\n", t.Status, t.Priority)
	if t.AssigneeName != nil {
		fmt.Fprintf(&b, "- Assignee: %s\n", *t.AssigneeName)
	} else {
		b.WriteString("- Assignee: everyone (whole team)\n")
	}
	if d := s.fmtTime(t.Deadline); d != nil {
		fmt.Fprintf(&b, "- Submission deadline: %s\n", *d)
	}
	if t.SourceURL != "" {
		fmt.Fprintf(&b, "- Source: %s\n", t.SourceURL)
	}
	shortlist, _ := json.Marshal(t.Shortlist)
	fmt.Fprintf(&b, "- Structured shortlist (null means unknown): %s\n", shortlist)
	if t.LossReason != "" {
		fmt.Fprintf(&b, "- Recorded loss reason: %s\n", t.LossReason)
	}
	if desc := strings.TrimSpace(t.Description); desc != "" {
		fmt.Fprintf(&b, "\n### Description\n%s\n", truncateRunes(desc, 6000))
	}

	b.WriteString("\n## Files\n")
	var tz, other []files.Attachment
	for _, a := range atts {
		if a.Category == "tz" {
			tz = append(tz, a)
		} else {
			other = append(other, a)
		}
	}
	if len(tz) == 0 {
		b.WriteString("No files with the \"technical specification\" (tz) category. Check the other files: the specification may have been uploaded with another category.\n")
	}
	for _, a := range tz {
		fmt.Fprintf(&b, "- Specification: %s — attachment_id %s, extracted characters: %d (status: %s)\n", a.OriginalName, a.ID, a.TextLength, a.ExtractionStatus)
	}
	for _, a := range other {
		fmt.Fprintf(&b, "- %s (%s) — attachment_id %s, characters: %d\n", a.OriginalName, a.Category, a.ID, a.TextLength)
	}

	fmt.Fprintf(&b, `
## How to work
1. Call get_ticket with ticket_id=%q to see the technical solution, comments and history.
2. Read every technical specification file completely with read_attachment (in chunks, passing next_offset until it is null). Look at the other files if needed.
3. If useful, find similar tasks with search.

## Answer structure (Markdown, in the language the user writes in; English by default)
1. **Summary** — what is being procured, in 3–5 sentences.
2. **Requirements** — functional, technical, qualification (experience, licences, certificates, staff), and documents required for the bid. Cite the section or clause of the specification for each requirement.
3. **Risks** — technical, schedule, financial and legal (penalties, warranty obligations, bid and contract security); rate each as low, medium or high.
4. **Timeline** — submission deadline, delivery period, key milestones; is there enough time to prepare?
5. **Required resources** — team (roles and workload), subcontractors, equipment and licences, an estimated cost compared with the budget.
6. **Questions to the customer** — ambiguities and contradictions in the specification to clarify before submitting.
7. **Recommendation** — "bid" or "no bid", with reasons and the conditions under which the decision would change.

Do not invent facts: if the card or the files do not contain the information, say so explicitly. After answering, offer to save the analysis as a comment (add_comment) or as the technical solution (save_technical_solution) — save only after the user agrees.
`, t.Number)

	return &sdk.GetPromptResult{
		Description: fmt.Sprintf("Tender analysis %s \"%s\"", t.Number, t.Title),
		Messages: []*sdk.PromptMessage{{
			Role:    "user",
			Content: &sdk.TextContent{Text: b.String()},
		}},
	}, nil
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
