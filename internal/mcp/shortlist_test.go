package mcp

import (
	"encoding/json"
	"slices"
	"testing"

	"onceplatform/internal/workflow"
)

func TestShortlistSchemasAndMapping(t *testing.T) {
	createSchema := inputSchema[createTicketInput](nil)
	for _, field := range []string{"fit_score", "complexity", "market", "applications_count", "budget_amount", "currency", "customer"} {
		if createSchema.Properties[field] == nil || slices.Contains(createSchema.Required, field) {
			t.Errorf("create field %s missing or required", field)
		}
		if inputSchema[updateTicketInput](nil).Properties[field] == nil {
			t.Errorf("update field %s missing", field)
		}
	}
	listSchema := inputSchema[listTicketsInput](nil)
	for _, field := range []string{"fit_min", "fit_max", "complexity_min", "complexity_max", "applications_min", "applications_max", "budget_min", "budget_max", "currency", "market", "customer", "source_url", "loss_reason"} {
		if listSchema.Properties[field] == nil || slices.Contains(listSchema.Required, field) {
			t.Errorf("list field %s missing or required", field)
		}
	}
	lossSchema := inputSchema[changeStatusInput](map[string][]string{"loss_reason": workflow.LossReasons})
	if lossSchema.Properties["loss_reason"] == nil || len(lossSchema.Properties["loss_reason"].Enum) != 4 {
		t.Fatal("loss schema lacks four reasons")
	}
	var in updateTicketInput
	if err := json.Unmarshal([]byte(`{"ticket_id":"T-2026-0001","applications_count":0,"budget_amount":"9007199254740992.01","clear_fields":["fit_score"]}`), &in); err != nil {
		t.Fatal(err)
	}
	p, err := in.shortlistInput.patch(in.ClearFields)
	if err != nil || !p.FitScore.Set || p.FitScore.Value != nil || p.Complexity.Set || !p.ApplicationsCount.Set || *p.ApplicationsCount.Value != 0 || *p.BudgetAmount.Value != "9007199254740992.01" {
		t.Fatalf("patch %+v: %v", p, err)
	}
	if _, err := in.shortlistInput.patch([]string{"applications_count"}); err == nil {
		t.Fatal("simultaneous clear/set accepted")
	}
	if _, err := in.shortlistInput.patch([]string{"title"}); err == nil {
		t.Fatal("unknown clear accepted")
	}
	values := in.shortlistInput.values()
	if *values.ApplicationsCount != 0 || *values.BudgetAmount != "9007199254740992.01" {
		t.Fatalf("create mapping %+v", values)
	}
}
