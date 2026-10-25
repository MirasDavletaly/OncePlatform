package tickets

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func ptr[T any](v T) *T { return &v }

func TestShortlistValidation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		value   Shortlist
		invalid bool
	}{
		{"empty", Shortlist{}, false},
		{"zero count", Shortlist{ApplicationsCount: ptr(0)}, false},
		{"bounds", Shortlist{FitScore: ptr(1), Complexity: ptr(5), ApplicationsCount: ptr(2147483647)}, false},
		{"zero score", Shortlist{FitScore: ptr(0)}, true},
		{"high complexity", Shortlist{Complexity: ptr(6)}, true},
		{"negative count", Shortlist{ApplicationsCount: ptr(-1)}, true},
		{"exact large amount", Shortlist{BudgetAmount: ptr("9999999999999999.99")}, false},
		{"too large", Shortlist{BudgetAmount: ptr("10000000000000000")}, true},
		{"negative amount", Shortlist{BudgetAmount: ptr("-1")}, true},
		{"rounding not allowed", Shortlist{BudgetAmount: ptr("1.001")}, true},
		{"scientific notation", Shortlist{BudgetAmount: ptr("1e6")}, true},
		{"bad currency", Shortlist{Currency: "USDT"}, true},
		{"unicode length", Shortlist{Market: strings.Repeat("я", 120)}, false},
		{"long market", Shortlist{Market: strings.Repeat("я", 121)}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.value.normalize(); (err != nil) != tc.invalid {
				t.Fatalf("error = %v", err)
			}
		})
	}
	s := Shortlist{BudgetAmount: ptr(" 12.5 "), Currency: " usd ", Market: " KZ ", Customer: " Client "}
	if err := s.normalize(); err != nil {
		t.Fatal(err)
	}
	if *s.BudgetAmount != "12.50" || s.Currency != "USD" || s.Market != "KZ" || s.Customer != "Client" {
		t.Fatalf("normalization: %+v", s)
	}
}

func TestShortlistPatchNullAndOmission(t *testing.T) {
	var in UpdateInput
	if err := json.Unmarshal([]byte(`{"fit_score":null,"applications_count":0,"budget_amount":"1.2"}`), &in); err != nil {
		t.Fatal(err)
	}
	s := Shortlist{FitScore: ptr(5), Complexity: ptr(4), Currency: "KZT"}
	changes := map[string]any{}
	if in.IsEmpty() {
		t.Fatal("PATCH incorrectly empty")
	}
	if err := in.ShortlistPatch.apply(&s, changes); err != nil {
		t.Fatal(err)
	}
	if s.FitScore != nil || *s.Complexity != 4 || *s.ApplicationsCount != 0 || *s.BudgetAmount != "1.20" || len(changes) != 3 {
		t.Fatalf("patch: %+v; changes: %+v", s, changes)
	}
	before := s
	bad := ShortlistPatch{Complexity: Optional[int]{Set: true, Value: ptr(6)}}
	if bad.apply(&s, changes) == nil || !reflect.DeepEqual(before, s) {
		t.Fatal("invalid patch changed state")
	}
	if err := json.Unmarshal([]byte(`{"fit_score":1.5}`), &in); err == nil {
		t.Fatal("fractional score accepted")
	}
}

func TestShortlistFilterValidation(t *testing.T) {
	for _, f := range []ListFilter{
		{ShortlistFilter: ShortlistFilter{FitMin: ptr(5), FitMax: ptr(4)}},
		{ShortlistFilter: ShortlistFilter{ApplicationsMax: ptr(-1)}},
		{ShortlistFilter: ShortlistFilter{BudgetMin: ptr("10")}},
		{Sort: "budget_amount"},
		{ShortlistFilter: ShortlistFilter{BudgetMin: ptr("9007199254740992.02"), BudgetMax: ptr("9007199254740992.01"), Currency: "USD"}},
		{ShortlistFilter: ShortlistFilter{LossReason: "guessed"}},
	} {
		if f.Validate() == nil {
			t.Errorf("accepted invalid filter: %+v", f)
		}
	}
	f := ListFilter{ShortlistFilter: ShortlistFilter{FitMin: ptr(4), ApplicationsMax: ptr(0), BudgetMin: ptr("0"), Currency: "usd", Market: "50%", SourceURL: "example.org/task"}, Sort: "budget_amount"}
	if err := f.Validate(); err != nil {
		t.Fatal(err)
	}
	where, args := f.where()
	if !strings.Contains(where, "t.applications_count <=") || !strings.Contains(where, "ticket_source_key(") || strings.Contains(where, "50%") || len(args) != 6 {
		t.Fatalf("unsafe/incomplete filter: %s %#v", where, args)
	}
}
