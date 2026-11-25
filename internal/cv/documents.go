package cv

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/audit"
	"onceplatform/internal/db"
	"onceplatform/internal/files"
	"onceplatform/internal/workflow"
)

// Document is a candidate's diploma or certificate. Info is what the engine
// read from it (kind, holder, issuer, title, date, expires, number; institution,
// area and degree of a diploma) with the suggested candidates when the holder
// was not found unambiguously. Documents are personal data: cv.manage only.
type Document struct {
	ID             string          `json:"id"`
	CandidateID    string          `json:"candidate_id,omitempty"`
	CandidateCode  string          `json:"candidate_code,omitempty"`
	CandidateName  string          `json:"candidate_name,omitempty"`
	FileName       string          `json:"file_name"`
	Mime           string          `json:"mime"`
	Size           int64           `json:"size"`
	Status         string          `json:"status"`
	Error          string          `json:"error,omitempty"`
	OCR            bool            `json:"ocr"`
	Info           json.RawMessage `json:"info"`
	Assigned       string          `json:"assigned,omitempty"`
	UploadedByName string          `json:"uploaded_by_name"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
	DeleteAfter    *time.Time      `json:"delete_after,omitempty"`

	storedName string
}

// unassignedDays is how long a document without a candidate is kept: without
// the candidate's CV there is no consent to hold it.
const unassignedDays = 30

// docQueuePrefix marks documents in the parsing queue (one worker: OCR is memory-hungry).
const docQueuePrefix = "doc:"

const documentSelect = `
	SELECT d.id, coalesce(d.candidate_id::text, ''), coalesce(c.number, 0), coalesce(c.full_name, ''), d.file_name, d.stored_name,
	       d.mime, d.size, d.status, d.error, d.ocr, d.info, d.assigned, u.full_name, d.created_at, d.updated_at
	FROM candidate_documents d JOIN users u ON u.id = d.uploaded_by LEFT JOIN candidates c ON c.id = d.candidate_id`

func scanDocument(row pgx.Row) (*Document, error) {
	var d Document
	var number int
	var info []byte
	if err := row.Scan(&d.ID, &d.CandidateID, &number, &d.CandidateName, &d.FileName, &d.storedName, &d.Mime, &d.Size,
		&d.Status, &d.Error, &d.OCR, &info, &d.Assigned, &d.UploadedByName, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return nil, err
	}
	d.Info = info
	if number > 0 {
		d.CandidateCode = Code(number)
	} else {
		t := d.CreatedAt.AddDate(0, 0, unassignedDays)
		d.DeleteAfter = &t
	}
	return &d, nil
}

func (s *Service) queryDocuments(ctx context.Context, q db.Querier, where string, args ...any) ([]Document, error) {
	rows, err := q.Query(ctx, documentSelect+` WHERE `+where+` ORDER BY d.created_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

var errDocNotFound = apperr.NotFound("Document not found")

func (s *Service) getDocument(ctx context.Context, q db.Querier, id string) (*Document, error) {
	if !db.IsUUID(id) {
		return nil, errDocNotFound
	}
	d, err := scanDocument(q.QueryRow(ctx, documentSelect+` WHERE d.id = $1`, id))
	if db.IsNoRows(err) {
		return nil, errDocNotFound
	}
	return d, err
}

// ListDocuments returns the documents waiting for a candidate and those
// uploaded during the last day (so the uploader sees where they went).
func (s *Service) ListDocuments(ctx context.Context, actor workflow.Actor) ([]Document, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	return s.queryDocuments(ctx, s.pool, `d.candidate_id IS NULL OR d.created_at > now() - interval '1 day'`)
}

// UploadDocument stores a diploma or certificate and schedules its recognition.
func (s *Service) UploadDocument(ctx context.Context, actor workflow.Actor, fileName string, body io.Reader) (*Document, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	name := files.CleanFileName(fileName)
	ext := files.Ext(name)
	mime, ok := files.MimeFor(ext, false)
	if name == "" || !ok || !cvExt[ext] {
		return nil, apperr.New(415, "unsupported_file", "A document must be a PDF, DOCX, TXT, PNG or JPG file")
	}
	if err := s.checkQuota(ctx, actor); err != nil {
		return nil, err
	}
	id, err := db.NewUUID()
	if err != nil {
		return nil, err
	}
	rel, size, sum, err := s.storeFile(body, ext, "doc-"+id)
	if err != nil {
		return nil, err
	}
	var number *int
	if err := s.pool.QueryRow(ctx, `SELECT c.number FROM candidate_documents d LEFT JOIN candidates c ON c.id = d.candidate_id
		WHERE d.sha256 = $1`, sum).Scan(&number); err == nil {
		_ = os.Remove(s.pathFor(rel))
		if number != nil {
			return nil, errAlreadyUploaded("Already attached to " + Code(*number))
		}
		return nil, errAlreadyUploaded("Already uploaded: waiting in Documents to check")
	}
	var d *Document
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO candidate_documents (id, file_name, stored_name, mime, size, sha256, uploaded_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, id, name, rel, mime, size, sum, actor.UserID); err != nil {
			return err
		}
		if d, err = s.getDocument(ctx, tx, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate_document.upload", "candidate_document", id,
			map[string]any{"size": size, "format": ext}))
	})
	if err != nil {
		_ = os.Remove(s.pathFor(rel))
		if db.IsUniqueViolation(err) {
			return nil, errAlreadyUploaded("Already uploaded")
		}
		return nil, err
	}
	s.enqueue(docQueuePrefix + id)
	return d, nil
}

// AssignDocument attaches the document to a candidate chosen by hand (or moves
// it from a wrongly chosen one).
func (s *Service) AssignDocument(ctx context.Context, actor workflow.Actor, id, candidateID string) (*Document, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	d, err := s.getDocument(ctx, s.pool, id)
	if err != nil {
		return nil, err
	}
	if d.Status == "pending" {
		return nil, apperr.Conflict("The document is still being recognised")
	}
	c, err := s.get(ctx, s.pool, candidateID)
	if err != nil {
		return nil, err
	}
	entry := audit.FromActor(actor, "candidate_document.assign", "candidate_document", id, map[string]any{"code": c.Code, "how": "manual"})
	if err := s.attach(ctx, id, c.ID, "manual", entry); err != nil {
		return nil, err
	}
	return s.getDocument(ctx, s.pool, id)
}

// ReprocessDocument recognises the document again (e.g. after an engine
// update); an attached document keeps its candidate.
func (s *Service) ReprocessDocument(ctx context.Context, actor workflow.Actor, id string) (*Document, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, err
	}
	d, err := s.getDocument(ctx, s.pool, id)
	if err != nil || d.Status == "pending" {
		return d, err
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE candidate_documents SET status = 'pending', error = '', updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate_document.reprocess", "candidate_document", id,
			map[string]any{"code": d.CandidateCode}))
	})
	if err != nil {
		return nil, err
	}
	s.enqueue(docQueuePrefix + id)
	return s.getDocument(ctx, s.pool, id)
}

// DeleteDocument removes the document (row and file) and its marks in the
// profile - for good, so only roles that may delete candidates may do it.
func (s *Service) DeleteDocument(ctx context.Context, actor workflow.Actor, id string) error {
	if err := actor.Require(workflow.PermCVDelete); err != nil {
		return err
	}
	d, err := s.getDocument(ctx, s.pool, id)
	if err != nil {
		return err
	}
	err = db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM candidate_documents WHERE id = $1`, id); err != nil {
			return err
		}
		if d.CandidateID != "" {
			if err := s.syncProfile(ctx, tx, d.CandidateID); err != nil {
				return err
			}
		}
		return audit.Write(ctx, tx, audit.FromActor(actor, "candidate_document.delete", "candidate_document", id,
			map[string]any{"code": d.CandidateCode}))
	})
	if err != nil {
		return err
	}
	s.removeFile(d.storedName)
	return nil
}

// OpenDocument returns the document file for download (every access is logged).
func (s *Service) OpenDocument(ctx context.Context, actor workflow.Actor, id string) (*Document, *os.File, error) {
	if err := actor.Require(workflow.PermCVManage); err != nil {
		return nil, nil, err
	}
	d, err := s.getDocument(ctx, s.pool, id)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(s.pathFor(d.storedName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, apperr.NotFound("The file is missing from storage")
		}
		return nil, nil, err
	}
	if err := audit.Write(ctx, s.pool, audit.FromActor(actor, "candidate_document.download", "candidate_document", id,
		map[string]any{"code": d.CandidateCode})); err != nil {
		f.Close()
		return nil, nil, err
	}
	return d, f, nil
}

func (s *Service) removeFile(rel string) {
	if rel == "" {
		return
	}
	if err := os.Remove(s.pathFor(rel)); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.log.Error("cv file not removed", "file", rel, "error", err.Error())
	}
}

// ---------------------------------------------------------------------------
// Recognition and the candidate's profile
// ---------------------------------------------------------------------------

// processDocument recognises a pending document and attaches it when its
// holder is exactly one candidate.
func (s *Service) processDocument(ctx context.Context, id string) {
	var stored, name string
	if err := s.pool.QueryRow(ctx, `SELECT stored_name, file_name FROM candidate_documents WHERE id = $1 AND status = 'pending'`, id).
		Scan(&stored, &name); err != nil {
		return // already processed or deleted
	}
	if !s.claim(ctx, "candidate_documents", id) {
		return
	}
	text, ocr, err := extractCV(ctx, s.tmp, s.pathFor(stored), files.Ext(name))
	if err == nil && letters(text) == 0 {
		err = errors.New("no text was found in the file")
	}
	var r *docReading
	if err == nil {
		var cands []namedCandidate
		if cands, err = s.namedCandidates(ctx); err == nil {
			r, err = s.engine.ReadDocument(ctx, text, cands)
		}
	}
	if ctx.Err() != nil {
		s.unclaim("candidate_documents", id) // shutting down: stays pending
		return
	}
	if err != nil {
		msg := truncate(err.Error(), 500)
		_, _ = s.pool.Exec(ctx, `UPDATE candidate_documents SET status = 'failed', error = $2, ocr = $3, doc_text = $4, updated_at = now()
			WHERE id = $1 AND status = 'pending'`, id, msg, ocr, nullText(text))
		s.log.Warn("document recognition failed", "document_id", id, "error", msg)
		return
	}
	if err := s.saveReading(ctx, id, r, &recognised{ocr, text}); err != nil {
		s.log.Error("document not stored", "document_id", id, "error", err.Error())
		return
	}
	s.log.Info("document recognised", "document_id", id, "ocr", ocr, "matched", r.Match != nil)
}

type recognised struct {
	ocr  bool
	text string
}

// saveReading stores what the engine read (with the text of a newly recognised
// document) and attaches the document when its holder is sure, in one step:
// the document never shows up unassigned in between.
func (s *Service) saveReading(ctx context.Context, id string, r *docReading, rec *recognised) error {
	r.Info["suggestions"] = r.Suggestions
	if r.Match != nil {
		r.Info["matched_by"] = r.Match.By
	}
	info, _ := json.Marshal(r.Info)
	var removed []string
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		var current string // a document read again keeps the candidate it is attached to
		if err := tx.QueryRow(ctx, `SELECT coalesce(candidate_id::text, '') FROM candidate_documents WHERE id = $1 FOR UPDATE`, id).Scan(&current); err != nil {
			if db.IsNoRows(err) {
				return nil // deleted meanwhile
			}
			return err
		}
		var tag interface{ RowsAffected() int64 }
		var err error
		if rec != nil {
			tag, err = tx.Exec(ctx, `UPDATE candidate_documents SET status = 'ready', error = '', ocr = $2, doc_text = $3, info = $4,
				updated_at = now() WHERE id = $1 AND status = 'pending'`, id, rec.ocr, rec.text, info)
		} else {
			tag, err = tx.Exec(ctx, `UPDATE candidate_documents SET info = $2, updated_at = now() WHERE id = $1 AND candidate_id IS NULL`, id, info)
		}
		if err != nil || tag.RowsAffected() == 0 {
			return err // deleted or attached by hand meanwhile
		}
		if current != "" {
			return s.syncProfile(ctx, tx, current)
		}
		if r.Match == nil {
			return nil // nobody fits: it waits in "Documents to check"
		}
		var number int
		if err := tx.QueryRow(ctx, `SELECT number FROM candidates WHERE id = $1`, r.Match.ID).Scan(&number); err != nil {
			return err
		}
		removed, err = s.attachTx(ctx, tx, id, r.Match.ID, "auto", audit.Entry{Action: "candidate_document.assign", EntityType: "candidate_document",
			EntityID: id, Details: map[string]any{"code": Code(number), "how": "auto"}, Via: workflow.ViaSystem})
		return err
	})
	if err == nil { // committed: the replaced copies' files can go
		for _, rel := range removed {
			s.removeFile(rel)
		}
	}
	return err
}

// rematchDocuments looks the holders of the unassigned documents up again
// after a new CV was parsed (documents uploaded before their CV).
func (s *Service) rematchDocuments(ctx context.Context) {
	// the 50 newest: every CV parse waits for this, and a pile of junk "diplomas" must not stall the CV queue
	// (unassigned documents expire after 30 days anyway)
	rows, err := s.pool.Query(ctx, `SELECT id, doc_text FROM candidate_documents
		WHERE candidate_id IS NULL AND status = 'ready' AND doc_text IS NOT NULL ORDER BY created_at DESC LIMIT 50`)
	if err != nil {
		return
	}
	type pending struct{ id, text string }
	docs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pending, error) {
		var d pending
		err := row.Scan(&d.id, &d.text)
		return d, err
	})
	if err != nil || len(docs) == 0 {
		return
	}
	cands, err := s.namedCandidates(ctx)
	if err != nil {
		return
	}
	for _, d := range docs {
		r, err := s.engine.ReadDocument(ctx, d.text, cands)
		if err == nil {
			err = s.saveReading(ctx, d.id, r, nil)
		}
		if err != nil && ctx.Err() == nil {
			s.log.Error("document not rematched", "document_id", d.id, "error", err.Error())
		}
	}
}

// namedCandidates are the candidates the holder of a document is looked up among.
func (s *Service) namedCandidates(ctx context.Context) ([]namedCandidate, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, full_name FROM candidates WHERE full_name <> ''`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (namedCandidate, error) {
		var c namedCandidate
		err := row.Scan(&c.ID, &c.Name)
		return c, err
	})
}

// attach links the document to the candidate and brings the profiles of the
// new and of a previous candidate up to date.
func (s *Service) attach(ctx context.Context, id, candidateID, how string, entry audit.Entry) error {
	var removed []string
	err := db.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		removed, err = s.attachTx(ctx, tx, id, candidateID, how, entry)
		return err
	})
	if err == nil {
		for _, rel := range removed {
			s.removeFile(rel)
		}
	}
	return err
}

// attachTx returns the files of the older copies it replaced, to be removed
// once the transaction is committed.
func (s *Service) attachTx(ctx context.Context, tx pgx.Tx, id, candidateID, how string, entry audit.Entry) ([]string, error) {
	var prev string
	if err := tx.QueryRow(ctx, `SELECT coalesce(candidate_id::text, '') FROM candidate_documents WHERE id = $1 FOR UPDATE`, id).Scan(&prev); err != nil {
		if db.IsNoRows(err) {
			return nil, errDocNotFound
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE candidate_documents SET candidate_id = $2, assigned = $3, updated_at = now() WHERE id = $1`,
		id, candidateID, how); err != nil {
		return nil, err
	}
	// a newer copy of the same paper (same key: kind and title, or degree and institution) replaces the older ones
	rows, err := tx.Query(ctx, `DELETE FROM candidate_documents o USING candidate_documents d
		WHERE d.id = $1 AND o.candidate_id = $2 AND o.id <> d.id AND d.info->>'key' IS NOT NULL
		  AND o.info->>'key' = d.info->>'key' AND o.created_at < d.created_at
		RETURNING o.id, o.stored_name`, id, candidateID)
	if err != nil {
		return nil, err
	}
	type old struct{ id, stored string }
	replaced, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (old, error) {
		var o old
		err := row.Scan(&o.id, &o.stored)
		return o, err
	})
	if err != nil {
		return nil, err
	}
	var removed []string
	for _, o := range replaced {
		removed = append(removed, o.stored)
		if err := audit.Write(ctx, tx, audit.Entry{Action: "candidate_document.replace", EntityType: "candidate_document", EntityID: o.id,
			Details: map[string]any{"by": id}, UserID: entry.UserID, Via: entry.Via, IP: entry.IP}); err != nil {
			return nil, err
		}
	}
	if prev != "" && prev != candidateID {
		if err := s.syncProfile(ctx, tx, prev); err != nil {
			return nil, err
		}
	}
	if err := s.syncProfile(ctx, tx, candidateID); err != nil {
		return nil, err
	}
	return removed, audit.Write(ctx, tx, entry)
}

// candidateDocs are the recognised documents of a candidate as the engine takes them.
func candidateDocs(ctx context.Context, q db.Querier, candidateID string) ([]map[string]any, error) {
	rows, err := q.Query(ctx, `SELECT id, coalesce(info, '{}') FROM candidate_documents
		WHERE candidate_id = $1 AND status = 'ready' ORDER BY created_at`, candidateID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (map[string]any, error) {
		var id string
		var info []byte
		if err := row.Scan(&id, &info); err != nil {
			return nil, err
		}
		m := map[string]any{}
		_ = json.Unmarshal(info, &m)
		delete(m, "suggestions")
		m["id"] = id
		return m, nil
	})
}

// syncProfile re-applies the candidate's documents to its profile. A CV that
// is being parsed gets them when its parsing finishes.
func (s *Service) syncProfile(ctx context.Context, tx pgx.Tx, candidateID string) error {
	var profile []byte
	var status string
	if err := tx.QueryRow(ctx, `SELECT profile, status FROM candidates WHERE id = $1 FOR UPDATE`, candidateID).Scan(&profile, &status); err != nil {
		return err
	}
	if status == "pending" {
		return nil
	}
	docs, err := candidateDocs(ctx, tx, candidateID)
	if err != nil {
		return err
	}
	if len(profile) == 0 && len(docs) == 0 {
		return nil
	}
	next, err := s.engine.ApplyDocuments(ctx, profile, docs)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE candidates SET profile = $2, updated_at = now() WHERE id = $1`, candidateID, []byte(next))
	return err
}

// expireDocuments deletes the documents left without a candidate for unassignedDays.
func (s *Service) expireDocuments(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `DELETE FROM candidate_documents WHERE candidate_id IS NULL
		AND created_at < now() - make_interval(days => $1) RETURNING id, stored_name`, unassignedDays)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("documents not expired", "error", err.Error())
		}
		return
	}
	type gone struct{ id, stored string }
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (gone, error) {
		var g gone
		err := row.Scan(&g.id, &g.stored)
		return g, err
	})
	if err != nil {
		return
	}
	for _, g := range list {
		s.removeFile(g.stored)
		_ = audit.Write(ctx, s.pool, audit.Entry{Action: "candidate_document.expire", EntityType: "candidate_document", EntityID: g.id,
			Details: map[string]any{"days": unassignedDays}, Via: workflow.ViaSystem})
	}
}

// isDocJob tells documents from CVs in the parsing queue.
func isDocJob(job string) (string, bool) { return strings.CutPrefix(job, docQueuePrefix) }
