package db

import "testing"

func TestPrefixTSQuery(t *testing.T) {
	cases := map[string]string{
		"Тендер Алматы":         "тендер:* & алматы:*",
		"  ИИ-решение, 2026!  ": "ии:* & решение:* & 2026:*",
		"Қазақстан өңірлері":    "қазақстан:* & өңірлері:*",
		"'; DROP TABLE x; --":   "drop:* & table:* & x:*",
		"!!! ???":               "",
		"тендер тендер":         "тендер:*",
	}
	for in, want := range cases {
		if got := PrefixTSQuery(in); got != want {
			t.Errorf("PrefixTSQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLikePattern(t *testing.T) {
	if got := LikePattern(" 50%_off\\ "); got != `%50\%\_off\\%` {
		t.Errorf("got %q", got)
	}
}

func TestIsUUID(t *testing.T) {
	if !IsUUID("6f1c2a52-9d0e-4b8f-a1d2-0c9e8f7a6b5c") || IsUUID("6f1c2a52") || IsUUID("'; drop") {
		t.Error("IsUUID mismatch")
	}
}
