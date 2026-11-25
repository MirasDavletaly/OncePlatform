package files

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"
)

// Enqueue schedules text extraction for an attachment. If the queue is full
// the attachment stays "pending" and is picked up by the periodic rescan.
func (s *Service) Enqueue(id string) {
	select {
	case s.queue <- id:
	default:
	}
}

// RunExtractor processes the extraction queue with the given number of
// workers and rescans for pending attachments every 5 minutes (this also
// resumes work interrupted by a restart). It blocks until ctx is cancelled.
func (s *Service) RunExtractor(ctx context.Context, workers int) {
	if workers < 1 {
		workers = 1
	}
	for i := 0; i < workers; i++ {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case id := <-s.queue:
					s.process(ctx, id)
				}
			}
		}()
	}
	s.rescan(ctx)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.rescan(ctx)
		}
	}
}

func (s *Service) rescan(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM attachments WHERE extraction_status = 'pending' AND deleted_at IS NULL
		ORDER BY created_at LIMIT 200`)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("extraction rescan failed", "error", err.Error())
		}
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		s.Enqueue(id)
	}
}

// processingMark is kept in extraction_error while a file is being read. A
// pending file that still has it after a restart took the process down (a
// stack overflow in a parser cannot be recovered): it fails instead of being
// retried, so one malicious workbook cannot keep the portal in a crash loop.
const processingMark = "processing"

func (s *Service) process(ctx context.Context, id string) {
	if _, busy := s.inflight.LoadOrStore(id, true); busy {
		return
	}
	defer s.inflight.Delete(id)

	var stored, name, prev string
	err := s.pool.QueryRow(ctx, `SELECT stored_name, original_name, extraction_error FROM attachments
		WHERE id = $1 AND extraction_status = 'pending'`, id).Scan(&stored, &name, &prev)
	if err != nil {
		return // already processed or deleted
	}
	if prev == processingMark {
		s.log.Warn("text extraction skipped: the last attempt did not finish", "attachment_id", id)
		_, _ = s.pool.Exec(ctx, `UPDATE attachments SET extraction_status = 'failed', extraction_error = $2 WHERE id = $1`,
			id, "The file could not be read (its last reading stopped the server)")
		return
	}
	if _, err := s.pool.Exec(ctx, `UPDATE attachments SET extraction_error = $2 WHERE id = $1`, id, processingMark); err != nil {
		return
	}
	start := time.Now()
	text, err := extractSafely(ctx, s.pathFor(stored), Ext(name))
	status, errMsg := "done", ""
	switch {
	case errors.Is(err, ErrUnsupported):
		status, text = "unsupported", ""
	case err != nil:
		if ctx.Err() != nil {
			// shutting down: pending again for the next start, without the mark (this was no crash)
			bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = s.pool.Exec(bg, `UPDATE attachments SET extraction_error = '' WHERE id = $1`, id)
			return
		}
		status, text, errMsg = "failed", "", truncateString(err.Error(), 500)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE attachments SET extracted_text = $2, extraction_status = $3, extraction_error = $4
		WHERE id = $1`, id, nullIfEmpty(text, status), status, errMsg); err != nil {
		if ctx.Err() == nil {
			s.log.Error("store extracted text failed", "attachment_id", id, "error", err.Error())
		}
		return
	}
	s.log.Info("text extracted", "attachment_id", id, "status", status, "chars", utf8.RuneCountInString(text),
		"duration_ms", time.Since(start).Milliseconds(), "error", errMsg)
}

// extractSafely turns a parser panic into an error: the worker runs outside
// any HTTP recoverer, and an uncaught panic would stop the whole portal.
func extractSafely(ctx context.Context, path, ext string) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("the file could not be read: %v", r)
		}
	}()
	return ExtractText(ctx, path, ext)
}

func nullIfEmpty(text, status string) any {
	if status != "done" {
		return nil
	}
	return text
}

func truncateString(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
