package tickets

import (
	"testing"
	"time"
)

func TestParseDeadline(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Almaty")
	if err != nil {
		t.Skip("tzdata not available:", err)
	}
	cases := map[string]string{
		"2026-11-05T18:00":          "2026-11-05T13:00:00Z",
		"2026-11-05 18:00":          "2026-11-05T13:00:00Z",
		"05.11.2026 18:00":          "2026-11-05T13:00:00Z",
		"2026-11-05":                "2026-11-05T18:59:00Z",
		"05.11.2026":                "2026-11-05T18:59:00Z",
		"2026-11-05T18:00:00+05:00": "2026-11-05T13:00:00Z",
		"2026-11-05T13:00:00Z":      "2026-11-05T13:00:00Z",
	}
	for in, want := range cases {
		got, err := ParseDeadline(in, loc)
		if err != nil {
			t.Errorf("ParseDeadline(%q): %v", in, err)
			continue
		}
		if got.Format(time.RFC3339) != want {
			t.Errorf("ParseDeadline(%q) = %s, want %s", in, got.Format(time.RFC3339), want)
		}
	}
	if d, err := ParseDeadline("", loc); err != nil || d != nil {
		t.Errorf("empty deadline: %v %v", d, err)
	}
	if _, err := ParseDeadline("tomorrow", loc); err == nil {
		t.Error("garbage deadline accepted")
	}
}

func TestTicketNumber(t *testing.T) {
	if FormatNumber(2026, 1) != "T-2026-0001" || FormatNumber(2026, 12345) != "T-2026-12345" {
		t.Error("bad number format")
	}
	if !IsTicketNumber("T-2026-0001") || !IsTicketNumber("t-2026-0042") || IsTicketNumber("2026-0001") {
		t.Error("IsTicketNumber mismatch")
	}
}

func TestValidators(t *testing.T) {
	if _, err := normalizeURL("javascript:alert(1)"); err == nil {
		t.Error("javascript URL accepted")
	}
	if u, err := normalizeURL(" https://goszakup.gov.kz/ru/announce/index/123 "); err != nil || u == "" {
		t.Errorf("valid URL rejected: %v", err)
	}
	if u, _ := normalizeURL("goszakup.gov.kz/ru"); u != "https://goszakup.gov.kz/ru" {
		t.Errorf("URL without scheme not completed: %q", u)
	}
	if err := validatePriority("urgent"); err != nil {
		t.Error(err)
	}
	if err := validatePriority("asap"); err == nil {
		t.Error("unknown priority accepted")
	}
}
