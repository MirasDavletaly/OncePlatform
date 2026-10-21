// Package httpapi wires the HTTP server: REST API (/api/v1), OAuth and MCP
// endpoints, health checks, security middleware and the embedded SPA.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"onceplatform/internal/apperr"
)

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

func writeErrorCode(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

// writeError maps an error to the uniform JSON error format.
func (a *api) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if e, ok := apperr.As(err); ok {
		if e.Code == "rate_limited" {
			w.Header().Set("Retry-After", "60")
		}
		writeErrorCode(w, e.Status, e.Code, e.Message)
		return
	}
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		writeErrorCode(w, http.StatusRequestEntityTooLarge, "payload_too_large", "The request is too large")
		return
	}
	if errors.Is(err, r.Context().Err()) && r.Context().Err() != nil {
		return // client went away
	}
	a.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err.Error(),
		slog.String("request_id", requestID(r)))
	writeErrorCode(w, http.StatusInternalServerError, "internal", "Internal server error. Please try again or contact the administrator.")
}

const maxJSONBody = 8 << 20

// decode parses a JSON request body into v.
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return apperr.TooLarge("The request is too large")
		}
		if errors.Is(err, io.EOF) {
			return apperr.BadRequest("Empty request body")
		}
		var ute *json.UnmarshalTypeError
		if errors.As(err, &ute) {
			return apperr.BadRequest("Wrong type of field \"" + ute.Field + "\"")
		}
		return apperr.BadRequest("Malformed JSON")
	}
	return nil
}

// page is the uniform paginated response.
type page[T any] struct {
	Items    []T `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

func queryInt(r *http.Request, key string, def int) int {
	v := strings.TrimSpace(r.URL.Query().Get(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// queryList reads a multi-value parameter given either repeated (?a=1&a=2)
// or comma-separated (?a=1,2).
func queryList(r *http.Request, key string) []string {
	var out []string
	for _, v := range r.URL.Query()[key] {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}
