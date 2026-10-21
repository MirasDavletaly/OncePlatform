// Package apperr defines application errors that carry an HTTP status,
// a stable machine-readable code and a human-readable (Russian) message.
// The same errors are surfaced by the REST API and by MCP tools.
package apperr

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is a user-facing application error.
type Error struct {
	Status  int
	Code    string
	Message string
	Err     error // optional wrapped cause, never shown to users
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
	}
	return e.Code + ": " + e.Message
}

func (e *Error) Unwrap() error { return e.Err }

// New creates an error with an explicit status and code.
func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func BadRequest(msg string) *Error { return New(http.StatusBadRequest, "bad_request", msg) }
func Validation(msg string) *Error {
	return New(http.StatusUnprocessableEntity, "validation_error", msg)
}
func Unauthorized(msg string) *Error { return New(http.StatusUnauthorized, "unauthorized", msg) }
func Forbidden(msg string) *Error    { return New(http.StatusForbidden, "forbidden", msg) }
func NotFound(msg string) *Error     { return New(http.StatusNotFound, "not_found", msg) }
func Conflict(msg string) *Error     { return New(http.StatusConflict, "conflict", msg) }
func TooLarge(msg string) *Error {
	return New(http.StatusRequestEntityTooLarge, "payload_too_large", msg)
}
func RateLimited(msg string) *Error { return New(http.StatusTooManyRequests, "rate_limited", msg) }

// Validationf formats a validation error message.
func Validationf(format string, args ...any) *Error {
	return Validation(fmt.Sprintf(format, args...))
}

// As extracts an *Error from err.
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// IsNotFound reports whether err is a not-found application error.
func IsNotFound(err error) bool {
	e, ok := As(err)
	return ok && e.Status == http.StatusNotFound
}
