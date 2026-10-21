// Package search implements the global full-text search over tasks,
// comments and attachment text.
//
// Text is indexed with the 'simple' configuration (no stemming), so Kazakh
// words are not distorted by a Russian stemmer. Queries use prefix matching
// ("тендер:*") for word forms, plus a pg_trgm-backed ILIKE substring match
// as a fallback for partial words, numbers and codes.
package search

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/db"
)

// Highlight markers wrapped around matches in snippets. The frontend splits
// on them and renders <mark> elements (no HTML is ever produced by the server).
const (
	MarkStart = "⟦" // ⟦
	MarkStop  = "⟧" // ⟧
)

// Kinds of search results.
var Kinds = []string{"ticket", "comment", "attachment"}

// Result is a single search hit.
type Result struct {
	Kind         string    `json:"kind"`
	ID           string    `json:"id"`
	TicketID     *string   `json:"ticket_id"`
	TicketNumber *string   `json:"ticket_number"`
	Title        string    `json:"title"`
	Context      string    `json:"context"`
	Snippet      string    `json:"snippet"`
	Rank         float64   `json:"rank"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Group holds the results of one kind.
type Group struct {
	Kind  string   `json:"kind"`
	Total int      `json:"total"`
	Items []Result `json:"items"`
}

// Response is the search result grouped by kind.
type Response struct {
	Query      string  `json:"query"`
	MarkStart  string  `json:"mark_start"`
	MarkStop   string  `json:"mark_stop"`
	Groups     []Group `json:"groups"`
	TotalCount int     `json:"total"`
}

// Service runs searches.
type Service struct {
	pool *pgxpool.Pool
}

// NewService creates the search service.
func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

const headlineOpts = "StartSel=" + MarkStart + ", StopSel=" + MarkStop +
	", MaxWords=30, MinWords=10, MaxFragments=2, FragmentDelimiter=\" … \""

// snippet returns an SQL expression producing a highlighted fragment of
// textExpr: ts_headline when the full-text query matches, otherwise a window
// around the first substring match.
func snippet(textExpr, vectorExpr string) string {
	return fmt.Sprintf(`CASE WHEN q.tsq IS NOT NULL AND %[2]s @@ q.tsq
		THEN ts_headline('simple', %[1]s, q.tsq, '%[3]s')
		ELSE substr(%[1]s, greatest(strpos(lower(%[1]s), lower(q.raw)) - 100, 1), 260) END`,
		textExpr, vectorExpr, headlineOpts)
}

// Search runs the query over the selected kinds (all when empty). limit and
// offset apply per kind.
func (s *Service) Search(ctx context.Context, query string, kinds []string, limit, offset int) (*Response, error) {
	query = strings.TrimSpace(query)
	if len([]rune(query)) < 2 {
		return nil, apperr.Validation("Enter at least 2 characters to search")
	}
	if len([]rune(query)) > 200 {
		return nil, apperr.Validation("The query is too long")
	}
	if limit < 1 || limit > 100 {
		limit = 10
	}
	if offset < 0 {
		offset = 0
	}
	if len(kinds) == 0 {
		kinds = Kinds
	}
	tsq := db.PrefixTSQuery(query)
	like := db.LikePattern(query)
	resp := &Response{Query: query, MarkStart: MarkStart, MarkStop: MarkStop, Groups: []Group{}}
	for _, kind := range Kinds {
		if !slices.Contains(kinds, kind) {
			continue
		}
		g, err := s.searchKind(ctx, kind, tsq, query, like, limit, offset)
		if err != nil {
			return nil, err
		}
		resp.Groups = append(resp.Groups, *g)
		resp.TotalCount += g.Total
	}
	return resp, nil
}

const qCTE = `WITH q AS (SELECT CASE WHEN $1 <> '' THEN to_tsquery('simple', $1) END AS tsq, $2::text AS raw)`

func (s *Service) searchKind(ctx context.Context, kind, tsq, raw, like string, limit, offset int) (*Group, error) {
	var sql string
	switch kind {
	case "ticket":
		text := `left(t.title || E'\n' || t.description || E'\n' || t.technical_solution, 200000)`
		sql = qCTE + `
			SELECT 'ticket', t.id::text, t.id::text, t.number, t.title,
			       coalesce(a.full_name, ''), ` + snippet(text, "t.search_vector") + `,
			       coalesce(ts_rank_cd(t.search_vector, q.tsq), 0) + CASE WHEN t.title ILIKE $3 THEN 1 ELSE 0 END,
			       t.updated_at, count(*) OVER ()
			FROM tickets t CROSS JOIN q LEFT JOIN users a ON a.id = t.assignee_id
			WHERE t.deleted_at IS NULL AND (t.search_vector @@ q.tsq OR t.title ILIKE $3 OR t.number ILIKE $3
			      OR t.description ILIKE $3 OR t.technical_solution ILIKE $3)`
	case "comment":
		sql = qCTE + `
			SELECT 'comment', cm.id::text, t.id::text, t.number, t.title,
			       u.full_name, ` + snippet("cm.body", "cm.search_vector") + `,
			       coalesce(ts_rank_cd(cm.search_vector, q.tsq), 0), cm.created_at, count(*) OVER ()
			FROM comments cm CROSS JOIN q
			JOIN tickets t ON t.id = cm.ticket_id JOIN users u ON u.id = cm.author_id
			WHERE cm.deleted_at IS NULL AND t.deleted_at IS NULL
			  AND (cm.search_vector @@ q.tsq OR cm.body ILIKE $3)`
	case "attachment":
		text := `left(coalesce(a.extracted_text, ''), 300000)`
		sql = qCTE + `
			SELECT 'attachment', a.id::text, t.id::text, t.number, a.original_name,
			       t.number || ' ' || t.title, ` + snippet(text, "a.search_vector") + `,
			       coalesce(ts_rank_cd(a.search_vector, q.tsq), 0) + CASE WHEN a.original_name ILIKE $3 THEN 1 ELSE 0 END,
			       a.created_at, count(*) OVER ()
			FROM attachments a CROSS JOIN q JOIN tickets t ON t.id = a.ticket_id
			WHERE a.deleted_at IS NULL AND t.deleted_at IS NULL
			  AND (a.search_vector @@ q.tsq OR a.original_name ILIKE $3 OR a.extracted_text ILIKE $3)`
	default:
		return nil, apperr.Validation("Unknown result kind")
	}
	sql += ` ORDER BY 8 DESC, 9 DESC LIMIT $4 OFFSET $5`
	rows, err := s.pool.Query(ctx, sql, tsq, raw, like, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("search %s: %w", kind, err)
	}
	defer rows.Close()
	g := &Group{Kind: kind, Items: []Result{}}
	for rows.Next() {
		var r Result
		var snip *string
		if err := rows.Scan(&r.Kind, &r.ID, &r.TicketID, &r.TicketNumber, &r.Title, &r.Context,
			&snip, &r.Rank, &r.UpdatedAt, &g.Total); err != nil {
			return nil, err
		}
		if snip != nil {
			r.Snippet = strings.TrimSpace(*snip)
		}
		g.Items = append(g.Items, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return g, nil
}
