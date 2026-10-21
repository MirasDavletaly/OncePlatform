package files

import (
	"context"
	"errors"
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

func (s *Service) process(ctx context.Context, id string) {
	if _, busy := s.inflight.LoadOrStore(id, true); busy {
		return
	}
	defer s.inflight.Delete(id)

	var stored, name string
	err := s.pool.QueryRow(ctx, `SELECT stored_name, original_name FROM attachments
		WHERE id = $1 AND extraction_status = 'pending'`, id).Scan(&stored, &name)
	if err != nil {
		return // already processed or deleted
	}
	start := time.Now()
	text, err := ExtractText(ctx, s.pathFor(stored), Ext(name))
	status, errMsg := "done", ""
	switch {
	case errors.Is(err, ErrUnsupported):
		status, text = "unsupported", ""
	case err != nil:
		if ctx.Err() != nil {
			return // shutting down; keep pending for the next start
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
