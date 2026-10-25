package tickets

import (
	"encoding/json"
	"math/big"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"onceplatform/internal/apperr"
	"onceplatform/internal/workflow"
)

// Optional distinguishes an omitted PATCH field from an explicit JSON null.
type Optional[T any] struct {
	Set   bool
	Value *T
}

func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	return json.Unmarshal(data, &o.Value)
}

// Shortlist holds optional screening data. Amounts are decimal strings so
// neither JSON nor JavaScript rounds money through a binary floating point.
type Shortlist struct {
	FitScore          *int    `json:"fit_score"`
	Complexity        *int    `json:"complexity"`
	Market            string  `json:"market"`
	ApplicationsCount *int    `json:"applications_count"`
	BudgetAmount      *string `json:"budget_amount"`
	Currency          string  `json:"currency"`
	Customer          string  `json:"customer"`
}

type ShortlistPatch struct {
	FitScore          Optional[int]    `json:"fit_score"`
	Complexity        Optional[int]    `json:"complexity"`
	Market            *string          `json:"market"`
	ApplicationsCount Optional[int]    `json:"applications_count"`
	BudgetAmount      Optional[string] `json:"budget_amount"`
	Currency          *string          `json:"currency"`
	Customer          *string          `json:"customer"`
}

func (p ShortlistPatch) empty() bool {
	return !p.FitScore.Set && !p.Complexity.Set && p.Market == nil && !p.ApplicationsCount.Set &&
		!p.BudgetAmount.Set && p.Currency == nil && p.Customer == nil
}

var amountRE = regexp.MustCompile(`^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$`)
var currencyRE = regexp.MustCompile(`^[A-Z]{3}$`)

func normalizeAmount(v string) (string, error) {
	v = strings.TrimSpace(v)
	if !amountRE.MatchString(v) {
		return "", apperr.Validation("Amount must be a non-negative decimal with at most 16 integer digits and 2 decimal places")
	}
	parts := strings.SplitN(v, ".", 2)
	fraction := "00"
	if len(parts) == 2 {
		fraction = (parts[1] + "0")[:2]
	}
	return parts[0] + "." + fraction, nil
}

func (s *Shortlist) normalize() error {
	for _, score := range []*int{s.FitScore, s.Complexity} {
		if score != nil && (*score < 1 || *score > 5) {
			return apperr.Validation("Fit and complexity must be integers from 1 to 5")
		}
	}
	if s.ApplicationsCount != nil && (*s.ApplicationsCount < 0 || int64(*s.ApplicationsCount) > 2147483647) {
		return apperr.Validation("Applications count must be an integer from 0 to 2147483647")
	}
	s.Market, s.Customer = strings.TrimSpace(s.Market), strings.TrimSpace(s.Customer)
	if utf8.RuneCountInString(s.Market) > 120 || utf8.RuneCountInString(s.Customer) > 300 {
		return apperr.Validation("Market must be at most 120 characters and customer at most 300 characters")
	}
	s.Currency = strings.ToUpper(strings.TrimSpace(s.Currency))
	if s.Currency == "" {
		s.Currency = "KZT"
	}
	if !currencyRE.MatchString(s.Currency) {
		return apperr.Validation("Currency must be a three-letter code, for example KZT or USD")
	}
	if s.BudgetAmount != nil {
		v, err := normalizeAmount(*s.BudgetAmount)
		if err != nil {
			return err
		}
		s.BudgetAmount = &v
	}
	return nil
}

func applyOptional[T comparable](dst **T, p Optional[T], field string, changes map[string]any) {
	if !p.Set {
		return
	}
	if (*dst == nil && p.Value == nil) || (*dst != nil && p.Value != nil && **dst == *p.Value) {
		return
	}
	changes[field] = change{*dst, p.Value}
	*dst = p.Value
}

func (p ShortlistPatch) apply(s *Shortlist, changes map[string]any) error {
	if p.empty() {
		return nil
	}
	next := *s
	if p.FitScore.Set {
		next.FitScore = p.FitScore.Value
	}
	if p.Complexity.Set {
		next.Complexity = p.Complexity.Value
	}
	if p.ApplicationsCount.Set {
		next.ApplicationsCount = p.ApplicationsCount.Value
	}
	if p.BudgetAmount.Set {
		next.BudgetAmount = p.BudgetAmount.Value
	}
	if p.Market != nil {
		next.Market = *p.Market
	}
	if p.Currency != nil {
		next.Currency = *p.Currency
	}
	if p.Customer != nil {
		next.Customer = *p.Customer
	}
	if err := next.normalize(); err != nil {
		return err
	}
	applyOptional(&s.FitScore, Optional[int]{p.FitScore.Set, next.FitScore}, "fit_score", changes)
	applyOptional(&s.Complexity, Optional[int]{p.Complexity.Set, next.Complexity}, "complexity", changes)
	applyOptional(&s.ApplicationsCount, Optional[int]{p.ApplicationsCount.Set, next.ApplicationsCount}, "applications_count", changes)
	applyOptional(&s.BudgetAmount, Optional[string]{p.BudgetAmount.Set, next.BudgetAmount}, "budget_amount", changes)
	for _, pair := range []struct {
		name  string
		dst   *string
		value string
	}{
		{"market", &s.Market, next.Market}, {"currency", &s.Currency, next.Currency}, {"customer", &s.Customer, next.Customer},
	} {
		if *pair.dst != pair.value {
			changes[pair.name] = change{*pair.dst, pair.value}
			*pair.dst = pair.value
		}
	}
	return nil
}

// ShortlistFilter is shared by REST, CSV, board and MCP. Unknown numeric values
// do not satisfy numeric bounds; an explicit zero count does.
type ShortlistFilter struct {
	LossReason      string  `json:"loss_reason,omitempty"`
	FitMin          *int    `json:"fit_min,omitempty"`
	FitMax          *int    `json:"fit_max,omitempty"`
	ComplexityMin   *int    `json:"complexity_min,omitempty"`
	ComplexityMax   *int    `json:"complexity_max,omitempty"`
	ApplicationsMin *int    `json:"applications_min,omitempty"`
	ApplicationsMax *int    `json:"applications_max,omitempty"`
	BudgetMin       *string `json:"budget_min,omitempty"`
	BudgetMax       *string `json:"budget_max,omitempty"`
	Market          string  `json:"market,omitempty"`
	Customer        string  `json:"customer,omitempty"`
	Currency        string  `json:"currency,omitempty"`
	SourceURL       string  `json:"source_url,omitempty"`
}

func (f *ListFilter) Validate() error {
	if f.LossReason != "" && !slices.Contains(workflow.LossReasons, f.LossReason) {
		return apperr.Validation("Unknown loss reason")
	}
	for _, r := range []struct {
		min, max  *int
		low, high int
		name      string
	}{
		{f.FitMin, f.FitMax, 1, 5, "Fit"}, {f.ComplexityMin, f.ComplexityMax, 1, 5, "Complexity"},
		{f.ApplicationsMin, f.ApplicationsMax, 0, 2147483647, "Applications count"},
	} {
		if (r.min != nil && (*r.min < r.low || *r.min > r.high)) || (r.max != nil && (*r.max < r.low || *r.max > r.high)) ||
			(r.min != nil && r.max != nil && *r.min > *r.max) {
			return apperr.Validation(r.name + ": invalid filter range")
		}
	}
	for _, v := range []**string{&f.BudgetMin, &f.BudgetMax} {
		if *v != nil {
			n, err := normalizeAmount(**v)
			if err != nil {
				return err
			}
			*v = &n
		}
	}
	if f.BudgetMin != nil && f.BudgetMax != nil {
		lo, _ := new(big.Rat).SetString(*f.BudgetMin)
		hi, _ := new(big.Rat).SetString(*f.BudgetMax)
		if lo.Cmp(hi) > 0 {
			return apperr.Validation("Amount: minimum exceeds maximum")
		}
	}
	f.Currency = strings.ToUpper(strings.TrimSpace(f.Currency))
	if f.Currency != "" && !currencyRE.MatchString(f.Currency) {
		return apperr.Validation("Invalid currency filter")
	}
	if (f.BudgetMin != nil || f.BudgetMax != nil || f.Sort == "budget_amount") && f.Currency == "" {
		return apperr.Validation("Choose a currency when filtering or sorting amounts")
	}
	f.Market, f.Customer = strings.TrimSpace(f.Market), strings.TrimSpace(f.Customer)
	if utf8.RuneCountInString(f.Market) > 120 || utf8.RuneCountInString(f.Customer) > 300 {
		return apperr.Validation("Market or customer filter is too long")
	}
	if f.SourceURL != "" {
		v, err := normalizeURL(f.SourceURL)
		if err != nil {
			return err
		}
		f.SourceURL = v
	}
	if f.DeadlineFrom != nil && f.DeadlineTo != nil && !f.DeadlineFrom.Before(*f.DeadlineTo) {
		return apperr.Validation("Invalid deadline range")
	}
	return nil
}
