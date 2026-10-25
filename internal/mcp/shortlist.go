package mcp

import (
	"onceplatform/internal/apperr"
	"onceplatform/internal/tickets"
)

type shortlistInput struct {
	FitScore          *int    `json:"fit_score,omitempty" jsonschema:"Fit score from 1 to 5; leave unknown unset"`
	Complexity        *int    `json:"complexity,omitempty" jsonschema:"Complexity from 1 (low) to 5 (high)"`
	Market            *string `json:"market,omitempty" jsonschema:"Market or platform, at most 120 characters"`
	ApplicationsCount *int    `json:"applications_count,omitempty" jsonschema:"Non-negative application count; zero is a confirmed zero"`
	BudgetAmount      *string `json:"budget_amount,omitempty" jsonschema:"Non-negative decimal string, at most 2 decimal places, e.g. 150000.00"`
	Currency          *string `json:"currency,omitempty" jsonschema:"Three-letter currency code; default KZT"`
	Customer          *string `json:"customer,omitempty" jsonschema:"Customer name, at most 300 characters"`
}

func (in shortlistInput) values() tickets.Shortlist {
	s := tickets.Shortlist{FitScore: in.FitScore, Complexity: in.Complexity, ApplicationsCount: in.ApplicationsCount, BudgetAmount: in.BudgetAmount}
	if in.Market != nil {
		s.Market = *in.Market
	}
	if in.Customer != nil {
		s.Customer = *in.Customer
	}
	if in.Currency != nil {
		s.Currency = *in.Currency
	}
	return s
}

func (in shortlistInput) patch(clear []string) (tickets.ShortlistPatch, error) {
	p := tickets.ShortlistPatch{
		FitScore:          tickets.Optional[int]{Set: in.FitScore != nil, Value: in.FitScore},
		Complexity:        tickets.Optional[int]{Set: in.Complexity != nil, Value: in.Complexity},
		ApplicationsCount: tickets.Optional[int]{Set: in.ApplicationsCount != nil, Value: in.ApplicationsCount},
		BudgetAmount:      tickets.Optional[string]{Set: in.BudgetAmount != nil, Value: in.BudgetAmount},
		Market:            in.Market, Customer: in.Customer, Currency: in.Currency,
	}
	for _, field := range clear {
		var hasValue bool
		switch field {
		case "fit_score":
			hasValue = in.FitScore != nil
			p.FitScore = tickets.Optional[int]{Set: true}
		case "complexity":
			hasValue = in.Complexity != nil
			p.Complexity = tickets.Optional[int]{Set: true}
		case "applications_count":
			hasValue = in.ApplicationsCount != nil
			p.ApplicationsCount = tickets.Optional[int]{Set: true}
		case "budget_amount":
			hasValue = in.BudgetAmount != nil
			p.BudgetAmount = tickets.Optional[string]{Set: true}
		default:
			return p, apperr.Validation("Unknown clear_fields entry: " + field)
		}
		if hasValue {
			return p, apperr.Validation("Cannot both set and clear " + field)
		}
	}
	return p, nil
}
