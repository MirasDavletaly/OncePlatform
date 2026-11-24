package cv

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"onceplatform/internal/files"
)

// Engine runs the CV rules engine (cvengine/cli.mjs) with Node.js: one JSON
// request on stdin, one JSON answer on stdout.
type Engine struct {
	Node string
	Dir  string

	mu   sync.Mutex
	meta json.RawMessage
}

func (e *Engine) call(ctx context.Context, req, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	in, err := json.Marshal(req)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, e.Node, filepath.Join(e.Dir, "cli.mjs"))
	cmd.Stdin = bytes.NewReader(in)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return fmt.Errorf("cv engine: %v: %s", err, msg)
	}
	return json.Unmarshal(stdout.Bytes(), out)
}

// Parse turns CV text into a profile.
func (e *Engine) Parse(ctx context.Context, text string, ocr bool) (json.RawMessage, error) {
	var out struct {
		Profile json.RawMessage `json:"profile"`
	}
	err := e.call(ctx, map[string]any{"op": "parse", "text": text, "ocr": ocr}, &out)
	return out.Profile, err
}

// Refresh recomputes derived fields of a manually edited profile.
func (e *Engine) Refresh(ctx context.Context, profile json.RawMessage) (json.RawMessage, error) {
	var out struct {
		Profile json.RawMessage `json:"profile"`
	}
	err := e.call(ctx, map[string]any{"op": "refresh", "profile": profile}, &out)
	return out.Profile, err
}

// engineResult is one candidate scored against one role.
type engineResult struct {
	ID    string             `json:"id"`
	Score int                `json:"score"`
	Parts map[string]float64 `json:"parts"`
	Fails []string           `json:"fails"`
	Why   json.RawMessage    `json:"why"`
}

// Match scores the candidates against each role.
func (e *Engine) Match(ctx context.Context, roles []Role, cands []engineCandidate) ([][]engineResult, error) {
	var out struct {
		Roles []struct {
			Results []engineResult `json:"results"`
		} `json:"roles"`
	}
	if err := e.call(ctx, map[string]any{"op": "match", "roles": roles, "candidates": cands}, &out); err != nil {
		return nil, err
	}
	res := make([][]engineResult, len(out.Roles))
	for i, r := range out.Roles {
		res[i] = r.Results
	}
	return res, nil
}

type engineCandidate struct {
	ID      string          `json:"id"`
	Profile json.RawMessage `json:"profile"`
}

// docReading is what the engine read from a diploma or certificate and whose
// candidate it is (Match is nil unless exactly one candidate fits best).
type docReading struct {
	Info  map[string]any `json:"info"`
	Match *struct {
		ID string `json:"id"`
		By string `json:"by"`
	} `json:"match"`
	Suggestions []map[string]any `json:"suggestions"`
}

type namedCandidate struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
	Phone string `json:"phone,omitempty"`
}

// SamePerson finds the candidate a newly parsed CV belongs to (the same e-mail
// or phone, or the whole same name); empty when it is a new person.
func (e *Engine) SamePerson(ctx context.Context, profile json.RawMessage, cands []namedCandidate) (id, by string, err error) {
	var out struct {
		Match *struct {
			ID string `json:"id"`
			By string `json:"by"`
		} `json:"match"`
	}
	if err := e.call(ctx, map[string]any{"op": "person", "profile": profile, "candidates": cands}, &out); err != nil || out.Match == nil {
		return "", "", err
	}
	return out.Match.ID, out.Match.By, nil
}

// ReadDocument recognises a document and looks its holder up among the candidates.
func (e *Engine) ReadDocument(ctx context.Context, text string, cands []namedCandidate) (*docReading, error) {
	var out docReading
	err := e.call(ctx, map[string]any{"op": "document", "text": text, "candidates": cands}, &out)
	return &out, err
}

// ApplyDocuments marks the profile entries confirmed by the attached documents
// (docs: their info with the document id) and drops those of detached ones.
func (e *Engine) ApplyDocuments(ctx context.Context, profile json.RawMessage, docs []map[string]any) (json.RawMessage, error) {
	var out struct {
		Profile json.RawMessage `json:"profile"`
	}
	if len(profile) == 0 {
		profile = json.RawMessage("null")
	}
	err := e.call(ctx, map[string]any{"op": "documents", "profile": profile, "docs": docs}, &out)
	return out.Profile, err
}

// Meta returns the professions, skill dictionary, languages and levels of the
// engine (cached after the first successful call).
func (e *Engine) Meta(ctx context.Context) (json.RawMessage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.meta != nil {
		return e.meta, nil
	}
	var out json.RawMessage
	if err := e.call(ctx, map[string]any{"op": "meta"}, &out); err != nil {
		return nil, err
	}
	e.meta = out
	return out, nil
}

// ---------------------------------------------------------------------------
// Text of a CV: text layer, or OCR for scans and photos
// ---------------------------------------------------------------------------

// ocrLangs are the Tesseract models: Kazakh, Russian, English.
const ocrLangs = "kaz+rus+eng"

// ocrMaxPages caps the pages of a scanned PDF that are recognised.
const ocrMaxPages = 10

// cvExt are the accepted CV file types.
var cvExt = map[string]bool{"pdf": true, "docx": true, "txt": true, "png": true, "jpg": true, "jpeg": true}

// extractCV returns the text of a CV and whether OCR produced it. A PDF with
// (almost) no text layer is a scan and is recognised page by page.
func extractCV(ctx context.Context, tmpDir, path, ext string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	switch ext {
	case "png", "jpg", "jpeg":
		t, err := tesseract(ctx, path)
		return files.SanitizeText(t), true, err
	case "pdf":
		t, err := files.ExtractText(ctx, path, ext)
		if err == nil && letters(t) >= 100 {
			return t, false, nil
		}
		o, oerr := ocrPDF(ctx, tmpDir, path)
		if oerr != nil {
			if err == nil && letters(t) > 0 {
				return t, false, nil // a short text CV is better than nothing
			}
			return "", true, oerr
		}
		return files.SanitizeText(o), true, nil
	default:
		t, err := files.ExtractText(ctx, path, ext)
		return t, false, err
	}
}

func letters(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			n++
		}
	}
	return n
}

func ocrPDF(ctx context.Context, tmpDir, path string) (string, error) {
	dir, err := os.MkdirTemp(tmpDir, "ocr-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	if err := run(ctx, "pdftoppm", "-r", "300", "-gray", "-png", "-l", fmt.Sprint(ocrMaxPages), path, filepath.Join(dir, "p")); err != nil {
		return "", err
	}
	pages, _ := filepath.Glob(filepath.Join(dir, "p*.png"))
	sort.Strings(pages)
	if len(pages) == 0 {
		return "", errors.New("the PDF has no pages to recognise")
	}
	var b strings.Builder
	for _, p := range pages {
		t, err := tesseract(ctx, p)
		if err != nil {
			return "", err
		}
		b.WriteString(t)
		b.WriteString("\n\n")
	}
	return b.String(), nil
}

// latinOCR: a page whose recognised letters are mostly Latin is read again
// with the English model alone. With the Kazakh and Russian models on, English
// words come out as Cyrillic noise ("Karim Nasser-Haddad" → "Капш Н;ъаш-нш"); a
// Russian CV full of English terms stays well below (about 0.3).
const latinOCR = 0.6

func tesseract(ctx context.Context, img string) (string, error) {
	t, err := tesseractLangs(ctx, img, ocrLangs)
	if err != nil || latinShare(t) < latinOCR {
		return t, err
	}
	if en, err := tesseractLangs(ctx, img, "eng"); err == nil && letters(en) > 0 {
		return en, nil
	}
	return t, nil
}

func latinShare(s string) float64 {
	latin, all := 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			all++
			if r < 0x250 {
				latin++
			}
		}
	}
	if all == 0 {
		return 0
	}
	return float64(latin) / float64(all)
}

func tesseractLangs(ctx context.Context, img, langs string) (string, error) {
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "tesseract", img, "stdout", "-l", langs)
	cmd.Stdout = &out
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", errors.New("OCR is not available: tesseract is not installed")
		}
		return "", fmt.Errorf("tesseract: %v: %s", err, lastLine(stderr.String()))
	}
	return out.String(), nil
}

func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return fmt.Errorf("%s is not installed", name)
		}
		return fmt.Errorf("%s: %v: %s", name, err, lastLine(stderr.String()))
	}
	return nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
