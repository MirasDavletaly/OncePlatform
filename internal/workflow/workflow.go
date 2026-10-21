// Package workflow is the single place that defines roles, ticket statuses,
// the permission matrix and the status transition rules. Change the tables
// below to change who may do what; everything else (REST API, MCP tools,
// frontend button visibility) derives from them.
package workflow

import (
	"slices"

	"onceplatform/internal/apperr"
)

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

type Role string

const (
	RoleAdmin       Role = "admin"       // руководитель
	RoleCoordinator Role = "coordinator" // координатор
	RoleAnalyst     Role = "analyst"     // аналитик
)

// Roles lists all roles.
var Roles = []Role{RoleAdmin, RoleCoordinator, RoleAnalyst}

func (r Role) Valid() bool { return slices.Contains(Roles, r) }

// ---------------------------------------------------------------------------
// Statuses and close results
// ---------------------------------------------------------------------------

type Status string

const (
	StatusNew      Status = "new"      // Новое
	StatusAnalysis Status = "analysis" // В анализе
	StatusSolution Status = "solution" // Подготовка решения
	StatusSent     Status = "sent"     // Отправлено
	StatusClosed   Status = "closed"   // Закрыто
)

// Statuses lists statuses in workflow order.
var Statuses = []Status{StatusNew, StatusAnalysis, StatusSolution, StatusSent, StatusClosed}

func (s Status) Valid() bool { return slices.Contains(Statuses, s) }

// Index returns the position of s in the workflow, or -1.
func (s Status) Index() int { return slices.Index(Statuses, s) }

type CloseResult string

const (
	ResultWon       CloseResult = "won"       // Выигран
	ResultLost      CloseResult = "lost"      // Проигран
	ResultCancelled CloseResult = "cancelled" // Отменён
	ResultNoBid     CloseResult = "no_bid"    // Не участвовали
)

var CloseResults = []CloseResult{ResultWon, ResultLost, ResultCancelled, ResultNoBid}

func (r CloseResult) Valid() bool { return slices.Contains(CloseResults, r) }

// Via identifies the channel through which an action was performed.
type Via string

const (
	ViaWeb    Via = "web"
	ViaMCP    Via = "mcp"
	ViaSystem Via = "system"
)

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

type Permission string

const (
	PermView              Permission = "view"                // просмотр задач
	PermTicketCreate      Permission = "ticket.create"       // создание задач
	PermTicketEdit        Permission = "ticket.edit"         // редактирование основных полей
	PermSolutionEdit      Permission = "ticket.solution"     // редактирование технического решения
	PermFilesComments     Permission = "ticket.files"        // файлы и комментарии
	PermDelete            Permission = "delete"              // мягкое удаление задач и файлов
	PermUsersManage       Permission = "admin.users"         // пользователи
	PermAuditView         Permission = "admin.audit"         // журнал аудита
	PermOAuthClientsAdmin Permission = "admin.oauth_clients" // все OAuth-клиенты
)

var allRoles = []Role{RoleAdmin, RoleCoordinator, RoleAnalyst}

// permissionMatrix maps each permission to the roles that hold it.
var permissionMatrix = map[Permission][]Role{
	PermView:              allRoles,
	PermTicketCreate:      {RoleAdmin, RoleCoordinator},
	PermTicketEdit:        {RoleAdmin, RoleCoordinator},
	PermSolutionEdit:      {RoleAdmin, RoleAnalyst},
	PermFilesComments:     allRoles,
	PermDelete:            {RoleAdmin},
	PermUsersManage:       {RoleAdmin},
	PermAuditView:         {RoleAdmin},
	PermOAuthClientsAdmin: {RoleAdmin},
}

// AllPermissions lists every permission in a stable order.
var AllPermissions = []Permission{
	PermView, PermTicketCreate, PermTicketEdit, PermSolutionEdit, PermFilesComments,
	PermDelete, PermUsersManage, PermAuditView, PermOAuthClientsAdmin,
}

// Can reports whether role holds permission p.
func Can(role Role, p Permission) bool {
	return slices.Contains(permissionMatrix[p], role)
}

// PermissionsFor lists the permissions held by role (used by the frontend to
// hide unavailable buttons; the server re-checks every request).
func PermissionsFor(role Role) []Permission {
	var out []Permission
	for _, p := range AllPermissions {
		if Can(role, p) {
			out = append(out, p)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

// transitionRule describes a regular (non-admin-override) transition.
type transitionRule struct {
	From, To        Status
	Roles           []Role
	RequiresComment bool
	RequiresResult  bool
}

var transitionRules = []transitionRule{
	// Forward, one step at a time.
	{From: StatusNew, To: StatusAnalysis, Roles: []Role{RoleAdmin, RoleCoordinator}},
	{From: StatusAnalysis, To: StatusSolution, Roles: []Role{RoleAdmin, RoleAnalyst}},
	{From: StatusSolution, To: StatusSent, Roles: []Role{RoleAdmin, RoleAnalyst}},
	{From: StatusSent, To: StatusClosed, Roles: []Role{RoleAdmin}, RequiresResult: true},
	// Back to the previous step: any role, comment required. Leaving "closed"
	// is reopening and stays admin-only (handled by the admin override).
	{From: StatusAnalysis, To: StatusNew, Roles: allRoles, RequiresComment: true},
	{From: StatusSolution, To: StatusAnalysis, Roles: allRoles, RequiresComment: true},
	{From: StatusSent, To: StatusSolution, Roles: allRoles, RequiresComment: true},
}

// adminCanDoAnyTransition lets the admin perform any transition, including
// reopening closed tickets (closed → analysis).
const adminCanDoAnyTransition = true

// Transition describes a transition available to a role.
type Transition struct {
	To              Status `json:"to"`
	RequiresComment bool   `json:"requires_comment"`
	RequiresResult  bool   `json:"requires_result"`
	Backward        bool   `json:"backward"`
}

// IsBackward reports whether moving from → to goes back in the workflow.
func IsBackward(from, to Status) bool { return to.Index() < from.Index() }

// CheckTransition returns the transition description and whether role may perform it.
func CheckTransition(role Role, from, to Status) (Transition, bool) {
	t := Transition{
		To:             to,
		Backward:       IsBackward(from, to),
		RequiresResult: to == StatusClosed,
	}
	// Every backward move needs an explanation, regardless of role.
	t.RequiresComment = t.Backward
	if !from.Valid() || !to.Valid() || from == to {
		return t, false
	}
	for _, r := range transitionRules {
		if r.From == from && r.To == to && slices.Contains(r.Roles, role) {
			t.RequiresComment = t.RequiresComment || r.RequiresComment
			t.RequiresResult = t.RequiresResult || r.RequiresResult
			return t, true
		}
	}
	if adminCanDoAnyTransition && role == RoleAdmin {
		return t, true
	}
	return t, false
}

// AvailableTransitions lists the transitions role may perform from status from,
// in workflow order.
func AvailableTransitions(role Role, from Status) []Transition {
	var out []Transition
	for _, to := range Statuses {
		if t, ok := CheckTransition(role, from, to); ok {
			out = append(out, t)
		}
	}
	return out
}

// ValidateTransition checks permission and required inputs for a transition.
func ValidateTransition(role Role, from, to Status, comment string, result CloseResult) error {
	if !to.Valid() {
		return apperr.Validationf("Unknown status %q", to)
	}
	if from == to {
		return apperr.Validation("The task already has this status")
	}
	t, ok := CheckTransition(role, from, to)
	if !ok {
		return apperr.New(403, "transition_forbidden",
			"Your role cannot move a task from \""+StatusLabel(from)+"\" to \""+StatusLabel(to)+"\"")
	}
	if t.RequiresResult && !result.Valid() {
		return apperr.New(422, "result_required", "To close a task, choose a result: won, lost, cancelled or no bid")
	}
	if !t.RequiresResult && result != "" {
		return apperr.Validation("A result can only be set when closing a task")
	}
	if t.RequiresComment && len([]rune(trimSpace(comment))) < 3 {
		return apperr.New(422, "comment_required", "Moving a task back requires a comment explaining why")
	}
	return nil
}

// StatusLabel returns the English label of a status (used in server messages).
func StatusLabel(s Status) string {
	switch s {
	case StatusNew:
		return "New"
	case StatusAnalysis:
		return "Analysis"
	case StatusSolution:
		return "Preparing solution"
	case StatusSent:
		return "Sent"
	case StatusClosed:
		return "Closed"
	}
	return string(s)
}

// ResultLabel returns the English label of a close result.
func ResultLabel(r CloseResult) string {
	switch r {
	case ResultWon:
		return "Won"
	case ResultLost:
		return "Lost"
	case ResultCancelled:
		return "Cancelled"
	case ResultNoBid:
		return "No bid"
	}
	return string(r)
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\n' || s[start] == '\t' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\t' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

// Actor is the authenticated user performing an operation, together with the
// channel (web UI or MCP) and client IP. Services take an Actor explicitly and
// check permissions with Require.
type Actor struct {
	UserID string
	Name   string
	Role   Role
	Via    Via
	IP     string
}

// Can reports whether the actor holds permission p.
func (a Actor) Can(p Permission) bool { return Can(a.Role, p) }

// Require returns a forbidden error unless the actor holds permission p.
func (a Actor) Require(p Permission) error {
	if a.Can(p) {
		return nil
	}
	return apperr.Forbidden(forbiddenMessage(p))
}

func forbiddenMessage(p Permission) string {
	switch p {
	case PermTicketCreate:
		return "Only the admin and the coordinator can create tasks"
	case PermTicketEdit:
		return "Only the admin and the coordinator can edit the main fields of a task"
	case PermSolutionEdit:
		return "Only the admin and the analyst can edit the technical solution"
	case PermDelete:
		return "Only the admin can delete"
	case PermUsersManage, PermAuditView, PermOAuthClientsAdmin:
		return "This section is available to the admin only"
	}
	return "You do not have permission for this action"
}
