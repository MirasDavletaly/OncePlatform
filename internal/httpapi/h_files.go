package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"onceplatform/internal/apperr"
	"onceplatform/internal/files"
)

func (a *api) fileRoutes(r chi.Router) {
	r.Get("/tickets/{ref}/attachments", a.listTicketAttachments)
	r.Post("/tickets/{ref}/attachments", a.uploadTicketAttachments)
	r.Get("/attachments/{id}", a.getAttachment)
	r.Get("/attachments/{id}/download", a.downloadAttachment)
	r.Get("/attachments/{id}/text", a.attachmentText)
	r.Patch("/attachments/{id}", a.updateAttachment)
	r.Delete("/attachments/{id}", a.deleteAttachment)
}

func (a *api) listTicketAttachments(w http.ResponseWriter, r *http.Request) {
	t, err := a.tickets.Get(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	list, err := a.files.List(r.Context(), files.Target{TicketID: t.ID})
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (a *api) uploadTicketAttachments(w http.ResponseWriter, r *http.Request) {
	t, err := a.tickets.Get(r.Context(), chi.URLParam(r, "ref"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	a.handleUpload(w, r, files.Target{TicketID: t.ID})
}

// handleUpload streams a multipart/form-data request with one or more "file"
// parts. The category comes from a "category" field preceding the files or
// from the ?category= query parameter.
func (a *api) handleUpload(w http.ResponseWriter, r *http.Request, target files.Target) {
	const maxFiles = 20
	r.Body = http.MaxBytesReader(w, r.Body, a.files.MaxBytes()*maxFiles+(1<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		a.writeError(w, r, apperr.BadRequest("Expected multipart/form-data with files"))
		return
	}
	category := r.URL.Query().Get("category")
	var uploaded []files.Attachment
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			a.writeError(w, r, apperr.BadRequest("Could not read the uploaded data"))
			return
		}
		if part.FileName() == "" {
			if part.FormName() == "category" {
				b, _ := io.ReadAll(io.LimitReader(part, 64))
				category = strings.TrimSpace(string(b))
			}
			part.Close()
			continue
		}
		if len(uploaded) >= maxFiles {
			part.Close()
			a.writeError(w, r, apperr.Validation("At most 20 files at a time"))
			return
		}
		att, err := a.files.Upload(r.Context(), actor(r), files.UploadInput{
			Target: target, Name: part.FileName(), Category: category, Body: part,
		})
		part.Close()
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		uploaded = append(uploaded, *att)
	}
	if len(uploaded) == 0 {
		a.writeError(w, r, apperr.Validation("No files were sent"))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"items": uploaded})
}

func (a *api) getAttachment(w http.ResponseWriter, r *http.Request) {
	att, err := a.files.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, att)
}

// downloadAttachment serves a stored file through an authorized endpoint
// with correct Content-Type and Content-Disposition. Only PDFs and images
// may be displayed inline (for the in-browser preview); everything else is
// always downloaded.
func (a *api) downloadAttachment(w http.ResponseWriter, r *http.Request) {
	att, f, err := a.files.Open(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	defer f.Close()
	inline := r.URL.Query().Get("inline") == "1" && files.InlineAllowed(att.Mime)
	disposition := "attachment"
	h := w.Header()
	if inline {
		disposition = "inline"
		// Allow the portal itself to embed the preview in an <iframe>. PDFs get
		// no further CSP restrictions: a restrictive policy breaks the
		// browser's built-in PDF viewer.
		h.Set("X-Frame-Options", "SAMEORIGIN")
		if att.Mime == "application/pdf" {
			h.Set("Content-Security-Policy", "frame-ancestors 'self'")
		} else {
			h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'")
		}
	} else {
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
	}
	cd := mime.FormatMediaType(disposition, map[string]string{"filename": att.OriginalName})
	if cd == "" {
		cd = disposition
	}
	h.Set("Content-Type", att.Mime)
	h.Set("Content-Disposition", cd)
	h.Set("Cache-Control", "private, no-store") // tender files stay out of the browser's disk cache
	h.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", att.CreatedAt, f)
}

func (a *api) attachmentText(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 20000)
	if limit < 1 || limit > 200000 {
		limit = 20000
	}
	chunk, err := a.files.ReadText(r.Context(), chi.URLParam(r, "id"), queryInt(r, "offset", 0), limit)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, chunk)
}

func (a *api) updateAttachment(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Category string `json:"category"`
	}
	if err := decode(w, r, &in); err != nil {
		a.writeError(w, r, err)
		return
	}
	att, err := a.files.UpdateCategory(r.Context(), actor(r), chi.URLParam(r, "id"), in.Category)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, att)
}

func (a *api) deleteAttachment(w http.ResponseWriter, r *http.Request) {
	if err := a.files.Delete(r.Context(), actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
