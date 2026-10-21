// Package webui embeds the production build of the React frontend
// (web/ is built by Vite into internal/webui/dist).
package webui

import (
	"embed"
	"io/fs"
)

// The pattern matches this file and, once the frontend is built, the dist
// directory; this keeps `go build` working before the first frontend build.
//
//go:embed all:*
var files embed.FS

// FS returns the built frontend, or nil when it has not been built.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	return sub
}
