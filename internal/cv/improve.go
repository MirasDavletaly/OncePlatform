package cv

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/files"
	"onceplatform/internal/workflow"
)

// The engine gets better, while a CV parsed earlier keeps its stored profile -
// which people often completed by hand. Improvements lists the CVs whose new
// parse (the same parse as "Parse again", on the stored text) loses nothing of
// what is stored - jobs, titles, companies, education, the name - and finds
// more; ApplyImprovements writes the new parse of those an administrator
// picked. A profile completed by hand finds more stored than parsed and is
// never offered.

// ParseCounts are what a profile holds, as compared between two parses.
type ParseCounts struct {
	Jobs      int  `json:"jobs"`
	Titles    int  `json:"titles"`
	Companies int  `json:"companies"`
	Education int  `json:"education"`
	Name      bool `json:"name"`
}

func countsOf(profile json.RawMessage) ParseCounts {
	var p struct {
		Basics struct {
			Name string `json:"name"`
		} `json:"basics"`
		Work []struct {
			Name     string `json:"name"`
			Position string `json:"position"`
		} `json:"work"`
		Education []json.RawMessage `json:"education"`
	}
	_ = json.Unmarshal(profile, &p)
	c := ParseCounts{Jobs: len(p.Work), Education: len(p.Education), Name: p.Basics.Name != ""}
	for _, w := range p.Work {
		if w.Position != "" {
			c.Titles++
		}
		if w.Name != "" {
			c.Companies++
		}
	}
	return c
}

// improves: nothing fewer than before and something more.
func (a ParseCounts) improves(b ParseCounts) bool {
	covers := a.Jobs >= b.Jobs && a.Titles >= b.Titles && a.Companies >= b.Companies && a.Education >= b.Education && (a.Name || !b.Name)
	return covers && a != b
}

type ImprovedCV struct {
	ID     string      `json:"id"`
	Code   string      `json:"code"`
	Before ParseCounts `json:"before"`
	After  ParseCounts `json:"after"`
}

type Improvements struct {
	Items []ImprovedCV `json:"items"`
	Same  int          `json:"same"`  // the new parse gives the same
	Kept  int          `json:"kept"`  // the stored profile holds more somewhere: completed by hand, kept
	Other int          `json:"other"` // not parsed yet, failed or without text
}

type storedCV struct {
	id, text, fullName, stored, fileName string
	number                               int
	ocr                                  bool
	profile                              json.RawMessage
	updated                              time.Time
}

// newParse is "Parse again": the engine and the attached documents, on the stored text - read from the file again
// when there is none (an extraction error fixed since) or it is scattered word by word (now read from the page images).
func (s *Service) newParse(ctx context.Context, c *storedCV) (json.RawMessage, error) {
	if c.text == "" || fragmented(c.text) {
		text, ocr, err := extractCV(ctx, s.tmp, s.pathFor(c.stored), files.Ext(c.fileName))
		if err != nil {
			return nil, err
		}
		if letters(text) == 0 {
			return nil, errors.New("no text was found in the file")
		}
		c.text, c.ocr = text, ocr
	}
	profile, err := s.engine.Parse(ctx, c.text, c.ocr)
	if err != nil {
		return nil, err
	}
	docs, err := candidateDocs(ctx, s.pool, c.id)
	if err != nil || len(docs) == 0 {
		return profile, err
	}
	return s.engine.ApplyDocuments(ctx, profile, docs)
}

func (s *Service) storedCVs(ctx context.Context, ids []string) ([]storedCV, int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, number, coalesce(cv_text, ''), ocr, coalesce(profile, 'null'), full_name, updated_at, status,
		stored_name, file_name FROM candidates WHERE $1::uuid[] IS NULL OR id = ANY($1) ORDER BY number`, ids)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []storedCV
	other := 0
	for rows.Next() {
		var c storedCV
		var status string
		if err := rows.Scan(&c.id, &c.number, &c.text, &c.ocr, &c.profile, &c.fullName, &c.updated, &status, &c.stored, &c.fileName); err != nil {
			return nil, 0, err
		}
		if status != "ready" || string(c.profile) == "null" {
			other++
			continue
		}
		out = append(out, c)
	}
	return out, other, rows.Err()
}

// Improvements parses every CV again without storing anything (administrators only).
func (s *Service) Improvements(ctx context.Context, actor workflow.Actor) (*Improvements, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return nil, err
	}
	cvs, other, err := s.storedCVs(ctx, nil)
	if err != nil {
		return nil, err
	}
	res := &Improvements{Items: []ImprovedCV{}, Other: other}
	for i := range cvs {
		c := &cvs[i]
		profile, err := s.newParse(ctx, c)
		if err != nil {
			res.Other++
			continue
		}
		before, after := countsOf(c.profile), countsOf(profile)
		switch {
		case after.improves(before):
			res.Items = append(res.Items, ImprovedCV{ID: c.id, Code: Code(c.number), Before: before, After: after})
		case after == before:
			res.Same++
		default:
			res.Kept++
		}
	}
	return res, nil
}

// ApplyImprovements stores the new parse of the picked CVs that still improve on
// what is stored (a profile edited since the preview is left alone).
func (s *Service) ApplyImprovements(ctx context.Context, actor workflow.Actor, ids []string) (int, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return 0, err
	}
	if len(ids) == 0 || len(ids) > 1000 {
		return 0, apperr.Validation("Pick the CVs to update")
	}
	cvs, _, err := s.storedCVs(ctx, ids)
	if err != nil {
		return 0, err
	}
	done := 0
	for i := range cvs {
		c := &cvs[i]
		profile, err := s.newParse(ctx, c)
		if err != nil || !countsOf(profile).improves(countsOf(c.profile)) {
			continue
		}
		var p, prev struct {
			Basics struct {
				Name string `json:"name"`
			} `json:"basics"`
		}
		_ = json.Unmarshal(profile, &p)
		_ = json.Unmarshal(c.profile, &prev)
		tag, err := s.pool.Exec(ctx, `UPDATE candidates SET profile = $2, full_name = $3, cv_text = $5, ocr = $6, updated_at = now()
			WHERE id = $1 AND updated_at = $4 AND status = 'ready'`,
			c.id, []byte(profile), nameAfterParse(c.fullName, prev.Basics.Name, truncate(p.Basics.Name, 200)), c.updated, c.text, c.ocr)
		if err != nil {
			return done, err
		}
		if tag.RowsAffected() == 0 {
			continue // edited or parsed since it was read
		}
		if err := audit.Write(ctx, s.pool, audit.FromActor(actor, "candidate.reparse", "candidate", c.id,
			map[string]any{"code": Code(c.number), "how": "improved"})); err != nil {
			return done, err
		}
		done++
	}
	return done, nil
}
