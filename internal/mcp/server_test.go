package mcp

import (
	"context"
	"log/slog"
	"slices"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"onceplatform/internal/config"
)

func TestToolsAndPrompts(t *testing.T) {
	s := &server{Deps: Deps{Cfg: &config.Config{BaseURL: "https://portal.example.kz"}, Log: slog.Default(), Version: "test"}}
	srv := s.newSDKServer()
	ctx := context.Background()
	ct, st := sdk.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"get_overview", "list_tickets", "get_ticket", "create_ticket", "update_ticket", "change_ticket_status",
		"save_technical_solution", "add_comment", "list_attachments", "read_attachment", "upload_attachment",
		"search",
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		if tool.Annotations == nil {
			t.Errorf("%s has no annotations", tool.Name)
			continue
		}
		if tool.Description == "" || tool.InputSchema == nil {
			t.Errorf("%s lacks description or input schema", tool.Name)
		}
		if !tool.Annotations.ReadOnlyHint && tool.Annotations.DestructiveHint == nil {
			t.Errorf("write tool %s must declare destructiveHint", tool.Name)
		}
		if slices.Contains([]string{"delete_ticket", "delete_attachment", "delete_client"}, tool.Name) {
			t.Errorf("deletion must not be exposed via MCP: %s", tool.Name)
		}
	}
	for _, w := range want {
		if !slices.Contains(names, w) {
			t.Errorf("tool %s is missing", w)
		}
	}
	if len(names) != len(want) {
		t.Errorf("expected %d tools, got %d: %v", len(want), len(names), names)
	}

	prompts, err := cs.ListPrompts(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(prompts.Prompts) != 1 || prompts.Prompts[0].Name != "analyze_tender" ||
		len(prompts.Prompts[0].Arguments) != 1 || !prompts.Prompts[0].Arguments[0].Required {
		t.Errorf("unexpected prompts: %+v", prompts.Prompts)
	}

	// Calls without an authenticated user must fail as tool errors.
	res, err := cs.CallTool(ctx, &sdk.CallToolParams{Name: "get_overview", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError {
		t.Error("unauthenticated tool call must return an error result")
	}
}
