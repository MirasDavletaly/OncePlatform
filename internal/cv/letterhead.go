package cv

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"image"
	"path"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/workflow"
)

// Company letterheads of the standard CV: the logo is part of the build, the
// lines under it and the footer are edited by an administrator in the portal.

//go:embed letterheads/knt.png letterheads/gs.jpg
var logos embed.FS

var logoFile = map[string]string{"knt": "letterheads/knt.png", "gs": "letterheads/gs.jpg"}

// logoHeight in the header, EMU (1 cm = 360000): the Green Spark logo is small
// (165 px wide) and blurs when drawn larger.
var logoHeight = map[string]int{"knt": 742950, "gs": 432000}

type Letterhead struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Header    string     `json:"header"`
	Footer    string     `json:"footer"`
	UpdatedAt *time.Time `json:"updated_at"`
}

// docLetterhead is what the Word export draws: the logo with the header lines,
// and the footer lines.
type docLetterhead struct {
	logo          []byte
	ext           string
	width, height int // EMU
	header        []string
	footer        []string
}

const (
	maxLetterheadLines = 8
	maxLetterheadLine  = 200
)

func (s *Service) Letterheads(ctx context.Context, actor workflow.Actor) ([]Letterhead, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id, name, header, footer, updated_at FROM cv_letterheads ORDER BY sort`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Letterhead, error) {
		var l Letterhead
		err := r.Scan(&l.ID, &l.Name, &l.Header, &l.Footer, &l.UpdatedAt)
		return l, err
	})
}

// cleanLetterheadText: lines without control characters, at most 8 of 200 characters.
func cleanLetterheadText(field, s string) (string, error) {
	var lines []string
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
				return -1
			}
			return r
		}, l))
		if len([]rune(l)) > maxLetterheadLine {
			return "", apperr.Validationf("A line of the %s is longer than %d characters", field, maxLetterheadLine)
		}
		lines = append(lines, l)
	}
	out := strings.Trim(strings.Join(lines, "\n"), "\n")
	if strings.Count(out, "\n") >= maxLetterheadLines {
		return "", apperr.Validationf("The %s has more than %d lines", field, maxLetterheadLines)
	}
	return out, nil
}

// SaveLetterhead changes the lines of a company's letterhead (administrators only:
// the text goes on every CV sent to clients).
func (s *Service) SaveLetterhead(ctx context.Context, actor workflow.Actor, id, header, footer string) (*Letterhead, error) {
	if err := actor.Require(workflow.PermUsersManage); err != nil {
		return nil, err
	}
	var err error
	if header, err = cleanLetterheadText("header", header); err != nil {
		return nil, err
	}
	if footer, err = cleanLetterheadText("footer", footer); err != nil {
		return nil, err
	}
	var l Letterhead
	err = s.pool.QueryRow(ctx, `UPDATE cv_letterheads SET header = $2, footer = $3, updated_by = $4, updated_at = now() WHERE id = $1
		RETURNING id, name, header, footer, updated_at`, id, header, footer, actor.UserID).Scan(&l.ID, &l.Name, &l.Header, &l.Footer, &l.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("No such letterhead")
	}
	if err != nil {
		return nil, err
	}
	if err := audit.Write(ctx, s.pool, audit.FromActor(actor, "cv.letterhead_update", "cv_letterhead", "", map[string]any{"letterhead": l.ID, "name": l.Name})); err != nil {
		return nil, err
	}
	return &l, nil
}

// letterheadFor is the letterhead of an export; "" means none.
func (s *Service) letterheadFor(ctx context.Context, id string) (*docLetterhead, error) {
	if id == "" {
		return nil, nil
	}
	file, ok := logoFile[id]
	if !ok {
		return nil, apperr.Validation("Unknown letterhead")
	}
	var name, header, footer string
	if err := s.pool.QueryRow(ctx, `SELECT name, header, footer FROM cv_letterheads WHERE id = $1`, id).Scan(&name, &header, &footer); err != nil {
		return nil, err
	}
	logo, err := logos.ReadFile(file)
	if err != nil {
		return nil, err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(logo))
	if err != nil {
		return nil, err
	}
	lh := &docLetterhead{logo: logo, ext: strings.TrimPrefix(path.Ext(file), "."), height: logoHeight[id]}
	lh.width = lh.height * cfg.Width / cfg.Height
	if header == "" {
		header = name
	}
	lh.header = strings.Split(header, "\n")
	if footer != "" {
		lh.footer = strings.Split(footer, "\n")
	}
	return lh, nil
}
