package httpapi

import (
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/cv"
	"onceplatform/internal/files"
	"onceplatform/internal/workflow"
)

func (a *api) cvRoutes(r chi.Router) {
	r.Get("/cv/meta", a.cvMeta)
	r.Get("/cv/candidates", a.listCandidates)
	r.Post("/cv/candidates", a.uploadCandidates)
	r.Get("/cv/candidates/{id}", a.getCandidate)
	r.Patch("/cv/candidates/{id}", a.updateCandidate)
	r.Delete("/cv/candidates/{id}", a.deleteCandidate)
	r.Post("/cv/candidates/{id}/reparse", a.reparseCandidate)
	r.Get("/cv/candidates/{id}/file", a.candidateFile)
	r.Get("/cv/candidates/{id}/text", a.candidateText)
	r.Post("/cv/candidates/{id}/consent-file", a.uploadConsentFile)
	r.Get("/cv/candidates/{id}/consent-file", a.consentFile)
	r.Get("/cv/candidates/{id}/export.docx", a.exportCandidate)
	r.Get("/cv/letterheads", a.listLetterheads)
	r.Put("/cv/letterheads/{id}", a.saveLetterhead)
	r.Get("/cv/documents", a.listDocuments)
	r.Post("/cv/documents", a.uploadDocuments)
	r.Post("/cv/documents/{id}/assign", a.assignDocument)
	r.Post("/cv/documents/{id}/reprocess", a.reprocessDocument)
	r.Delete("/cv/documents/{id}", a.deleteDocument)
	r.Get("/cv/documents/{id}/file", a.documentFile)
	r.Get("/tickets/{ref}/cv", a.ticketCV)
	r.Put("/tickets/{ref}/cv/requirements", a.setTicketCVRequirements)
}

func (a *api) cvMeta(w http.ResponseWriter, r *http.Request) {
	m, err := a.cv.Meta(r.Context())
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(m)
}

func (a *api) listCandidates(w http.ResponseWriter, r *http.Request) {
	list, err := a.cv.List(r.Context(), actor(r))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

// multipartFiles reads a multipart/form-data request with up to 20 "file" parts
// (the caller removes the form); nil means the error is already written.
func (a *api) multipartFiles(w http.ResponseWriter, r *http.Request) []*multipart.FileHeader {
	const maxFiles = 20
	// the right first: a role that may not upload must not get gigabytes written to the server's disk before a 403
	if err := actor(r).Require(workflow.PermCVManage); err != nil {
		a.writeError(w, r, err)
		return nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, a.files.MaxBytes()*maxFiles+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		a.writeError(w, r, apperr.BadRequest("Expected multipart/form-data with files"))
		return nil
	}
	fhs := r.MultipartForm.File["file"]
	if len(fhs) == 0 || len(fhs) > maxFiles {
		_ = r.MultipartForm.RemoveAll()
		a.writeError(w, r, apperr.Validation("Send from 1 to 20 files at a time"))
		return nil
	}
	return fhs
}

// storeEach stores every file with store; a file the service rejects is
// reported in "failed" (or in "skipped" when it is in the portal already) and
// does not stop the others.
func storeEach[T any](a *api, w http.ResponseWriter, r *http.Request, fhs []*multipart.FileHeader, store func(name string, body io.Reader) (*T, error)) {
	type failure struct {
		Name  string `json:"name"`
		Error string `json:"error"`
	}
	done := []T{}
	failed := []failure{}
	skipped := []failure{}
	for _, fh := range fhs {
		f, err := fh.Open()
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		item, err := store(fh.Filename, f)
		f.Close()
		if err != nil {
			e, ok := apperr.As(err)
			if !ok {
				a.writeError(w, r, err)
				return
			}
			if e.Code == "already_uploaded" {
				skipped = append(skipped, failure{fh.Filename, e.Message})
			} else {
				failed = append(failed, failure{fh.Filename, e.Message})
			}
			continue
		}
		done = append(done, *item)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"items": done, "failed": failed, "skipped": skipped})
}

// uploadCandidates takes multipart/form-data with consent_date, an optional
// consent_note and one or more "file" parts (one candidate per file).
func (a *api) uploadCandidates(w http.ResponseWriter, r *http.Request) {
	fhs := a.multipartFiles(w, r)
	if fhs == nil {
		return
	}
	defer r.MultipartForm.RemoveAll()
	date, note, referral := r.FormValue("consent_date"), r.FormValue("consent_note"), r.FormValue("referred_by")
	if err := a.cv.CheckUpload(actor(r), date, note, referral); err != nil {
		a.writeError(w, r, err)
		return
	}
	storeEach(a, w, r, fhs, func(name string, body io.Reader) (*cv.Candidate, error) {
		return a.cv.Upload(r.Context(), actor(r), cv.UploadInput{Name: name, Body: body, ConsentDate: date, ConsentNote: note, ReferredBy: referral})
	})
}

// uploadDocuments takes diplomas and certificates ("file" parts); each one is
// recognised and attached to its holder's candidate in the background.
func (a *api) uploadDocuments(w http.ResponseWriter, r *http.Request) {
	fhs := a.multipartFiles(w, r)
	if fhs == nil {
		return
	}
	defer r.MultipartForm.RemoveAll()
	storeEach(a, w, r, fhs, func(name string, body io.Reader) (*cv.Document, error) {
		return a.cv.UploadDocument(r.Context(), actor(r), name, body)
	})
}

func (a *api) listDocuments(w http.ResponseWriter, r *http.Request) {
	list, err := a.cv.ListDocuments(r.Context(), actor(r))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) assignDocument(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CandidateID string `json:"candidate_id"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	d, err := a.cv.AssignDocument(r.Context(), actor(r), chi.URLParam(r, "id"), in.CandidateID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (a *api) reprocessDocument(w http.ResponseWriter, r *http.Request) {
	d, err := a.cv.ReprocessDocument(r.Context(), actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (a *api) deleteDocument(w http.ResponseWriter, r *http.Request) {
	if err := a.cv.DeleteDocument(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) documentFile(w http.ResponseWriter, r *http.Request) {
	d, f, err := a.cv.OpenDocument(r.Context(), actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	defer f.Close()
	serveStoredFile(w, r, d.FileName, d.Mime, d.UpdatedAt, f)
}

func (a *api) getCandidate(w http.ResponseWriter, r *http.Request) {
	c, err := a.cv.Get(r.Context(), actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *api) updateCandidate(w http.ResponseWriter, r *http.Request) {
	var in cv.UpdateInput
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	c, err := a.cv.Update(r.Context(), actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *api) deleteCandidate(w http.ResponseWriter, r *http.Request) {
	if err := a.cv.Delete(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) reparseCandidate(w http.ResponseWriter, r *http.Request) {
	c, err := a.cv.Reparse(r.Context(), actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *api) candidateText(w http.ResponseWriter, r *http.Request) {
	text, err := a.cv.Text(r.Context(), actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func (a *api) candidateFile(w http.ResponseWriter, r *http.Request) {
	a.serveCandidateFile(w, r, false)
}
func (a *api) consentFile(w http.ResponseWriter, r *http.Request) { a.serveCandidateFile(w, r, true) }

// serveCandidateFile works like attachment downloads: PDFs and images may be
// shown inline in the portal's preview, everything else is downloaded.
func (a *api) serveCandidateFile(w http.ResponseWriter, r *http.Request, consent bool) {
	c, name, mt, f, err := a.cv.OpenFile(r.Context(), actor(r), chi.URLParam(r, "id"), consent)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	defer f.Close()
	serveStoredFile(w, r, name, mt, c.UpdatedAt, f)
}

func serveStoredFile(w http.ResponseWriter, r *http.Request, name, mt string, mod time.Time, f io.ReadSeeker) {
	inline := r.URL.Query().Get("inline") == "1" && files.InlineAllowed(mt)
	disposition := "attachment"
	h := w.Header()
	if inline {
		disposition = "inline"
		h.Set("X-Frame-Options", "SAMEORIGIN")
		if mt == "application/pdf" {
			h.Set("Content-Security-Policy", "frame-ancestors 'self'")
		} else {
			h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'")
		}
	} else {
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
	}
	cd := mime.FormatMediaType(disposition, map[string]string{"filename": name})
	if cd == "" {
		cd = disposition
	}
	h.Set("Content-Type", mt)
	h.Set("Content-Disposition", cd)
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", mod, f)
}

func (a *api) uploadConsentFile(w http.ResponseWriter, r *http.Request) {
	if err := actor(r).Require(workflow.PermCVManage); err != nil {
		a.writeError(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, a.files.MaxBytes()+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		a.writeError(w, r, apperr.BadRequest("Expected multipart/form-data with the consent file"))
		return
	}
	defer r.MultipartForm.RemoveAll()
	fhs := r.MultipartForm.File["file"]
	if len(fhs) != 1 {
		a.writeError(w, r, apperr.Validation("Send exactly one file"))
		return
	}
	f, err := fhs[0].Open()
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	defer f.Close()
	c, err := a.cv.SetConsentFile(r.Context(), actor(r), chi.URLParam(r, "id"), fhs[0].Filename, f)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *api) exportCandidate(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name, body, err := a.cv.Export(r.Context(), actor(r), chi.URLParam(r, "id"), q.Get("lang"), q.Get("letterhead"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
	h.Set("Cache-Control", "private, no-store")
	_, _ = w.Write(body)
}

func (a *api) listLetterheads(w http.ResponseWriter, r *http.Request) {
	list, err := a.cv.Letterheads(r.Context(), actor(r))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) saveLetterhead(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Header string `json:"header"`
		Footer string `json:"footer"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	l, err := a.cv.SaveLetterhead(r.Context(), actor(r), chi.URLParam(r, "id"), in.Header, in.Footer)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (a *api) ticketCV(w http.ResponseWriter, r *http.Request) {
	t, err := a.tickets.Get(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	req, roles, total, err := a.cv.Match(r.Context(), actor(r), t.ID, false)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requirements": req, "matches": roles, "candidates_total": total})
}

func (a *api) setTicketCVRequirements(w http.ResponseWriter, r *http.Request) {
	t, err := a.tickets.Get(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	var in struct {
		Roles []cv.Role `json:"roles"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	if in.Roles == nil {
		a.writeError(w, r, apperr.Validation("roles is required (an empty list removes all roles)"))
		return
	}
	req, err := a.cv.SetRequirements(r.Context(), actor(r), t.ID, t.Number, in.Roles)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}
