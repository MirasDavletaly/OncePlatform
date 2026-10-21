// Package migrations contains the SQL schema migrations. They are embedded
// into the binary and applied automatically on startup by goose.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
