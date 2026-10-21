package files

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/workflow"
)

// Attachment is file metadata (the extracted text is not included).
type Attachment struct {
	ID               string    `json:"id"`
	TicketID         string    `json:"ticket_id"`
	TicketNumber     string    `json:"ticket_number"`
	OriginalName     string    `json:"original_name"`
	Mime             string    `json:"mime"`
	Size             int64     `json:"size"`
	SHA256           string    `json:"sha256"`
	Category         string    `json:"category"`
	ExtractionStatus string    `json:"extraction_status"`
	ExtractionError  string    `json:"extraction_error,omitempty"`
	TextLength       int       `json:"text_length"`
	UploadedBy       string    `json:"uploaded_by"`
	UploadedByName   string    `json:"uploaded_by_name"`
	Via              string    `json:"via"`
	CreatedAt        time.Time `json:"created_at"`
	storedName       string
}

// Target identifies the task an attachment belongs to.
type Target struct {
	TicketID string
}

// Service manages attachments.
type Service struct {
	pool     *pgxpool.Pool
	log      *slog.Logger
	root     string
	maxBytes int64
	loc      *time.Location

	queue    chan string
	inflight sync.Map
}

// NewService creates the file service and ensures the storage directory exists.
func NewService(pool *pgxpool.Pool, log *slog.Logger, root string, maxBytes int64, loc *time.Location) (*Service, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(abs, "tmp"), 0o750); err != nil {
		return nil, fmt.Errorf("storage path %s: %w", abs, err)
	}
	return &Service{pool: pool, log: log, root: abs, maxBytes: maxBytes, loc: loc, queue: make(chan string, 1000)}, nil
}

// MaxBytes returns the per-file upload limit.
func (s *Service) MaxBytes() int64 { return s.maxBytes }

const attachmentSelect = `
	SELECT a.id, a.ticket_id, t.number, a.original_name, a.stored_name, a.mime, a.size, a.sha256,
	       a.category, a.extraction_status, a.extraction_error, coalesce(char_length(a.extracted_text), 0),
	       a.uploaded_by, u.full_name, a.via, a.created_at
	FROM attachments a
	JOIN users u ON u.id = a.uploaded_by
	JOIN tickets t ON t.id = a.ticket_id`

// visible restricts to non-deleted attachments whose owner is not deleted.
const visible = ` a.deleted_at IS NULL AND t.deleted_at IS NULL`

func scanAttachment(row pgx.Row) (*Attachment, error) {
	var a Attachment
	err := row.Scan(&a.ID, &a.TicketID, &a.TicketNumber, &a.OriginalName, &a.storedName, &a.Mime,
		&a.Size, &a.SHA256, &a.Category, &a.ExtractionStatus, &a.ExtractionError, &a.TextLength,
		&a.UploadedBy, &a.UploadedByName, &a.Via, &a.CreatedAt)
	return &a, err
}

var errNotFound = apperr.NotFound("File not found")

// Get returns attachment metadata.
func (s *Service) Get(ctx context.Context, id string) (*Attachment, error) {
	if !db.IsUUID(id) {
		return nil, errNotFound
	}
	a, err := scanAttachment(s.pool.QueryRow(ctx, attachmentSelect+` WHERE a.id = $1 AND`+visible, id))
	if db.IsNoRows(err) {
		return nil, errNotFound
	}
	return a, err
}

// List returns attachments of a task, newest first.
func (s *Service) List(ctx context.Context, target Target) ([]Attachment, error) {
	rows, err := s.pool.Query(ctx, attachmentSelect+` WHERE a.ticket_id = $1 AND`+visible+` ORDER BY a.created_at DESC`, target.TicketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attachment{}
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// UploadInput describes a file to store.
type UploadInput struct {
	Target   Target
	Name     string
	Category string
	Body     io.Reader
	// AllowMCPTypes additionally accepts .html (documents written by Claude).
	AllowMCPTypes bool
	// MaxBytes overrides the default per-file limit when smaller.
	MaxBytes int64
}

// Upload validates and stores a file and schedules text extraction.
func (s *Service) Upload(ctx context.Context, actor workflow.Actor, in UploadInput) (*Attachment, error) {
	if err := actor.Require(workflow.PermFilesComments); err != nil {
		return nil, err
	}
	name := CleanFileName(in.Name)
	if name == "" {
		return nil, apperr.Validation("The file name is missing")
	}
	ext := Ext(name)
	mime, ok := MimeFor(ext, in.AllowMCPTypes)
	if !ok {
		return nil, apperr.New(415, "unsupported_file",
			"This file type is not allowed. Allowed: "+strings.Join(AllowedExtensions(), ", "))
	}
	category := in.Category
	if category == "" {
		category = "other"
	}
	if !ValidCategory(category) {
		return nil, apperr.Validationf("Unknown file category %q (allowed: %s)", category, strings.Join(Categories, ", "))
	}
	limit := s.maxBytes
	if in.MaxBytes > 0 && in.MaxBytes < limit {
		limit = in.MaxBytes
	}

	// Check the owner exists before receiving the body.
	var number string
	if err := s.pool.QueryRow(ctx, `SELECT number FROM tickets WHERE id = $1 AND deleted_at IS NULL`, in.Target.TicketID).
		Scan(&number); err != nil {
		if db.IsNoRows(err) {
			return nil, apperr.NotFound("Task not found")
		}
		return nil, err
	}

	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "upload-*")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hasher), io.LimitReader(in.Body, limit+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		cleanup()
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, apperr.TooLarge(fmt.Sprintf("The request exceeds the size limit (%d MB)", mbe.Limit>>20))
		}
		return nil, fmt.Errorf("receive upload: %w", err)
	}
	if n > limit {
		cleanup()
		return nil, apperr.TooLarge(fmt.Sprintf("The file exceeds the size limit (%d MB)", limit>>20))
	}
	if n == 0 {
		cleanup()
		return nil, apperr.Validation("The file is empty")
	}
	if err := checkFile(tmpName, ext); err != nil {
		cleanup()
		return nil, err
	}

	id, err := db.NewUUID()
	if err != nil {
		cleanup()
		return nil, err
	}
	now := time.Now().In(s.loc)
	rel := fmt.Sprintf("%04d/%02d/%s", now.Year(), int(now.Month()), id)
	final := s.pathFor(rel)
	if err := os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
		cleanup()
		return nil, err
	}
	if err := os.Rename(tmpName, final); err != nil {
		cleanup()
		return nil, err
	}
	_ = os.Chmod(final, 0o640)

	sum := hex.EncodeToString(hasher.Sum(nil))
	var a *Attachment
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO attachments (id, ticket_id, original_name, stored_name, mime, size, sha256,
			                         category, uploaded_by, via)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			id, in.Target.TicketID, name, rel, mime, n, sum, category, actor.UserID, string(actor.Via)); err != nil {
			return err
		}
		details := map[string]any{"name": name, "size": n, "category": category,
			"ticket_id": in.Target.TicketID, "number": number}
		if _, err := tx.Exec(ctx, `UPDATE tickets SET updated_at = now() WHERE id = $1`, in.Target.TicketID); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.FromActor(actor, "attachment.upload", "attachment", id, details)); err != nil {
			return err
		}
		a, err = scanAttachment(tx.QueryRow(ctx, attachmentSelect+` WHERE a.id = $1`, id))
		return err
	})
	if err != nil {
		_ = os.Remove(final)
		return nil, err
	}
	s.Enqueue(a.ID)
	return a, nil
}

// checkFile verifies the real content type of the stored temp file.
func checkFile(path, ext string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	head := make([]byte, 8192)
	m, _ := io.ReadFull(f, head)
	f.Close()
	head = head[:m]
	var zr *zip.Reader
	if NeedsZip(ext) {
		r, err := zip.OpenReader(path)
		if err != nil {
			return errContent(ext)
		}
		defer r.Close()
		zr = &r.Reader
	}
	return CheckContent(ext, head, zr)
}

// Open returns metadata and an open file handle for download.
func (s *Service) Open(ctx context.Context, id string) (*Attachment, *os.File, error) {
	a, err := s.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(s.pathFor(a.storedName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.log.Error("attachment file missing on disk", "attachment_id", id, "stored_name", a.storedName)
			return nil, nil, apperr.NotFound("The file is missing from storage")
		}
		return nil, nil, err
	}
	return a, f, nil
}

// TextChunk is a part of the extracted text of a file.
type TextChunk struct {
	AttachmentID     string `json:"attachment_id"`
	Name             string `json:"name"`
	ExtractionStatus string `json:"extraction_status"`
	ExtractionError  string `json:"extraction_error,omitempty"`
	Offset           int    `json:"offset"`
	Text             string `json:"text"`
	TotalLength      int    `json:"total_length"`
	NextOffset       *int   `json:"next_offset"`
}

// ReadText returns up to limit characters of extracted text starting at offset.
func (s *Service) ReadText(ctx context.Context, id string, offset, limit int) (*TextChunk, error) {
	if offset < 0 {
		offset = 0
	}
	a, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	c := &TextChunk{AttachmentID: a.ID, Name: a.OriginalName, ExtractionStatus: a.ExtractionStatus,
		ExtractionError: a.ExtractionError, Offset: offset}
	if err := s.pool.QueryRow(ctx, `
		SELECT coalesce(char_length(extracted_text), 0), coalesce(substr(extracted_text, $2 + 1, $3), '')
		FROM attachments WHERE id = $1`, id, offset, limit).Scan(&c.TotalLength, &c.Text); err != nil {
		return nil, err
	}
	if end := offset + len([]rune(c.Text)); end < c.TotalLength {
		c.NextOffset = &end
	}
	return c, nil
}

// UpdateCategory changes the category of an attachment.
func (s *Service) UpdateCategory(ctx context.Context, actor workflow.Actor, id, category string) (*Attachment, error) {
	if err := actor.Require(workflow.PermFilesComments); err != nil {
		return nil, err
	}
	if !ValidCategory(category) {
		return nil, apperr.Validationf("Unknown file category %q", category)
	}
	a, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if a.Category == category {
		return a, nil
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE attachments SET category = $2 WHERE id = $1`, id, category); err != nil {
			return err
		}
		details := map[string]any{"name": a.OriginalName, "ticket_id": a.TicketID, "number": a.TicketNumber,
			"changes": map[string]any{"category": map[string]any{"from": a.Category, "to": category}}}
		return audit.Write(ctx, tx, audit.FromActor(actor, "attachment.update", "attachment", id, details))
	})
	if err != nil {
		return nil, err
	}
	a.Category = category
	return a, nil
}

// Delete soft-deletes an attachment (admin only). The file stays on disk so
// that the deletion can be undone from a backup or by an administrator.
func (s *Service) Delete(ctx context.Context, actor workflow.Actor, id string) error {
	if err := actor.Require(workflow.PermDelete); err != nil {
		return err
	}
	a, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	return db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE attachments SET deleted_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		details := map[string]any{"name": a.OriginalName, "ticket_id": a.TicketID, "number": a.TicketNumber}
		return audit.Write(ctx, tx, audit.FromActor(actor, "attachment.delete", "attachment", id, details))
	})
}

// pathFor maps a stored relative name to an absolute path inside the storage root.
func (s *Service) pathFor(rel string) string {
	p := filepath.Join(s.root, filepath.FromSlash(rel))
	if !strings.HasPrefix(p, s.root+string(os.PathSeparator)) {
		return filepath.Join(s.root, "invalid")
	}
	return p
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
