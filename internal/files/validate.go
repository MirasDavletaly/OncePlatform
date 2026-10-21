// Package files stores uploaded files on disk (outside any web root, under
// UUID names), validates their real content type, extracts text in the
// background for search and MCP, and serves downloads.
package files

import (
	"archive/zip"
	"bytes"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"onceplatform/internal/apperr"
)

// Categories of attachments.
var Categories = []string{"tz", "analysis", "solution", "proposal", "other"}

// ValidCategory reports whether c is a known category.
func ValidCategory(c string) bool { return slices.Contains(Categories, c) }

// mimeByExt is the upload whitelist (extension → MIME type).
var mimeByExt = map[string]string{
	"pdf":  "application/pdf",
	"doc":  "application/msword",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"xls":  "application/vnd.ms-excel",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"ppt":  "application/vnd.ms-powerpoint",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"png":  "image/png",
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"zip":  "application/zip",
	"txt":  "text/plain; charset=utf-8",
	"md":   "text/markdown; charset=utf-8",
	"csv":  "text/csv; charset=utf-8",
}

// mcpOnlyExt are extensions accepted only for text documents created by
// Claude through the MCP upload_attachment tool.
var mcpOnlyExt = map[string]string{
	"html": "text/html; charset=utf-8",
}

// AllowedExtensions lists the whitelisted extensions for browser uploads.
func AllowedExtensions() []string {
	out := make([]string, 0, len(mimeByExt))
	for ext := range mimeByExt {
		out = append(out, ext)
	}
	slices.Sort(out)
	return out
}

// Ext returns the lowercase extension of name without the dot.
func Ext(name string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
}

// MimeFor returns the MIME type for an allowed extension.
func MimeFor(ext string, allowMCP bool) (string, bool) {
	if m, ok := mimeByExt[ext]; ok {
		return m, true
	}
	if allowMCP {
		if m, ok := mcpOnlyExt[ext]; ok {
			return m, true
		}
	}
	return "", false
}

// CleanFileName removes path components and control characters and limits
// the length of a user-supplied file name.
func CleanFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' || r == '<' || r == '>' || r == '|' || r == '*' || r == '?' || r == ':' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(strings.Trim(name, ". "))
	if !utf8.ValidString(name) {
		name = strings.ToValidUTF8(name, "_")
	}
	if r := []rune(name); len(r) > 200 {
		ext := filepath.Ext(name)
		keep := 200 - len([]rune(ext))
		if keep < 1 {
			keep = 1
		}
		name = string(r[:keep]) + ext
	}
	return name
}

var (
	sigPDF  = []byte("%PDF-")
	sigZIP  = []byte("PK\x03\x04")
	sigZIPe = []byte("PK\x05\x06")
	sigOLE  = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}
	sigPNG  = []byte("\x89PNG\r\n\x1a\n")
	sigJPEG = []byte{0xFF, 0xD8, 0xFF}
)

// officeMarker is a part that must exist inside an OOXML package of each type.
var officeMarker = map[string]string{
	"docx": "word/document.xml",
	"xlsx": "xl/workbook.xml",
	"pptx": "ppt/presentation.xml",
}

func errContent(ext string) error {
	return apperr.New(415, "unsupported_file",
		"The file content does not match the ."+ext+" extension (the file is damaged or renamed)")
}

// CheckContent verifies that the real content of a file matches its
// extension. head holds the first bytes of the file (at least 8 KiB if the
// file is that large). For OOXML formats zr must be a zip reader of the whole
// file; it may be nil for other formats.
func CheckContent(ext string, head []byte, zr *zip.Reader) error {
	switch ext {
	case "pdf":
		i := bytes.Index(head, sigPDF)
		if i < 0 || i > 1024 {
			return errContent(ext)
		}
	case "docx", "xlsx", "pptx":
		if !bytes.HasPrefix(head, sigZIP) || zr == nil {
			return errContent(ext)
		}
		hasTypes, hasMarker := false, false
		for _, f := range zr.File {
			switch f.Name {
			case "[Content_Types].xml":
				hasTypes = true
			case officeMarker[ext]:
				hasMarker = true
			}
		}
		if !hasTypes || !hasMarker {
			return errContent(ext)
		}
	case "doc", "xls", "ppt":
		if !bytes.HasPrefix(head, sigOLE) {
			return errContent(ext)
		}
	case "png":
		if !bytes.HasPrefix(head, sigPNG) {
			return errContent(ext)
		}
	case "jpg", "jpeg":
		if !bytes.HasPrefix(head, sigJPEG) {
			return errContent(ext)
		}
	case "zip":
		if !bytes.HasPrefix(head, sigZIP) && !bytes.HasPrefix(head, sigZIPe) {
			return errContent(ext)
		}
	case "txt", "md", "csv", "html":
		if bytes.IndexByte(head, 0) >= 0 {
			return errContent(ext)
		}
		// Reject well-known binary formats disguised as text.
		for _, sig := range [][]byte{sigPDF, sigZIP, sigOLE, sigPNG, sigJPEG, []byte("MZ")} {
			if bytes.HasPrefix(head, sig) {
				return errContent(ext)
			}
		}
	default:
		return apperr.New(415, "unsupported_file", "File type ."+ext+" is not allowed")
	}
	return nil
}

// NeedsZip reports whether CheckContent needs a zip reader for ext.
func NeedsZip(ext string) bool {
	_, ok := officeMarker[ext]
	return ok
}

// InlineAllowed reports whether a file may be displayed inline in the browser.
// Only PDF and raster images are shown inline; everything else is downloaded.
func InlineAllowed(mime string) bool {
	switch mime {
	case "application/pdf", "image/png", "image/jpeg":
		return true
	}
	return false
}
