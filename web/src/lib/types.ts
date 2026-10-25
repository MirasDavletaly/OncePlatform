export type Role = 'admin' | 'coordinator' | 'analyst'
export type Status = 'new' | 'analysis' | 'solution' | 'sent' | 'closed'
export type CloseResult = 'won' | 'lost' | 'cancelled' | 'no_bid'
export type Permission =
  | 'view'
  | 'ticket.create'
  | 'ticket.edit'
  | 'ticket.solution'
  | 'ticket.files'
  | 'delete'
  | 'admin.users'
  | 'admin.audit'
  | 'admin.oauth_clients'

export interface User {
  id: string
  username: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  language: 'en' | 'ru'
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface Me {
  user: User
  permissions: Permission[]
  csrf_token?: string
}

export interface Meta {
  app_name: string
  version: string
  base_url: string
  mcp_url: string
  https: boolean
  timezone: string
  upload_max_mb: number
  allowed_extensions: string[]
  statuses: Status[]
  close_results: CloseResult[]
  priorities: string[]
  languages: string[]
  file_categories: string[]
  roles: Role[]
  search_marks: [string, string]
}

export interface Transition {
  to: Status
  requires_comment: boolean
  requires_result: boolean
  backward: boolean
}

export interface Ticket {
  fit_score: number | null
  complexity: number | null
  market: string
  applications_count: number | null
  budget_amount: string | null
  currency: string
  customer: string
  loss_reason: string
  id: string
  number: string
  title: string
  description?: string
  source_url: string
  deadline: string | null
  priority: string
  status: Status
  close_result: string
  closed_at: string | null
  assignee_id: string | null
  assignee_name: string | null
  created_by: string
  created_by_name: string
  technical_solution?: string
  comments_count: number
  attachments_count: number
  created_at: string
  updated_at: string
  transitions?: Transition[]
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface AuditRecord {
  id: string
  user_id: string | null
  user_name: string
  action: string
  entity_type: string
  entity_id: string | null
  details: Record<string, unknown>
  via: 'web' | 'mcp' | 'system'
  ip?: string
  created_at: string
}

export interface Overview {
  lost_by_reason: Record<string, number>
  counts: Record<string, number>
  closed_by_result: Record<string, number>
  total: number
  my_tickets: Ticket[]
  upcoming_deadlines: Ticket[]
  overdue: Ticket[]
  activity?: AuditRecord[]
}

export interface StatusChange {
  loss_reason: string
  id: string
  from_status: string | null
  to_status: string
  close_result: string
  changed_by: string
  changed_by_name: string
  comment: string
  via: string
  created_at: string
}

export interface SolutionVersion {
  id: string
  ticket_id: string
  body?: string
  length: number
  author_id: string
  author_name: string
  via: string
  created_at: string
}

export interface Comment {
  id: string
  ticket_id: string
  author_id: string
  author_name: string
  body: string
  via: string
  created_at: string
  edited_at: string | null
}

export interface Attachment {
  id: string
  ticket_id: string
  ticket_number: string
  original_name: string
  mime: string
  size: number
  sha256: string
  category: string
  extraction_status: 'pending' | 'done' | 'failed' | 'unsupported'
  extraction_error?: string
  text_length: number
  uploaded_by: string
  uploaded_by_name: string
  via: string
  created_at: string
}

export interface TextChunk {
  attachment_id: string
  name: string
  extraction_status: string
  extraction_error?: string
  offset: number
  text: string
  total_length: number
  next_offset: number | null
}

export interface SearchResult {
  kind: 'ticket' | 'comment' | 'attachment'
  id: string
  ticket_id: string | null
  ticket_number: string | null
  title: string
  context: string
  snippet: string
  rank: number
  updated_at: string
}

export interface SearchResponse {
  query: string
  mark_start: string
  mark_stop: string
  total: number
  groups: { kind: SearchResult['kind']; total: number; items: SearchResult[] }[]
}

export interface Notification {
  id: string
  type: string
  ticket_id: string | null
  ticket_number: string | null
  ticket_title: string | null
  actor_id: string | null
  actor_name: string | null
  text: string
  read_at: string | null
  created_at: string
}

export interface APIToken {
  id: string
  name: string
  prefix: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface Grant {
  client_id: string
  client_name: string
  client_uri: string
  redirect_host: string
  authorized_at: string
  last_used_at: string | null
  active_tokens: number
}

export interface OAuthClient {
  id: string
  client_id: string
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  token_endpoint_auth_method: string
  client_uri: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  users: string[]
  active_tokens: number
}
