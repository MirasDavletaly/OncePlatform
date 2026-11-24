package files

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
	"golang.org/x/net/html"
	"golang.org/x/text/encoding/charmap"
)

// MaxExtractedChars caps the amount of text stored per file.
const MaxExtractedChars = 5_000_000

const (
	maxXMLPartBytes = 100 << 20 // decompressed size limit for a single OOXML part
	maxTextFileRead = 50 << 20
)

// ErrUnsupported means the format has no text extractor (images, archives,
// legacy binary Office formats).
var ErrUnsupported = errors.New("text extraction not supported for this format")

// ExtractText extracts plain text from the file at path based on its extension.
func ExtractText(ctx context.Context, path, ext string) (string, error) {
	var (
		text string
		err  error
	)
	switch ext {
	case "pdf":
		text, err = extractPDF(ctx, path)
	case "docx":
		text, err = extractDOCX(path)
	case "xlsx":
		text, err = extractXLSX(path)
	case "pptx":
		text, err = extractPPTX(path)
	case "txt", "md", "csv":
		text, err = extractPlain(path)
	case "html":
		text, err = extractHTML(path)
	default:
		return "", ErrUnsupported
	}
	if err != nil {
		return "", err
	}
	return SanitizeText(text), nil
}

// SanitizeText makes text safe for PostgreSQL (valid UTF-8, no NUL bytes),
// normalizes line endings and caps its length.
func SanitizeText(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\f", "\n\n")
	s = collapseBlankLines(s)
	if utf8.RuneCountInString(s) > MaxExtractedChars {
		r := []rune(s)
		s = string(r[:MaxExtractedChars])
	}
	return strings.TrimSpace(s)
}

var blankLinesRe = regexp.MustCompile(`\n[ \t]*\n(?:[ \t]*\n)+`)

func collapseBlankLines(s string) string { return blankLinesRe.ReplaceAllString(s, "\n\n") }

func extractPDF(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pdftotext", "-enc", "UTF-8", "-q", path, "-")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &stdout, n: 64 << 20}
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", fmt.Errorf("pdftotext is not installed (poppler-utils): %w", err)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("pdftotext: %s", msg)
	}
	return stdout.String(), nil
}

type limitedWriter struct {
	w io.Writer
	n int64
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	if int64(len(p)) > l.n {
		_, err := l.w.Write(p[:l.n])
		l.n = 0
		return len(p), err
	}
	l.n -= int64(len(p))
	return l.w.Write(p)
}

func openZipPart(zr *zip.Reader, name string) (io.ReadCloser, error) {
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			return struct {
				io.Reader
				io.Closer
			}{io.LimitReader(rc, maxXMLPartBytes), rc}, nil
		}
	}
	return nil, fmt.Errorf("part %s not found", name)
}

// extractDOCX reads word/document.xml with the standard library: text runs
// (w:t), tabs, line breaks and paragraph ends are preserved.
func extractDOCX(path string) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer zr.Close()
	rc, err := openZipPart(&zr.Reader, "word/document.xml")
	if err != nil {
		return "", err
	}
	defer rc.Close()
	return wordprocessingText(rc)
}

func wordprocessingText(r io.Reader) (string, error) {
	dec := xml.NewDecoder(r)
	dec.Strict = false // some generators write a bare "&" (R&D); Word opens such files
	var b strings.Builder
	inText := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return b.String(), err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				inText = true
			case "tab":
				b.WriteByte('\t')
			case "br", "cr":
				b.WriteByte('\n')
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				b.WriteByte('\n')
			case "tc":
				b.WriteByte('\t')
			}
		case xml.CharData:
			if inText {
				b.Write(t)
			}
		}
		if b.Len() > MaxExtractedChars*4 {
			break
		}
	}
	return b.String(), nil
}

func extractXLSX(path string) (string, error) {
	f, err := excelize.OpenFile(path, excelize.Options{
		UnzipSizeLimit:    1 << 30,
		UnzipXMLSizeLimit: maxXMLPartBytes,
	})
	if err != nil {
		return "", err
	}
	defer f.Close()
	var b strings.Builder
	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "## %s\n", sheet)
		for _, row := range rows {
			line := strings.TrimRight(strings.Join(row, "\t"), "\t")
			if strings.TrimSpace(line) == "" {
				continue
			}
			b.WriteString(line)
			b.WriteByte('\n')
			if b.Len() > MaxExtractedChars*4 {
				return b.String(), nil
			}
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}

var slideRe = regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)

func extractPPTX(path string) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer zr.Close()
	type slide struct {
		n    int
		name string
	}
	var slides []slide
	for _, f := range zr.File {
		if m := slideRe.FindStringSubmatch(f.Name); m != nil {
			n, _ := strconv.Atoi(m[1])
			slides = append(slides, slide{n, f.Name})
		}
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].n < slides[j].n })
	var b strings.Builder
	for _, s := range slides {
		rc, err := openZipPart(&zr.Reader, s.name)
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "--- Slide %d ---\n", s.n)
		dec := xml.NewDecoder(rc)
		dec.Strict = false
		inText := false
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "t" {
					inText = true
				} else if t.Name.Local == "br" {
					b.WriteByte('\n')
				}
			case xml.EndElement:
				if t.Name.Local == "t" {
					inText = false
				} else if t.Name.Local == "p" {
					b.WriteByte('\n')
				}
			case xml.CharData:
				if inText {
					b.Write(t)
				}
			}
		}
		rc.Close()
		b.WriteByte('\n')
	}
	return b.String(), nil
}

// DecodeText converts raw bytes of a text file to UTF-8. Files that are not
// valid UTF-8 are assumed to be Windows-1251 (typical for CSV exported from
// Excel with a Russian locale).
func DecodeText(raw []byte) string {
	raw = bytes.TrimPrefix(raw, []byte("\xEF\xBB\xBF"))
	if utf8.Valid(raw) {
		return string(raw)
	}
	out, err := charmap.Windows1251.NewDecoder().Bytes(raw)
	if err != nil {
		return strings.ToValidUTF8(string(raw), "")
	}
	return string(out)
}

func readLimited(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxTextFileRead))
}

func extractPlain(path string) (string, error) {
	raw, err := readLimited(path)
	if err != nil {
		return "", err
	}
	return DecodeText(raw), nil
}

func extractHTML(path string) (string, error) {
	raw, err := readLimited(path)
	if err != nil {
		return "", err
	}
	z := html.NewTokenizer(strings.NewReader(DecodeText(raw)))
	var b strings.Builder
	skip := 0
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return b.String(), nil
		case html.StartTagToken, html.EndTagToken:
			name, _ := z.TagName()
			tag := string(name)
			if tag == "script" || tag == "style" {
				if tt == html.StartTagToken {
					skip++
				} else if skip > 0 {
					skip--
				}
			}
			switch tag {
			case "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table":
				b.WriteByte('\n')
			case "td", "th":
				b.WriteByte('\t')
			}
		case html.TextToken:
			if skip == 0 {
				b.Write(z.Text())
			}
		}
	}
}
