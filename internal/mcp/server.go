// Package mcp exposes the portal to AI assistants (Claude) over the Model
// Context Protocol, using the official Go SDK with the Streamable HTTP
// transport. Every call runs on behalf of the user who owns the bearer token
// (OAuth access token or personal API token) with exactly the same
// permissions as in the web UI; all changes are audited with via = "mcp".
package mcp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"onceplatform/internal/apperr"
	"onceplatform/internal/auth"
	"onceplatform/internal/config"
	"onceplatform/internal/cv"
	"onceplatform/internal/files"
	"onceplatform/internal/oauth"
	"onceplatform/internal/search"
	"onceplatform/internal/tickets"
	"onceplatform/internal/workflow"
)

// Deps are the services the MCP tools use.
type Deps struct {
	Cfg     *config.Config
	Log     *slog.Logger
	Version string
	Auth    *auth.Service
	OAuth   *oauth.Server
	Tickets *tickets.Service
	Files   *files.Service
	CV      *cv.Service
	Search  *search.Service
}

type server struct {
	Deps
}

const instructions = `OncePlatform is the internal task portal of a small team (Alessio, Dinara, Miras) that handles public tenders in Kazakhstan, Astana Hub technology tasks and client requests.

Workflow statuses (strict order): new → analysis → solution → sent → closed. Closing requires a result (won, lost, cancelled, no_bid). Moving a task back requires a comment. Permissions depend on the user's role (admin, coordinator, analyst) and are enforced by the server exactly as in the web UI; a "forbidden" or "transition_forbidden" error means the current user's role does not allow the action.

A task has a title, priority, source link, deadline, an assignee (a specific person, or nobody = the whole team, shown as "Everyone"), an optional description, a technical solution, comments and files. Tasks can be referenced by UUID or by number like T-2026-0001. Times are returned in the portal time zone with an explicit offset. Write comments and documents in the language the user writes in (the team works mostly in English). Deleting is not possible through MCP.

Use structured shortlist fields (fit_score and complexity: integers 1 to 5; market; applications_count; budget_amount as a decimal string; currency; customer) instead of burying them in descriptions. Leave unknown values unset; zero applications means a confirmed zero. To clear a nullable field with update_ticket, use clear_fields. Before importing, list_tickets with source_url to find an existing task. A duplicate_source_url error identifies the existing task: read it and update only fields supported by new evidence; never retry with an altered URL to bypass deduplication.

Sent tasks have already been submitted and are never overdue. Closing as lost requires loss_reason: price, competitor, no_response or requirements. Determine it from the user's statement or explicit evidence in the task/comments/documents. If the reason is unknown or ambiguous, ask the user before closing; no_response is an actual lack of response, not a substitute for missing evidence. Preserve supporting evidence in the closure comment. get_overview returns lost_by_reason and list_tickets can filter by loss_reason.

Typical flow for a tender: get_ticket → list_attachments → read_attachment for the technical specification ("tz" category) → analyse → save_technical_solution and/or add_comment. Use the analyze_tender prompt for a structured tender analysis.

When the specification lists key personnel (roles with experience, skills, certificates, languages), save them with set_cv_requirements: one role per position, the closest profession of the taxonomy, min_years as stated, skills and certificates as short names, conditions that cannot be scored (education, project experience) in notes. match_candidates then ranks the team's CV database for each role. Candidates are personal data: the portal returns them anonymised (code like CV-0007) and their names, contacts and CV files are never available through MCP.

The portal shows every CV in the language of its interface (English or Russian) when Claude has translated it: when the user asks to translate CVs (or after CVs were uploaded or parsed again), use the translate_cvs prompt flow — list_candidates with needs_translation, get_candidate for the texts, save_candidate_translation for "en" and for "ru".`

// NewHandler builds the authenticated MCP HTTP handler for /mcp.
func NewHandler(d Deps) http.Handler {
	s := &server{Deps: d}
	srv := s.newSDKServer()
	h := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return srv }, &sdk.StreamableHTTPOptions{
		Stateless:                  true,
		JSONResponse:               true,
		Logger:                     d.Log.With("component", "mcp"),
		MaxRequestBodyBytes:        16 << 20,
		DisableLocalhostProtection: true, // every request is authenticated with a bearer token
	})
	return sdkauth.RequireBearerToken(s.verifyToken, &sdkauth.RequireBearerTokenOptions{
		ResourceMetadataURL: d.Cfg.ResourceMetadataURL(),
	})(h)
}

// newSDKServer creates the MCP server with all tools and prompts.
func (s *server) newSDKServer() *sdk.Server {
	srv := sdk.NewServer(&sdk.Implementation{
		Name:    "onceplatform",
		Title:   "OncePlatform — tasks and tenders portal",
		Version: s.Version,
	}, &sdk.ServerOptions{
		Instructions: instructions,
		Capabilities: &sdk.ServerCapabilities{},
	})
	s.registerTicketTools(srv)
	s.registerOtherTools(srv)
	s.registerCVTools(srv)
	s.registerPrompts(srv)
	return srv
}

// verifyToken accepts OAuth access tokens (issued for this MCP resource) and
// personal API tokens.
func (s *server) verifyToken(ctx context.Context, token string, r *http.Request) (*sdkauth.TokenInfo, error) {
	ip := auth.ClientIP(r)
	switch {
	case auth.HasPrefix(token, auth.PrefixAPIToken):
		u, tok, err := s.Auth.VerifyAPIToken(ctx, token)
		if err != nil {
			if _, ok := apperr.As(err); ok {
				return nil, fmt.Errorf("%w: unknown, expired or revoked API token", sdkauth.ErrInvalidToken)
			}
			return nil, err
		}
		exp := time.Now().Add(time.Hour)
		if tok.ExpiresAt != nil {
			exp = *tok.ExpiresAt
		}
		return &sdkauth.TokenInfo{UserID: u.ID, Scopes: []string{oauth.Scope}, Expiration: exp,
			Extra: map[string]any{"user": u, "ip": ip, "auth": "api_token"}}, nil
	case auth.HasPrefix(token, auth.PrefixOAuthAccess):
		info, err := s.OAuth.VerifyAccessToken(ctx, token)
		if err != nil {
			if errors.Is(err, oauth.ErrInvalidAccessToken) {
				return nil, fmt.Errorf("%w: unknown, expired or revoked access token", sdkauth.ErrInvalidToken)
			}
			return nil, err
		}
		return &sdkauth.TokenInfo{UserID: info.User.ID, Scopes: []string{oauth.Scope}, Expiration: info.ExpiresAt,
			Extra: map[string]any{"user": info.User, "ip": ip, "auth": "oauth", "client": info.ClientName}}, nil
	}
	return nil, fmt.Errorf("%w: unsupported token format", sdkauth.ErrInvalidToken)
}

// caller returns the acting user of a tool or prompt request.
func caller(extra *sdk.RequestExtra) (workflow.Actor, *auth.User, error) {
	if extra == nil || extra.TokenInfo == nil {
		return workflow.Actor{}, nil, errors.New("unauthenticated request")
	}
	u, ok := extra.TokenInfo.Extra["user"].(*auth.User)
	if !ok || u == nil {
		return workflow.Actor{}, nil, errors.New("unauthenticated request")
	}
	// the recruiter works with the CV database in the portal only: no tasks, no Claude
	if !workflow.Can(u.Role, workflow.PermView) {
		return workflow.Actor{}, nil, errors.New("forbidden: this account works with the CV database in the portal only and has no access through Claude")
	}
	ip, _ := extra.TokenInfo.Extra["ip"].(string)
	return u.Actor(workflow.ViaMCP, ip), u, nil
}

// toolError converts service errors into messages suitable for the model,
// hiding internal details of unexpected failures.
func (s *server) toolError(tool string, err error) error {
	if err == nil {
		return nil
	}
	if e, ok := apperr.As(err); ok {
		return fmt.Errorf("%s: %s", e.Code, e.Message)
	}
	s.Log.Error("mcp tool failed", "tool", tool, "error", err.Error())
	return errors.New("internal error: the operation failed on the server, see server logs")
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

// inputSchema derives a JSON schema from T, adds enum constraints and allows
// additional properties (ignored) so that slightly over-specified calls work.
func inputSchema[T any](enums map[string][]string) *jsonschema.Schema {
	sch, err := jsonschema.For[T](nil)
	if err != nil {
		panic(fmt.Sprintf("mcp schema: %v", err))
	}
	sch.AdditionalProperties = nil
	if sch.Properties == nil {
		sch.Properties = map[string]*jsonschema.Schema{}
	}
	for prop, values := range enums {
		p, ok := sch.Properties[prop]
		if !ok {
			panic("mcp schema: unknown property " + prop)
		}
		target := p
		if p.Items != nil {
			target = p.Items
		}
		for _, v := range values {
			target.Enum = append(target.Enum, v)
		}
		if slices.Contains(target.Types, "null") {
			target.Enum = append(target.Enum, nil)
		}
	}
	return sch
}

func boolPtr(b bool) *bool { return &b }

func readOnly(title string) *sdk.ToolAnnotations {
	return &sdk.ToolAnnotations{Title: title, ReadOnlyHint: true, OpenWorldHint: boolPtr(false)}
}

func writeAnn(title string, destructive, idempotent bool) *sdk.ToolAnnotations {
	return &sdk.ToolAnnotations{Title: title, DestructiveHint: boolPtr(destructive), IdempotentHint: idempotent,
		OpenWorldHint: boolPtr(false)}
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

func (s *server) fmtTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	v := t.In(s.Cfg.Location).Format(time.RFC3339)
	return &v
}

func (s *server) ticketURL(number string) string { return s.Cfg.BaseURL + "/tickets/" + number }

// ticketSummary is the compact task representation returned to the model.
type ticketSummary struct {
	tickets.Shortlist
	LossReason  string  `json:"loss_reason,omitempty"`
	ID          string  `json:"id"`
	Number      string  `json:"number"`
	Title       string  `json:"title"`
	Status      string  `json:"status"`
	CloseResult string  `json:"close_result,omitempty"`
	Priority    string  `json:"priority"`
	Assignee    string  `json:"assignee"`
	AssigneeID  *string `json:"assignee_id,omitempty"`
	Deadline    *string `json:"deadline,omitempty"`
	SourceURL   string  `json:"source_url,omitempty"`
	UpdatedAt   string  `json:"updated_at"`
	URL         string  `json:"url"`
}

func (s *server) summary(t *tickets.Ticket) ticketSummary {
	assignee := "Everyone"
	if t.AssigneeName != nil {
		assignee = *t.AssigneeName
	}
	return ticketSummary{
		Shortlist: t.Shortlist, LossReason: t.LossReason,
		ID: t.ID, Number: t.Number, Title: t.Title, Status: string(t.Status), CloseResult: t.CloseResult,
		Priority: t.Priority, Assignee: assignee, AssigneeID: t.AssigneeID, Deadline: s.fmtTime(t.Deadline),
		SourceURL: t.SourceURL, UpdatedAt: *s.fmtTime(&t.UpdatedAt), URL: s.ticketURL(t.Number),
	}
}

func (s *server) summaries(list []tickets.Ticket) []ticketSummary {
	out := make([]ticketSummary, 0, len(list))
	for i := range list {
		out = append(out, s.summary(&list[i]))
	}
	return out
}

// resolveUser turns "me", "everyone", a login, a full name or a UUID into a
// user ID ("" means everyone).
func (s *server) resolveUser(ctx context.Context, me *auth.User, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	switch strings.ToLower(ref) {
	case "", "everyone", "all", "team", "none", "unassigned":
		return "", nil
	case "me", "self":
		return me.ID, nil
	}
	users, err := s.Auth.ListUsers(ctx, false)
	if err != nil {
		return "", err
	}
	for _, u := range users {
		if u.ID == ref || strings.EqualFold(u.Username, ref) || strings.EqualFold(u.FullName, ref) {
			return u.ID, nil
		}
	}
	return "", apperr.Validationf("User %q not found among active users (use a login, full name, user id, \"me\" or \"everyone\")", ref)
}
