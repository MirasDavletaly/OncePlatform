/** recruiter: the CV database only (adds and edits CVs), no tasks */
export type Role = 'admin' | 'coordinator' | 'analyst' | 'recruiter'
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
  | 'cv.view'
  | 'cv.manage'
  | 'cv.delete'

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
  /** a one-time code was issued and not used yet */
  invite_pending?: boolean
  invite_expires_at?: string | null
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

// ---------------------------------------------------------------------------
// CV section
// ---------------------------------------------------------------------------

export interface CvJob {
  name: string | null
  position: string | null
  startDate: string | null
  endDate: string | null
  summary?: string
  prof?: string | null
  approx?: string
  /** country code (KZ) and city id (astana) or a city typed by hand; inferred = from a Kazakh legal form only */
  location?: CvPlace | null
}

export interface CvPlace {
  country: string | null
  city?: string | null
  inferred?: boolean
}

export interface CvProject {
  name: string
  role: string | null
  customer: string | null
  startDate: string | null
  endDate: string | null
  summary?: string
}

export interface CvProfile {
  basics: {
    name?: string | null
    label: string | null
    summary?: string | null
    email?: string | null
    phone?: string | null
    location: { city: string | null; cityId?: number | null; country?: string | null }
  }
  work: CvJob[]
  projects?: CvProject[]
  /** doc: the attached diploma or certificate that confirms the entry; fromDoc: the entry comes from it only */
  education: { institution: string; area: string | null; endDate: string | null; degree?: string | null; doc?: string; fromDoc?: boolean }[]
  skills: { name: string }[]
  languages: { language: string; fluency: string | null }[]
  certificates: { name: string; date: string | null; issuer?: string | null; doc?: string; fromDoc?: boolean }[]
  meta: {
    lang?: string
    totalMonths?: number
    totalYears?: number
    title?: { prof: string | null; approx?: string } | null
    sensitiveDetected?: string[]
    /** a profession of the taxonomy (prof) or a job title the candidate held (title) */
    positions?: { prof?: string; title?: string; level: 'junior' | 'middle' | 'senior'; years: number; skillMatch?: number }[]
    countries?: { country: string; years: number }[]
  }
}

export interface Candidate {
  id: string
  number: number
  code: string
  full_name?: string
  file_name?: string
  mime?: string
  size?: number
  status: 'pending' | 'ready' | 'failed'
  error?: string
  ocr: boolean
  profile: CvProfile | null
  consent_date: string
  consent_note?: string
  has_consent_file: boolean
  uploaded_by_name: string
  created_at: string
  updated_at: string
  anonymized: boolean
  documents?: CvDocument[]
  /** who recommended the candidate (cv.manage only) */
  referred_by?: string
  /** Claude's up-to-date translations of the profile's texts per interface language, keyed like "work.0.position" */
  translations?: Record<string, Record<string, string>>
  translation_status: Record<string, 'ok' | 'outdated' | 'missing'>
}

/** A company letterhead of the standard CV (Word export). */
export interface Letterhead {
  id: string
  name: string
  header: string
  footer: string
  updated_at: string | null
}

/** What the engine read from a diploma or certificate. */
export interface CvDocInfo {
  /** id: a visa, a passport or an identity card - kept as a file, never entered into the profile */
  kind: 'diploma' | 'certificate' | 'id'
  holder: string | null
  title: string | null
  issuer: string | null
  date: string | null
  expires: string | null
  number: string | null
  institution?: string | null
  area?: string | null
  degree?: string | null
  /** candidates whose names the document has (hits = name words found) */
  suggestions?: { id: string; hits: number }[]
  matched_by?: 'holder' | 'text'
}

export interface CvDocument {
  id: string
  candidate_id?: string
  candidate_code?: string
  candidate_name?: string
  file_name: string
  mime: string
  size: number
  status: 'pending' | 'ready' | 'failed'
  error?: string
  ocr: boolean
  info: CvDocInfo | null
  assigned?: 'auto' | 'manual'
  uploaded_by_name: string
  created_at: string
  delete_after?: string
}

export interface CvMeta {
  professions: { id: string; en: string; ru: string }[]
  skills: string[]
  languages: string[]
  levels: string[]
  degrees: string[]
  countries: { code: string; en: string; ru: string }[]
  cities: { id: string; country: string; en: string; ru: string }[]
}

export interface CvLang {
  language: string
  level?: string
}

export interface CvRole {
  title: string
  profession?: string
  count?: number
  min_years?: number
  skills_must?: string[]
  skills_nice?: string[]
  certificates?: string[]
  languages?: CvLang[]
  notes?: string
}

export interface CvWhy {
  mustMet: string[]
  mustMissing: string[]
  niceMet: string[]
  niceMissing: string[]
  certMet: string[]
  certMissing: string[]
  years: number
  totalYears: number
  minYears: number
  profession: string | null
  titleMatch: number | null
  titleApprox: boolean
  languages: { language: string; need: string | null; have: string | null; inferred: boolean; listed: boolean; ok: boolean }[]
}

export interface CvMatchRow {
  candidate_id: string
  code: string
  name?: string
  label?: string
  score: number
  fails: string[]
  parts: Record<string, number>
  why: CvWhy
}

export interface TicketCv {
  requirements: { roles: CvRole[]; updated_by_name?: string; via?: string; updated_at: string | null }
  matches: { role: CvRole; results: CvMatchRow[] }[]
  candidates_total: number
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
