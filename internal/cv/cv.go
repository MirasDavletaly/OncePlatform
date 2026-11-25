// Package cv is the CV section: candidates' CVs and their parsed profiles,
// the key-personnel requirements of tasks and the matching between them.
//
// CVs are personal data. They are stored only on this server (outside the
// attachments table, so they never reach the global search or the MCP file
// tools), uploaded with the candidate's written consent, shown in full only
// to roles with cv.manage (others see anonymised profiles), and deleted for
// real (row and files) on request. Parsing and matching run in the rules
// engine in cvengine/ (Node.js); scans and photos are recognised with
// Tesseract.
package cv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/files"
	"onceplatform/internal/workflow"
)

// Candidate is a CV with its profile. Personal fields are empty when the
// viewer may not see them (Anonymized).
type Candidate struct {
	ID             string          `json:"id"`
	Number         int             `json:"number"`
	Code           string          `json:"code"`
	FullName       string          `json:"full_name,omitempty"`
	FileName       string          `json:"file_name,omitempty"`
	Mime           string          `json:"mime,omitempty"`
	Size           int64           `json:"size,omitempty"`
	Status         string          `json:"status"`
	Error          string          `json:"error,omitempty"`
	OCR            bool            `json:"ocr"`
	Profile        json.RawMessage `json:"profile"`
	ConsentDate    string          `json:"consent_date"`
	ConsentNote    string          `json:"consent_note,omitempty"`
	HasConsentFile bool            `json:"has_consent_file"`
	UploadedByName string          `json:"uploaded_by_name"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
	Anonymized     bool            `json:"anonymized"`
	Documents      []Document      `json:"documents,omitempty"` // diplomas and certificates (single candidate, cv.manage)
	ReferredBy     string          `json:"referred_by,omitempty"`
	// Translations of the profile's texts made from its current texts, per
	// interface language; TranslationStatus: ok, outdated or missing.
	Translations      map[string]map[string]string `json:"translations,omitempty"`
	TranslationStatus map[string]string            `json:"translation_status"`

	storedName, consentStored, consentName, consentMime string
}

// Code is the reference shown instead of the name, e.g. CV-0007.
func Code(n int) string { return fmt.Sprintf("CV-%04d", n) }

// docTitle: a document title above the name, never a name (Go matches case-insensitively in any script; PostgreSQL's
// ~* depends on the database locale and missed "ПЕРСОНАЛЬНОЕ").
var docTitle = regexp.MustCompile(`(?i)^\s*(персональное\s+портфолио|портфолио|резюме|түйіндеме|curriculum\s+vitae|cv|resume|résumé|personal\s+portfolio)\s*$`)

// nameAfterParse: the name follows the parse unless a person typed it - taken when the stored one is empty, equal to
// the name of the previous parse or a document title an older parser took for a name.
func nameAfterParse(stored, prevParsed, parsed string) string {
	if parsed != "" && (stored == "" || stored == prevParsed || docTitle.MatchString(stored)) {
		return parsed
	}
	return stored
}

// Service manages candidates and requirements.
type Service struct {
	pool     *pgxpool.Pool
	log      *slog.Logger
	root     string // <storage>/cv
	tmp      string
	maxBytes int64
	loc      *time.Location
	engine   *Engine
	queue    chan string
}

// NewService creates the CV service; files go to <storage>/cv.
func NewService(pool *pgxpool.Pool, log *slog.Logger, storage string, maxBytes int64, loc *time.Location, engine *Engine) (*Service, error) {
	abs, err := filepath.Abs(storage)
	if err != nil {
		return nil, err
	}
	s := &Service{pool: pool, log: log, root: filepath.Join(abs, "cv"), tmp: filepath.Join(abs, "tmp"), maxBytes: maxBytes,
		loc: loc, engine: engine, queue: make(chan string, 1000)}
	for _, d := range []string{s.root, s.tmp} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			return nil, fmt.Errorf("cv storage %s: %w", d, err)
		}
	}
	// leftovers of a crash or an out-of-memory kill (partial uploads, OCR pages): nothing else removes them
	if entries, err := os.ReadDir(s.tmp); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > time.Hour {
				_ = os.RemoveAll(filepath.Join(s.tmp, e.Name()))
			}
		}
	}
	return s, nil
}

// Meta returns the engine's professions, skills, languages and levels.
func (s *Service) Meta(ctx context.Context) (json.RawMessage, error) { return s.engine.Meta(ctx) }

const candidateSelect = `
	SELECT c.id, c.number, c.full_name, c.file_name, c.stored_name, c.mime, c.size, c.status, c.error, c.ocr,
	       c.profile, c.consent_date, c.consent_note, coalesce(c.consent_file_name, ''), coalesce(c.consent_stored_name, ''),
	       coalesce(c.consent_mime, ''), u.full_name, c.created_at, c.updated_at, c.referred_by, c.translations
	FROM candidates c JOIN users u ON u.id = c.uploaded_by`

func scanCandidate(row pgx.Row) (*Candidate, error) {
	var c Candidate
	var profile, translations []byte
	var consent time.Time
	err := row.Scan(&c.ID, &c.Number, &c.FullName, &c.FileName, &c.storedName, &c.Mime, &c.Size, &c.Status, &c.Error, &c.OCR,
		&profile, &consent, &c.ConsentNote, &c.consentName, &c.consentStored, &c.consentMime, &c.UploadedByName,
		&c.CreatedAt, &c.UpdatedAt, &c.ReferredBy, &translations)
	if err != nil {
		return nil, err
	}
	c.Code = Code(c.Number)
	if c.Error == processingMark { // the worker's own mark, no error
		c.Error = ""
	}
	c.Profile = profile
	c.ConsentDate = consent.Format(time.DateOnly)
	c.HasConsentFile = c.consentStored != ""
	c.Translations, c.TranslationStatus = translationState(translations, profile, c.FullName)
	return &c, nil
}

// anonFor: personal data is shown only to cv.manage, and never through MCP.
func anonFor(actor workflow.Actor) bool {
	return !actor.Can(workflow.PermCVManage) || actor.Via == workflow.ViaMCP
}

var errNotFound = apperr.NotFound("Candidate not found")

func (s *Service) get(ctx context.Context, q db.Querier, id string) (*Candidate, error) {
	if !db.IsUUID(id) {
		return nil, errNotFound
	}
	c, err := scanCandidate(q.QueryRow(ctx, candidateSelect+` WHERE c.id = $1`, id))
	if db.IsNoRows(err) {
		return nil, errNotFound
	}
	return c, err
}

// Get returns a candidate as the actor may see it.
func (s *Service) Get(ctx context.Context, actor workflow.Actor, id string) (*Candidate, error) {
	if err := actor.Require(workflow.PermCVView); err != nil {
		return nil, err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return nil, err
	}
	if anonFor(actor) {
		return view(c, true), nil
	}
	c.Documents, err = s.queryDocuments(ctx, s.pool, `d.candidate_id = $1`, c.ID)
	return c, err
}

// GetByRef returns a candidate by code (CV-0007), number or id, as the actor
// may see it (anonymised through MCP).
func (s *Service) GetByRef(ctx context.Context, actor workflow.Actor, ref string) (*Candidate, error) {
	ref = strings.TrimSpace(ref)
	if n, err := strconv.Atoi(strings.TrimPrefix(strings.ToUpper(ref), "CV-")); err == nil {
		if err := s.pool.QueryRow(ctx, `SELECT id FROM candidates WHERE number = $1`, n).Scan(&ref); err != nil {
			if db.IsNoRows(err) {
				return nil, errNotFound
			}
			return nil, err
		}
	}
	return s.Get(ctx, actor, ref)
}

// List returns all candidates, newest first.
// ponytail: whole list with profiles in one response; paginate past a few thousand CVs.
func (s *Service) List(ctx context.Context, actor workflow.Actor) ([]Candidate, error) {
	if err := actor.Require(workflow.PermCVView); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, candidateSelect+` ORDER BY c.number DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	anon := anonFor(actor)
	out := []Candidate{}
	for rows.Next() {
		c, err := scanCandidate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *view(c, anon))
	}
	return out, rows.Err()
}

// view hides personal data when anon is set: name, contacts, file and consent
// note. Job titles, experience, skills, languages and certificates stay.
func view(c *Candidate, anon bool) *Candidate {
	if !anon {
		return c
	}
	v := *c
	v.FullName, v.FileName, v.Mime, v.Size, v.ConsentNote, v.ReferredBy, v.Anonymized = "", "", "", 0, "", "", true
	v.Profile = anonymizeProfile(c.Profile, c.FullName)
	if v.Error != "" { // engine or OCR output may quote the CV
		v.Error = "The CV could not be read"
	}
	return &v
}

var (
	emailRe = regexp.MustCompile(`[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}`)
	phoneRe = regexp.MustCompile(`\+?\(?\d[\d\s()\-]{8,}\d`)
	// a job title line that is in fact an address or personal data (the parser's mistake on some layouts)
	personalTitle = regexp.MustCompile(`(?i)born|birth|рожд|туған|(^|[^\p{L}])(male|female)([^\p{L}]|$)|мужской|женский|street|улица|ул\.|көшесі|микрорайон|мкр\.|avenue`)
	// …or the name itself, in capitals with an initial or a suffix ("JOHN Q. PUBLIC JR."), when the parser found
	// no name - then that line is the name to mask in the other texts (a signature under the declaration)
	capsLine        = regexp.MustCompile(`^[\p{Lu}\s.'’-]+$`)
	initialOrSuffix = regexp.MustCompile(`(^|\s)\p{Lu}\.(\s|$)|\s(JR|SR|II|III)\.?$`)
	titleWord       = regexp.MustCompile(`(?i)engineer|manager|technician|specialist|operator|fitter|electrician|supervisor|foreman|inspector|coordinator|director|lead|officer|planner|welder|инженер|менеджер|техник|специалист|оператор|монтажник|электрик|мастер|прораб`)
	// …or the name glued into one word in capitals ("JOHNPUBLIC": the PDF lost the space), unless it ends like a
	// profession ("PLUMBER", "ELECTRICIAN")
	gluedName  = regexp.MustCompile(`^\p{Lu}{6,30}$`)
	profSuffix = regexp.MustCompile(`(ER|OR|IST|IAN|ANT|MAN|ИК|ЕР|ОР)$`)
)

func personalLabel(l string) bool {
	return personalTitle.MatchString(l) || (capsLine.MatchString(l) && initialOrSuffix.MatchString(l) && !titleWord.MatchString(l)) ||
		(gluedName.MatchString(l) && !titleWord.MatchString(l) && !profSuffix.MatchString(l))
}

// anonymizeProfile removes the name and contacts and masks whatever still
// identifies the person in the other texts: the name's words, e-mails and
// phone numbers (a CV may repeat them in a description, and a misread title
// line may be the name or the address).
func anonymizeProfile(raw json.RawMessage, fullName string) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var p map[string]any
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	names := fullName
	if b, ok := p["basics"].(map[string]any); ok {
		// the name as parsed can differ from the candidate's name (a CV in another language, a hand edit)
		if n, _ := b["name"].(string); n != "" {
			names += " " + n
		}
		for _, k := range []string{"name", "email", "phone", "url", "profiles"} {
			delete(b, k)
		}
		if label, _ := b["label"].(string); personalLabel(label) {
			b["label"] = nil
			if !personalTitle.MatchString(label) { // the name itself
				names += " " + label
			}
		}
	}
	scrub := scrubber(names)
	var walk func(v any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case string:
			return scrub(x)
		case map[string]any:
			for k, e := range x {
				x[k] = walk(e)
			}
		case []any:
			for i, e := range x {
				x[i] = walk(e)
			}
		}
		return v
	}
	out, _ := json.Marshal(walk(p))
	return out
}

// scrubber masks e-mails, phone numbers (10 digits or more: "2012 - 2016" is
// no phone) and the words of the person's name.
func scrubber(fullName string) func(string) string {
	var words []string
	for _, w := range strings.FieldsFunc(fullName, func(r rune) bool { return !unicode.IsLetter(r) }) {
		if utf8.RuneCountInString(w) >= 3 {
			words = append(words, regexp.QuoteMeta(w))
		}
	}
	var nameRe *regexp.Regexp
	if len(words) > 0 {
		nameRe = regexp.MustCompile(`(?i)(^|[^\p{L}])(` + strings.Join(words, "|") + `)([^\p{L}]|$)`)
	}
	return func(s string) string {
		s = emailRe.ReplaceAllString(s, "[e-mail]")
		s = phoneRe.ReplaceAllStringFunc(s, func(m string) string {
			digits := 0
			for _, r := range m {
				if r >= '0' && r <= '9' {
					digits++
				}
			}
			if digits >= 10 {
				return "[phone]"
			}
			return m
		})
		if nameRe != nil {
			// twice: neighbouring words share the separator ("Arman Akhmetov")
			s = nameRe.ReplaceAllString(nameRe.ReplaceAllString(s, "${1}[name]${3}"), "${1}[name]${3}")
		}
		return s
	}
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

// UploadInput is one CV file with the candidate's consent.
type UploadInput struct {
	Name        string
	Body        io.Reader
	ConsentDate string // YYYY-MM-DD, the day the written consent was received
	ConsentNote string
	ReferredBy  string // who recommended the candidate (optional)
}

func cleanReferral(s string) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > 200 {
		return "", apperr.Validation("“Recommended by” is too long (maximum 200 characters)")
	}
	return s, nil
}

// errAlreadyUploaded is not a failure for the uploader: the file is in the portal already.
func errAlreadyUploaded(msg string) error {
	return apperr.New(http.StatusConflict, "already_uploaded", msg)
}

func (s *Service) parseConsent(date, note string) (time.Time, string, error) {
	d, err := time.ParseInLocation(time.DateOnly, strings.TrimSpace(date), s.loc)
	if err != nil {
		return time.Time{}, "", apperr.Validation("Enter the date of the candidate's written consent (YYYY-MM-DD)")
	}
	if d.After(time.Now().In(s.loc)) || d.Year() < 2000 {
		return time.Time{}, "", apperr.Validation("The consent date cannot be in the future")
	}
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > 1000 {
		return time.Time{}, "", apperr.Validation("The consent note is too long (maximum 1,000 characters)")
	}
	return d, note, nil
}

// CheckUpload checks the permission, the consent and the referral before files are received.
func (s *Service) CheckUpload(actor workflow.Actor, date, note, referredBy string) error {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return err
	}
	if _, _, err := s.parseConsent(date, note); err != nil {
		return err
	}
	_, err := cleanReferral(referredBy)
	return err
}

// Upload quota per person per 24 hours (CVs and documents together): far
// above a day's real work, it stops a script from filling the server's disk,
// which the database shares.
const (
	quotaFiles = 300
	quotaBytes = 3 << 30
)

func (s *Service) checkQuota(ctx context.Context, actor workflow.Actor) error {
	var n, bytes int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*), coalesce(sum(size), 0) FROM (
		SELECT size FROM candidates WHERE uploaded_by = $1 AND created_at > now() - interval '1 day'
		UNION ALL SELECT size FROM candidate_documents WHERE uploaded_by = $1 AND created_at > now() - interval '1 day') u`,
		actor.UserID).Scan(&n, &bytes); err != nil {
		return err
	}
	if n >= quotaFiles || bytes >= quotaBytes {
		return apperr.RateLimited(fmt.Sprintf("Upload limit reached (%d files or %d GB a day). Try again tomorrow or ask an administrator.", quotaFiles, quotaBytes>>30))
	}
	return nil
}

// storeFile receives a body into <root>/YYYY/MM/<name>, checks its type and
// returns the relative path, size and SHA-256.
func (s *Service) storeFile(body io.Reader, ext, name string) (string, int64, string, error) {
	tmp, err := os.CreateTemp(s.tmp, "cv-*")
	if err != nil {
		return "", 0, "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(body, s.maxBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return "", 0, "", apperr.TooLarge("The request is too large")
		}
		return "", 0, "", err
	}
	if n > s.maxBytes {
		return "", 0, "", apperr.TooLarge(fmt.Sprintf("The file exceeds the size limit (%d MB)", s.maxBytes>>20))
	}
	if n == 0 {
		return "", 0, "", apperr.Validation("The file is empty")
	}
	if err := files.CheckFile(tmpName, ext); err != nil {
		return "", 0, "", err
	}
	now := time.Now().In(s.loc)
	rel := fmt.Sprintf("%04d/%02d/%s", now.Year(), int(now.Month()), name)
	final := s.pathFor(rel)
	if err := os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
		return "", 0, "", err
	}
	if err := os.Rename(tmpName, final); err != nil {
		return "", 0, "", err
	}
	_ = os.Chmod(final, 0o640)
	return rel, n, hex.EncodeToString(h.Sum(nil)), nil
}

// Upload stores a CV and schedules its parsing.
func (s *Service) Upload(ctx context.Context, actor workflow.Actor, in UploadInput) (*Candidate, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	consent, note, err := s.parseConsent(in.ConsentDate, in.ConsentNote)
	if err != nil {
		return nil, err
	}
	referral, err := cleanReferral(in.ReferredBy)
	if err != nil {
		return nil, err
	}
	name := files.CleanFileName(in.Name)
	ext := files.Ext(name)
	mime, ok := files.MimeFor(ext, false)
	if name == "" || !ok || !cvExt[ext] {
		return nil, apperr.New(415, "unsupported_file", "A CV must be a PDF, DOCX, TXT, PNG or JPG file")
	}
	if err := s.checkQuota(ctx, actor); err != nil {
		return nil, err
	}
	id, err := db.NewUUID()
	if err != nil {
		return nil, err
	}
	rel, size, sum, err := s.storeFile(in.Body, ext, id)
	if err != nil {
		return nil, err
	}
	var dup int
	if err := s.pool.QueryRow(ctx, `SELECT number FROM candidates WHERE sha256 = $1`, sum).Scan(&dup); err == nil {
		_ = os.Remove(s.pathFor(rel))
		return nil, errAlreadyUploaded(fmt.Sprintf("Already in the database as %s", Code(dup)))
	}
	var c *Candidate
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO candidates (id, file_name, stored_name, mime, size, sha256, consent_date, consent_note, referred_by, uploaded_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			id, name, rel, mime, size, sum, consent, note, referral, actor.UserID); err != nil {
			return err
		}
		if c, err = s.get(ctx, tx, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate.upload", "candidate", id,
			map[string]any{"code": c.Code, "size": size, "format": ext, "consent_date": c.ConsentDate}))
	})
	if err != nil {
		_ = os.Remove(s.pathFor(rel))
		if db.IsUniqueViolation(err) {
			return nil, errAlreadyUploaded("Already in the database")
		}
		return nil, err
	}
	s.enqueue(id)
	return c, nil
}

// ---------------------------------------------------------------------------
// Edit, consent, delete
// ---------------------------------------------------------------------------

// UpdateInput changes the name, the profile (manual corrections) or the consent.
type UpdateInput struct {
	FullName    *string         `json:"full_name"`
	Profile     json.RawMessage `json:"profile"`
	ConsentDate *string         `json:"consent_date"`
	ConsentNote *string         `json:"consent_note"`
	ReferredBy  *string         `json:"referred_by"`
}

const maxProfileBytes = 1 << 20

// Update applies manual changes; an edited profile is recomputed by the engine.
func (s *Service) Update(ctx context.Context, actor workflow.Actor, id string, in UpdateInput) (*Candidate, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return nil, err
	}
	changed := []string{}
	name := c.FullName
	if in.FullName != nil {
		name = strings.TrimSpace(*in.FullName)
		if utf8.RuneCountInString(name) > 200 {
			return nil, apperr.Validation("The name is too long (maximum 200 characters)")
		}
		changed = append(changed, "full_name")
	}
	profile := []byte(c.Profile)
	if len(in.Profile) > 0 && string(in.Profile) != "null" {
		if len(in.Profile) > maxProfileBytes || in.Profile[0] != '{' {
			return nil, apperr.Validation("The profile must be a JSON object of at most 1 MB")
		}
		if profile, err = s.engine.Refresh(ctx, in.Profile); err != nil {
			return nil, err
		}
		changed = append(changed, "profile")
	}
	consentDate, _ := time.ParseInLocation(time.DateOnly, c.ConsentDate, s.loc)
	note := c.ConsentNote
	if in.ConsentDate != nil || in.ConsentNote != nil {
		d, n := c.ConsentDate, c.ConsentNote
		if in.ConsentDate != nil {
			d = *in.ConsentDate
		}
		if in.ConsentNote != nil {
			n = *in.ConsentNote
		}
		if consentDate, note, err = s.parseConsent(d, n); err != nil {
			return nil, err
		}
		changed = append(changed, "consent")
	}
	referral := c.ReferredBy
	if in.ReferredBy != nil {
		if referral, err = cleanReferral(*in.ReferredBy); err != nil {
			return nil, err
		}
		changed = append(changed, "referred_by")
	}
	if len(changed) == 0 {
		return c, nil
	}
	status := c.Status
	if len(profile) > 0 && status != "pending" {
		status = "ready" // a profile written by hand makes a failed CV usable
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE candidates SET full_name = $2, profile = $3, consent_date = $4, consent_note = $5,
			status = $6, referred_by = $7, updated_at = now() WHERE id = $1`, id, name, nullJSON(profile), consentDate, note, status, referral); err != nil {
			return err
		}
		if c, err = s.get(ctx, tx, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate.update", "candidate", id,
			map[string]any{"code": c.Code, "fields": changed}))
	})
	return c, err
}

func nullJSON(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

// Reparse runs the text extraction and the engine again (manual edits of the
// profile are replaced).
func (s *Service) Reparse(ctx context.Context, actor workflow.Actor, id string) (*Candidate, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return nil, err
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE candidates SET status = 'pending', error = '', updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate.reparse", "candidate", id, map[string]any{"code": c.Code}))
	})
	if err != nil {
		return nil, err
	}
	s.enqueue(id)
	c.Status, c.Error = "pending", ""
	return c, nil
}

// consentExt are the accepted types of a signed consent.
var consentExt = map[string]bool{"pdf": true, "png": true, "jpg": true, "jpeg": true, "docx": true}

// SetConsentFile stores the signed consent form (replacing a previous one).
func (s *Service) SetConsentFile(ctx context.Context, actor workflow.Actor, id, fileName string, body io.Reader) (*Candidate, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return nil, err
	}
	// the signed consent is the proof: replacing it (the old file goes) is for roles that may delete candidates
	if c.consentStored != "" && !actor.Can(workflow.PermCVDelete) {
		return nil, apperr.Forbidden("A signed consent is already attached; only an administrator or a coordinator can replace it")
	}
	name := files.CleanFileName(fileName)
	ext := files.Ext(name)
	mime, ok := files.MimeFor(ext, false)
	if name == "" || !ok || !consentExt[ext] {
		return nil, apperr.New(415, "unsupported_file", "The consent must be a PDF, PNG, JPG or DOCX file")
	}
	rel, _, _, err := s.storeFile(body, ext, id+"-consent-"+fmt.Sprint(time.Now().Unix()))
	if err != nil {
		return nil, err
	}
	old := c.consentStored
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE candidates SET consent_file_name = $2, consent_stored_name = $3, consent_mime = $4,
			updated_at = now() WHERE id = $1`, id, name, rel, mime); err != nil {
			return err
		}
		if c, err = s.get(ctx, tx, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate.consent", "candidate", id, map[string]any{"code": c.Code}))
	})
	if err != nil {
		_ = os.Remove(s.pathFor(rel))
		return nil, err
	}
	if old != "" {
		_ = os.Remove(s.pathFor(old))
	}
	return c, nil
}

// Delete removes the candidate for good: the row with the profile and text,
// the CV, the consent and the diplomas and certificates. The audit log keeps
// only the code. Backups still hold the data until they rotate out.
func (s *Service) Delete(ctx context.Context, actor workflow.Actor, id string) error {
	if err := actor.Require(workflow.PermCVDelete); err != nil {
		return err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return err
	}
	stored := []string{c.storedName, c.consentStored}
	// earlier CV files of this candidate, kept when a new upload replaced them
	if rows, err := s.pool.Query(ctx, `SELECT details->>'previous_file' FROM audit_log
		WHERE action = 'candidate.replace' AND entity_id = $1 AND details ? 'previous_file'`, id); err == nil {
		if prev, err := pgx.CollectRows(rows, pgx.RowTo[string]); err == nil {
			stored = append(stored, prev...)
		}
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `DELETE FROM candidate_documents WHERE candidate_id = $1 RETURNING stored_name`, id)
		if err != nil {
			return err
		}
		docs, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		stored = append(stored, docs...)
		if _, err := tx.Exec(ctx, `DELETE FROM candidates WHERE id = $1`, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate.delete", "candidate", id,
			map[string]any{"code": c.Code, "documents": len(docs)}))
	})
	if err != nil {
		return err
	}
	for _, rel := range stored {
		s.removeFile(rel)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Files and text (personal data: cv.manage only, every access is logged)
// ---------------------------------------------------------------------------

// OpenFile returns the CV (consent=false) or the signed consent for download.
func (s *Service) OpenFile(ctx context.Context, actor workflow.Actor, id string, consent bool) (*Candidate, string, string, *os.File, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, "", "", nil, err
	}
	c, err := s.get(ctx, s.pool, id)
	if err != nil {
		return nil, "", "", nil, err
	}
	rel, name, mime := c.storedName, c.FileName, c.Mime
	if consent {
		if c.consentStored == "" {
			return nil, "", "", nil, apperr.NotFound("No signed consent is stored for this candidate")
		}
		rel, name, mime = c.consentStored, c.consentName, c.consentMime
	}
	f, err := os.Open(s.pathFor(rel))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", "", nil, apperr.NotFound("The file is missing from storage")
		}
		return nil, "", "", nil, err
	}
	action := "candidate.download"
	if consent {
		action = "candidate.consent_download"
	}
	if err := audit.Write(ctx, s.pool, audit.FromActor(actor, action, "candidate", id, map[string]any{"code": c.Code})); err != nil {
		f.Close()
		return nil, "", "", nil, err
	}
	return c, name, mime, f, nil
}

// Text returns the extracted (or recognised) text of the CV.
func (s *Service) Text(ctx context.Context, actor workflow.Actor, id string) (string, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return "", err
	}
	if !db.IsUUID(id) {
		return "", errNotFound
	}
	var text string
	err := s.pool.QueryRow(ctx, `SELECT coalesce(cv_text, '') FROM candidates WHERE id = $1`, id).Scan(&text)
	if db.IsNoRows(err) {
		return "", errNotFound
	}
	return text, err
}

func (s *Service) pathFor(rel string) string {
	p := filepath.Join(s.root, filepath.FromSlash(rel))
	if !strings.HasPrefix(p, s.root+string(os.PathSeparator)) {
		return filepath.Join(s.root, "invalid")
	}
	return p
}

// ---------------------------------------------------------------------------
// Background parsing
// ---------------------------------------------------------------------------

func (s *Service) enqueue(id string) {
	select {
	case s.queue <- id:
	default: // picked up by the next rescan
	}
}

// Run parses pending CVs and documents one at a time (OCR is memory-hungry)
// and rescans every 5 minutes, which also resumes work interrupted by a
// restart and deletes documents left without a candidate for too long.
func (s *Service) Run(ctx context.Context) {
	s.rescan(ctx)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-s.queue:
			if id, ok := isDocJob(job); ok {
				s.processDocument(ctx, id)
			} else {
				s.process(ctx, job)
			}
		case <-ticker.C:
			s.rescan(ctx)
		}
	}
}

func (s *Service) rescan(ctx context.Context) {
	s.expireDocuments(ctx)
	rows, err := s.pool.Query(ctx, `(SELECT id::text FROM candidates WHERE status = 'pending' ORDER BY created_at LIMIT 200)
		UNION ALL (SELECT '`+docQueuePrefix+`' || id FROM candidate_documents WHERE status = 'pending' ORDER BY created_at LIMIT 200)`)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("cv rescan failed", "error", err.Error())
		}
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return
	}
	for _, id := range ids {
		s.enqueue(id)
	}
}

// processingMark is kept in error while a CV or a document is being read. A
// pending one that still has it after a restart took the process down (out of
// memory, a crash): it fails instead of being read again on every start, so
// one hostile file cannot keep the portal in a crash loop.
const processingMark = "processing"

// claim marks a pending CV or document as being read; false when it was
// already being read when the portal stopped (then it is marked failed).
func (s *Service) claim(ctx context.Context, table, id string) bool {
	var prev string
	if err := s.pool.QueryRow(ctx, `SELECT error FROM `+table+` WHERE id = $1 AND status = 'pending'`, id).Scan(&prev); err != nil {
		return false
	}
	if prev == processingMark {
		s.log.Warn("file skipped: its last reading did not finish", "table", table, "id", id)
		_, _ = s.pool.Exec(ctx, `UPDATE `+table+` SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`,
			id, "The file could not be read: its last reading stopped the server")
		return false
	}
	_, err := s.pool.Exec(ctx, `UPDATE `+table+` SET error = $2 WHERE id = $1 AND status = 'pending'`, id, processingMark)
	return err == nil
}

// unclaim: the portal is stopping in the middle of a reading - pending again, without the mark (this was no crash).
func (s *Service) unclaim(table, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.pool.Exec(ctx, `UPDATE `+table+` SET error = '' WHERE id = $1 AND status = 'pending' AND error = $2`, id, processingMark)
}

func (s *Service) process(ctx context.Context, id string) {
	var stored, name string
	var fresh bool // a new upload, not a new parse of a candidate's CV
	if err := s.pool.QueryRow(ctx, `SELECT stored_name, file_name, profile IS NULL FROM candidates WHERE id = $1 AND status = 'pending'`, id).
		Scan(&stored, &name, &fresh); err != nil {
		return // already processed or deleted
	}
	if !s.claim(ctx, "candidates", id) {
		return
	}
	start := time.Now()
	text, ocr, err := extractCV(ctx, s.tmp, s.pathFor(stored), files.Ext(name))
	if err == nil && letters(text) == 0 {
		err = errors.New("no text was found in the file")
	}
	var profile json.RawMessage
	if err == nil {
		profile, err = s.engine.Parse(ctx, text, ocr)
	}
	if err == nil {
		// attached diplomas and certificates survive a new parse of the CV
		// ponytail: a document attached while this CV is parsed is applied on its next sync, not here.
		var docs []map[string]any
		if docs, err = candidateDocs(ctx, s.pool, id); err == nil && len(docs) > 0 {
			profile, err = s.engine.ApplyDocuments(ctx, profile, docs)
		}
	}
	if ctx.Err() != nil {
		s.unclaim("candidates", id) // shutting down: stays pending
		return
	}
	if err != nil {
		msg := err.Error()
		if r := []rune(msg); len(r) > 500 {
			msg = string(r[:500])
		}
		_, _ = s.pool.Exec(ctx, `UPDATE candidates SET status = 'failed', error = $2, ocr = $3, cv_text = $4, updated_at = now()
			WHERE id = $1 AND status = 'pending'`, id, msg, ocr, nullText(text))
		s.log.Warn("cv parsing failed", "candidate_id", id, "error", msg)
		return
	}
	if fresh {
		// the same person uploaded again: the new CV goes onto the existing candidate
		target, by, err := s.samePerson(ctx, id, profile)
		if err == nil && target != "" {
			err = s.replaceCV(ctx, id, target, by, text, ocr, profile)
		}
		if err == nil && target != "" {
			s.log.Info("cv replaced an existing candidate's cv", "upload_id", id, "candidate_id", target, "by", by)
			s.rematchDocuments(ctx)
			return
		}
		if err != nil {
			s.log.Error("same-person check failed, kept as a new candidate", "candidate_id", id, "error", err.Error())
		}
	}
	var p struct {
		Basics struct {
			Name string `json:"name"`
		} `json:"basics"`
	}
	_ = json.Unmarshal(profile, &p)
	var storedName, prevParsed string
	if err := s.pool.QueryRow(ctx, `SELECT full_name, coalesce(profile->'basics'->>'name', '') FROM candidates WHERE id = $1`, id).Scan(&storedName, &prevParsed); err != nil {
		s.log.Error("cv profile not stored", "candidate_id", id, "error", err.Error())
		return
	}
	if _, err := s.pool.Exec(ctx, `UPDATE candidates SET status = 'ready', error = '', ocr = $2, cv_text = $3, profile = $4,
		full_name = $5, updated_at = now()
		WHERE id = $1 AND status = 'pending'`, id, ocr, text, []byte(profile), nameAfterParse(storedName, prevParsed, truncate(p.Basics.Name, 200))); err != nil {
		s.log.Error("cv profile not stored", "candidate_id", id, "error", err.Error())
		return
	}
	s.log.Info("cv parsed", "candidate_id", id, "ocr", ocr, "chars", utf8.RuneCountInString(text),
		"duration_ms", time.Since(start).Milliseconds())
	s.rematchDocuments(ctx) // documents uploaded before this CV may be its candidate's
}

// samePerson looks the person of a newly parsed CV up among the other candidates.
func (s *Service) samePerson(ctx context.Context, id string, profile json.RawMessage) (string, string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, coalesce(nullif(full_name, ''), profile->'basics'->>'name', ''),
		coalesce(profile->'basics'->>'email', ''), coalesce(profile->'basics'->>'phone', '')
		FROM candidates WHERE id <> $1 AND status <> 'pending'`, id)
	if err != nil {
		return "", "", err
	}
	cands, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (namedCandidate, error) {
		var c namedCandidate
		err := row.Scan(&c.ID, &c.Name, &c.Email, &c.Phone)
		return c, err
	})
	if err != nil || len(cands) == 0 {
		return "", "", err
	}
	return s.engine.SamePerson(ctx, profile, cands)
}

// replaceCV puts a newly parsed CV onto the candidate it belongs to. The
// candidate keeps its code, name and documents (and its referral unless the
// upload names one); it gets the new file, text and profile (manual edits and
// translations of the old profile go) and the newer consent date.
func (s *Service) replaceCV(ctx context.Context, uploadID, targetID, by, text string, ocr bool, profile json.RawMessage) error {
	var oldStored, newStored, uploader string
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		var fileName, mime, sum, note, referral string
		var size int64
		var consent time.Time
		var uploadNumber, targetNumber int
		if err := tx.QueryRow(ctx, `SELECT file_name, stored_name, mime, size, sha256, consent_date, consent_note, referred_by, number, uploaded_by
			FROM candidates WHERE id = $1 AND status = 'pending' FOR UPDATE`, uploadID).
			Scan(&fileName, &newStored, &mime, &size, &sum, &consent, &note, &referral, &uploadNumber, &uploader); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT stored_name, number FROM candidates WHERE id = $1 FOR UPDATE`, targetID).
			Scan(&oldStored, &targetNumber); err != nil {
			return err
		}
		docs, err := candidateDocs(ctx, tx, targetID)
		if err != nil {
			return err
		}
		if len(docs) > 0 {
			if profile, err = s.engine.ApplyDocuments(ctx, profile, docs); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM candidates WHERE id = $1`, uploadID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE candidates SET file_name = $2, stored_name = $3, mime = $4, size = $5, sha256 = $6,
			cv_text = $7, profile = $8, ocr = $9, status = 'ready', error = '', consent_date = GREATEST(consent_date, $10),
			consent_note = CASE WHEN $11 <> '' THEN $11 ELSE consent_note END,
			referred_by = CASE WHEN $12 <> '' THEN $12 ELSE referred_by END, translations = NULL, updated_at = now()
			WHERE id = $1`, targetID, fileName, newStored, mime, size, sum, text, []byte(profile), ocr, consent, note, referral); err != nil {
			return err
		}
		// the previous CV file is kept (an upload by anyone with cv.manage replaces it, and the match may be wrong):
		// the audit entry names it and who uploaded the new one, so an administrator can put it back; deleting the
		// candidate removes it too
		return audit.Write(ctx, tx, audit.Entry{UserID: uploader, Action: "candidate.replace", EntityType: "candidate", EntityID: targetID,
			Details: map[string]any{"code": Code(targetNumber), "upload": Code(uploadNumber), "by": by, "previous_file": oldStored},
			Via:     workflow.ViaSystem})
	})
	return err
}

func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}
