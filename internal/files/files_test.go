package files

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/charmap"

	"onceplatform/internal/apperr"
)

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipReader(t *testing.T, b []byte) *zip.Reader {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return zr
}

const docXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Техническое задание</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Срок: </w:t></w:r><w:r><w:tab/><w:t>30 дней</w:t></w:r></w:p>
<w:p><w:r><w:t>Қазақ тілі</w:t><w:br/><w:t>жол</w:t></w:r></w:p>
<w:p><w:r><w:t>R&D &IT &amp; QA</w:t></w:r></w:p>
</w:body></w:document>`

func TestCheckContent(t *testing.T) {
	docx := makeZip(t, map[string]string{"[Content_Types].xml": "<Types/>", "word/document.xml": docXML})
	xlsxAsDocx := makeZip(t, map[string]string{"[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>"})
	plainZip := makeZip(t, map[string]string{"a.txt": "hello"})

	ok := []struct {
		ext  string
		head []byte
		zr   *zip.Reader
	}{
		{"pdf", []byte("%PDF-1.7\n..."), nil},
		{"docx", docx, zipReader(t, docx)},
		{"xlsx", xlsxAsDocx, zipReader(t, xlsxAsDocx)},
		{"zip", plainZip, nil},
		{"png", []byte("\x89PNG\r\n\x1a\n...."), nil},
		{"jpg", []byte{0xFF, 0xD8, 0xFF, 0xE0}, nil},
		{"doc", []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0}, nil},
		{"txt", []byte("Обычный текст"), nil},
		{"csv", []byte("a;b;c\n1;2;3"), nil},
		{"md", []byte("# Заголовок"), nil},
	}
	for _, c := range ok {
		if err := CheckContent(c.ext, c.head, c.zr); err != nil {
			t.Errorf("%s: unexpected error %v", c.ext, err)
		}
	}

	bad := []struct {
		ext  string
		head []byte
		zr   *zip.Reader
	}{
		{"pdf", []byte("<html><script>alert(1)</script>"), nil},
		{"docx", xlsxAsDocx, zipReader(t, xlsxAsDocx)}, // xlsx renamed to docx
		{"docx", plainZip, zipReader(t, plainZip)},     // arbitrary zip renamed to docx
		{"docx", []byte("not a zip"), nil},
		{"png", []byte{0xFF, 0xD8, 0xFF}, nil}, // jpeg renamed to png
		{"jpg", []byte("GIF89a"), nil},
		{"zip", []byte("%PDF-1.4"), nil},
		{"txt", []byte("MZ\x90\x00binary"), nil}, // executable renamed to txt
		{"txt", []byte("text\x00with nul"), nil},
		{"csv", []byte("%PDF-1.4"), nil},
		{"exe", []byte("MZ"), nil},
	}
	for _, c := range bad {
		err := CheckContent(c.ext, c.head, c.zr)
		e, isApp := apperr.As(err)
		if err == nil || !isApp || e.Code != "unsupported_file" {
			t.Errorf("%s with head %q: expected unsupported_file, got %v", c.ext, truncateString(string(c.head), 20), err)
		}
	}
}

func TestWhitelist(t *testing.T) {
	for _, ext := range []string{"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "zip", "txt", "md", "csv"} {
		if _, ok := MimeFor(ext, false); !ok {
			t.Errorf("%s must be allowed", ext)
		}
	}
	for _, ext := range []string{"exe", "html", "svg", "js", "php", "sh", ""} {
		if _, ok := MimeFor(ext, false); ok {
			t.Errorf("%s must not be allowed for browser uploads", ext)
		}
	}
	if _, ok := MimeFor("html", true); !ok {
		t.Error("html must be allowed for MCP text documents")
	}
	if Ext("Отчёт.Final.PDF") != "pdf" {
		t.Error("Ext must lowercase")
	}
}

func TestCleanFileName(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":            "passwd",
		`C:\Users\x\ТЗ на работу.pdf`: "ТЗ на работу.pdf",
		"a\x00b<>:|?.docx":            "ab.docx",
		"  .hidden.txt  ":             "hidden.txt",
	}
	for in, want := range cases {
		if got := CleanFileName(in); got != want {
			t.Errorf("CleanFileName(%q) = %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("я", 300) + ".pdf"
	if got := CleanFileName(long); len([]rune(got)) != 200 || !strings.HasSuffix(got, ".pdf") {
		t.Errorf("long name not truncated correctly: %d runes", len([]rune(got)))
	}
}

func TestExtractDOCX(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tz.docx")
	if err := os.WriteFile(path, makeZip(t, map[string]string{"[Content_Types].xml": "<Types/>", "word/document.xml": docXML}), 0o600); err != nil {
		t.Fatal(err)
	}
	text, err := ExtractText(context.Background(), path, "docx")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Техническое задание", "Срок: \t30 дней", "Қазақ тілі\nжол", "R&D &IT & QA"} {
		if !strings.Contains(text, want) {
			t.Errorf("extracted text %q does not contain %q", text, want)
		}
	}
}

func TestExtractPPTX(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deck.pptx")
	slide := `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Слайд про ИИ</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
	if err := os.WriteFile(path, makeZip(t, map[string]string{
		"[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p/>",
		"ppt/slides/slide2.xml": slide, "ppt/slides/slide1.xml": strings.Replace(slide, "про ИИ", "первый", 1),
	}), 0o600); err != nil {
		t.Fatal(err)
	}
	text, err := ExtractText(context.Background(), path, "pptx")
	if err != nil {
		t.Fatal(err)
	}
	if i, j := strings.Index(text, "Слайд первый"), strings.Index(text, "Слайд про ИИ"); i < 0 || j < 0 || i > j {
		t.Errorf("slides missing or out of order: %q", text)
	}
}

func TestDecodeText(t *testing.T) {
	if got := DecodeText([]byte("\xEF\xBB\xBFпривет")); got != "привет" {
		t.Errorf("BOM not stripped: %q", got)
	}
	cp1251, _ := charmap.Windows1251.NewEncoder().String("Номер;Сумма")
	if got := DecodeText([]byte(cp1251)); got != "Номер;Сумма" {
		t.Errorf("cp1251 not decoded: %q", got)
	}
}

func TestSanitizeText(t *testing.T) {
	got := SanitizeText("a\x00b\r\nc\n\n\n\n\nd\xff")
	if got != "ab\nc\n\nd" {
		t.Errorf("got %q", got)
	}
}

func TestExtractUnsupported(t *testing.T) {
	if _, err := ExtractText(context.Background(), "x.png", "png"); err != ErrUnsupported {
		t.Errorf("png: %v", err)
	}
}