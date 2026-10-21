package workflow

import (
	"testing"

	"onceplatform/internal/apperr"
)

func TestPermissionMatrix(t *testing.T) {
	type row struct {
		perm                        Permission
		admin, coordinator, analyst bool
	}
	// Mirrors the table in the specification (section 3).
	rows := []row{
		{PermView, true, true, true},
		{PermTicketCreate, true, true, false},
		{PermTicketEdit, true, true, false},
		{PermSolutionEdit, true, false, true},
		{PermFilesComments, true, true, true},
		{PermDelete, true, false, false},
		{PermUsersManage, true, false, false},
		{PermAuditView, true, false, false},
		{PermOAuthClientsAdmin, true, false, false},
	}
	if len(rows) != len(AllPermissions) {
		t.Fatalf("test covers %d permissions, matrix has %d", len(rows), len(AllPermissions))
	}
	for _, r := range rows {
		for role, want := range map[Role]bool{RoleAdmin: r.admin, RoleCoordinator: r.coordinator, RoleAnalyst: r.analyst} {
			if got := Can(role, r.perm); got != want {
				t.Errorf("Can(%s, %s) = %v, want %v", role, r.perm, got, want)
			}
		}
	}
}

func TestPermissionsForRole(t *testing.T) {
	if got := len(PermissionsFor(RoleAdmin)); got != len(AllPermissions) {
		t.Errorf("admin should hold all %d permissions, holds %d", len(AllPermissions), got)
	}
	for _, p := range PermissionsFor(RoleAnalyst) {
		if p == PermTicketEdit || p == PermDelete {
			t.Errorf("analyst must not hold %s", p)
		}
	}
	if Can(Role("ghost"), PermView) {
		t.Error("unknown role must hold no permissions")
	}
}

func TestTransitions(t *testing.T) {
	type tc struct {
		role     Role
		from, to Status
		allowed  bool
		comment  bool
		result   bool
	}
	cases := []tc{
		// new → analysis: admin, coordinator
		{RoleAdmin, StatusNew, StatusAnalysis, true, false, false},
		{RoleCoordinator, StatusNew, StatusAnalysis, true, false, false},
		{RoleAnalyst, StatusNew, StatusAnalysis, false, false, false},
		// analysis → solution, solution → sent: admin, analyst
		{RoleAdmin, StatusAnalysis, StatusSolution, true, false, false},
		{RoleAnalyst, StatusAnalysis, StatusSolution, true, false, false},
		{RoleCoordinator, StatusAnalysis, StatusSolution, false, false, false},
		{RoleAnalyst, StatusSolution, StatusSent, true, false, false},
		{RoleCoordinator, StatusSolution, StatusSent, false, false, false},
		// sent → closed: admin only, result required
		{RoleAdmin, StatusSent, StatusClosed, true, false, true},
		{RoleCoordinator, StatusSent, StatusClosed, false, false, true},
		{RoleAnalyst, StatusSent, StatusClosed, false, false, true},
		// back one step: any role with comment
		{RoleAnalyst, StatusAnalysis, StatusNew, true, true, false},
		{RoleCoordinator, StatusSolution, StatusAnalysis, true, true, false},
		{RoleAnalyst, StatusSent, StatusSolution, true, true, false},
		{RoleAdmin, StatusSent, StatusSolution, true, true, false},
		// skipping steps: only admin
		{RoleCoordinator, StatusNew, StatusSolution, false, false, false},
		{RoleAnalyst, StatusAnalysis, StatusSent, false, false, false},
		{RoleAdmin, StatusNew, StatusSent, true, false, false},
		{RoleAdmin, StatusNew, StatusClosed, true, false, true},
		// back more than one step: only admin, comment required
		{RoleCoordinator, StatusSent, StatusNew, false, true, false},
		{RoleAdmin, StatusSent, StatusNew, true, true, false},
		// reopening closed tickets: only admin
		{RoleAdmin, StatusClosed, StatusAnalysis, true, true, false},
		{RoleAdmin, StatusClosed, StatusSent, true, true, false},
		{RoleCoordinator, StatusClosed, StatusSent, false, true, false},
		{RoleAnalyst, StatusClosed, StatusAnalysis, false, true, false},
		// no-op and invalid
		{RoleAdmin, StatusNew, StatusNew, false, false, false},
		{RoleAdmin, StatusNew, Status("bogus"), false, false, false},
	}
	for _, c := range cases {
		tr, ok := CheckTransition(c.role, c.from, c.to)
		if ok != c.allowed {
			t.Errorf("%s: %s→%s allowed=%v, want %v", c.role, c.from, c.to, ok, c.allowed)
			continue
		}
		if c.to.Valid() && c.from != c.to {
			if tr.RequiresComment != c.comment {
				t.Errorf("%s: %s→%s requiresComment=%v, want %v", c.role, c.from, c.to, tr.RequiresComment, c.comment)
			}
			if tr.RequiresResult != c.result {
				t.Errorf("%s: %s→%s requiresResult=%v, want %v", c.role, c.from, c.to, tr.RequiresResult, c.result)
			}
		}
	}
}

func TestAvailableTransitions(t *testing.T) {
	got := AvailableTransitions(RoleAnalyst, StatusAnalysis)
	if len(got) != 2 || got[0].To != StatusNew || got[1].To != StatusSolution {
		t.Fatalf("analyst from analysis: got %+v", got)
	}
	if !got[0].Backward || !got[0].RequiresComment {
		t.Errorf("analysis→new must be backward with comment: %+v", got[0])
	}
	if n := len(AvailableTransitions(RoleAdmin, StatusClosed)); n != 4 {
		t.Errorf("admin from closed should have 4 transitions, got %d", n)
	}
	if n := len(AvailableTransitions(RoleCoordinator, StatusClosed)); n != 0 {
		t.Errorf("coordinator from closed should have none, got %d", n)
	}
	if n := len(AvailableTransitions(RoleCoordinator, StatusSent)); n != 1 {
		t.Errorf("coordinator from sent should only go back, got %d", n)
	}
}

func TestValidateTransition(t *testing.T) {
	code := func(err error) string {
		if err == nil {
			return ""
		}
		e, ok := apperr.As(err)
		if !ok {
			return "?"
		}
		return e.Code
	}
	if c := code(ValidateTransition(RoleAdmin, StatusSent, StatusClosed, "", "")); c != "result_required" {
		t.Errorf("closing without result: %q", c)
	}
	if c := code(ValidateTransition(RoleAdmin, StatusSent, StatusClosed, "", "maybe")); c != "result_required" {
		t.Errorf("closing with invalid result: %q", c)
	}
	if err := ValidateTransition(RoleAdmin, StatusSent, StatusClosed, "", ResultWon); err != nil {
		t.Errorf("closing with result: %v", err)
	}
	if c := code(ValidateTransition(RoleAnalyst, StatusSolution, StatusAnalysis, "  ", "")); c != "comment_required" {
		t.Errorf("going back without comment: %q", c)
	}
	if err := ValidateTransition(RoleAnalyst, StatusSolution, StatusAnalysis, "Нужны уточнения", ""); err != nil {
		t.Errorf("going back with comment: %v", err)
	}
	if c := code(ValidateTransition(RoleCoordinator, StatusSent, StatusClosed, "", ResultWon)); c != "transition_forbidden" {
		t.Errorf("coordinator closing: %q", c)
	}
	if c := code(ValidateTransition(RoleAdmin, StatusNew, StatusAnalysis, "", ResultWon)); c != "validation_error" {
		t.Errorf("result on non-closing transition: %q", c)
	}
	if c := code(ValidateTransition(RoleAdmin, StatusNew, StatusNew, "", "")); c != "validation_error" {
		t.Errorf("same status: %q", c)
	}
}

func TestActorRequire(t *testing.T) {
	a := Actor{Role: RoleAnalyst}
	if err := a.Require(PermSolutionEdit); err != nil {
		t.Errorf("analyst should edit solution: %v", err)
	}
	err := a.Require(PermTicketEdit)
	if e, ok := apperr.As(err); !ok || e.Status != 403 {
		t.Errorf("analyst editing ticket fields should be 403, got %v", err)
	}
}
