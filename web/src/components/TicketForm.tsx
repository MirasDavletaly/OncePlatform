import { Link } from 'react-router'
import { api } from '../lib/api'
import { shortlistValues, shortlistPayload, type ShortlistValues } from '../lib/shortlist'
import { ShortlistFields } from './Shortlist'
import { useEffect, useState, type FormEvent } from 'react'
import { FileSpreadsheet, FileText, FileType2, X } from 'lucide-react'
import { fmt, t } from '../i18n'
import { formatSize, toLocalInput } from '../lib/format'
import { useSession } from '../lib/session'
import type { Ticket } from '../lib/types'
import { Dropzone, UserSelect } from './inputs'
import { MarkdownEditor } from './markdown'
import { Button, Field, IconButton, Input, Select } from './ui'

/** Extensions accepted for specification files on the new-task form. */
const TZ_EXTENSIONS = ['pdf', 'docx', 'xlsx']

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return <FileType2 className="size-4 text-danger" aria-hidden />
  if (ext === 'xlsx') return <FileSpreadsheet className="size-4 text-ok" aria-hidden />
  return <FileText className="size-4 text-info" aria-hidden />
}

export interface TicketFormValues extends ShortlistValues {
  title: string
  priority: string
  source_url: string
  deadline: string
  assignee_id: string // "" = everyone
  description: string
}

export function valuesFromTicket(tk?: Ticket): TicketFormValues {
  return {
    ...shortlistValues(tk),
    title: tk?.title ?? '',
    priority: tk?.priority ?? 'normal',
    source_url: tk?.source_url ?? '',
    deadline: toLocalInput(tk?.deadline),
    assignee_id: tk?.assignee_id ?? '',
    description: tk?.description ?? '',
  }
}

/** API payload; "" assigns the task to everyone and clears the deadline/link. */
export function payloadFromValues(v: TicketFormValues, withDescription = true) {
  const p: Record<string, string | number | null> = {
    ...shortlistPayload(v),
    title: v.title,
    priority: v.priority,
    source_url: v.source_url,
    deadline: v.deadline,
    assignee_id: v.assignee_id,
  }
  if (withDescription) p.description = v.description
  return p
}

/**
 * The task form: title, priority, source link, deadline, assignee
 * ("Everyone" or a person) and an optional Markdown description.
 */
export function TicketForm({
  initial,
  ticketId,
  submitLabel,
  onSubmit,
  onCancel,
  busy,
  error,
  showDescription = true,
  withFiles = false,
  progress,
}: {
  ticketId?: string
  initial: TicketFormValues
  submitLabel: string
  onSubmit: (v: TicketFormValues, files: File[]) => void
  onCancel?: () => void
  busy?: boolean
  error?: string
  showDescription?: boolean
  /** Show the "Specification files" picker (new task form). */
  withFiles?: boolean
  /** Progress message shown while the task is created and files upload. */
  progress?: string
}) {
  const { meta } = useSession()
  const [v, setV] = useState(initial)
  const [duplicate, setDuplicate] = useState<{ number: string; title: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkFailed, setCheckFailed] = useState(false)
  useEffect(() => {
    setDuplicate(null)
    setCheckFailed(false)
    if (!v.source_url.trim() || (ticketId && v.source_url === initial.source_url)) { setChecking(false); return }
    let active = true
    setChecking(true)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ source_url: v.source_url, ...(ticketId ? { exclude_id: ticketId } : {}) })
      api.get<{ duplicate: { number: string; title: string } | null }>('/tickets/source-check?' + params)
        .then((data) => { if (active) setDuplicate(data.duplicate) })
        .catch(() => { if (active) setCheckFailed(true) })
        .finally(() => { if (active) setChecking(false) })
    }, 350)
    return () => { active = false; clearTimeout(timer) }
  }, [v.source_url, ticketId, initial.source_url, error])
  const [files, setFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState('')
  const set = <K extends keyof TicketFormValues>(k: K, val: TicketFormValues[K]) => setV((s) => ({ ...s, [k]: val }))

  const addFiles = (picked: File[]) => {
    const maxBytes = meta.upload_max_mb * 1024 * 1024
    const errors: string[] = []
    const ok: File[] = []
    for (const f of picked) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
      if (!TZ_EXTENSIONS.includes(ext)) errors.push(fmt(t.ticket.tzWrongType, { name: f.name }))
      else if (f.size > maxBytes) errors.push(fmt(t.files.failed, { name: f.name, error: fmt(t.files.sizeLimit, { mb: meta.upload_max_mb }) }))
      else ok.push(f)
    }
    setFileError(errors.join('\n'))
    setFiles((cur) => [...cur, ...ok.filter((f) => !cur.some((c) => c.name === f.name && c.size === f.size))])
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!duplicate) onSubmit(v, files)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Field label={t.ticket.title} htmlFor="f-title">
        <Input
          id="f-title"
          required
          autoFocus
          maxLength={300}
          value={v.title}
          placeholder={t.ticket.titlePlaceholder}
          onChange={(e) => set('title', e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.ticket.priority} htmlFor="f-priority">
          <Select id="f-priority" value={v.priority} onChange={(e) => set('priority', e.target.value)}>
            {Object.entries(t.priority).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.ticket.assignee} htmlFor="f-assignee" hint={t.ticket.assigneeHint}>
          <UserSelect id="f-assignee" value={v.assignee_id} onChange={(val) => set('assignee_id', val)} />
        </Field>
      </div>

      <Field label={t.ticket.sourceUrl} htmlFor="f-url">
        <Input
          id="f-url"
          inputMode="url"
          placeholder={t.ticket.sourceUrlPlaceholder}
          value={v.source_url}
          onChange={(e) => set('source_url', e.target.value)}
        />
      </Field>

      {checking && <p role="status" className="text-sm text-muted">{t.shortlist.checking}</p>}
      {checkFailed && <p role="status" className="text-sm text-muted">{t.shortlist.checkFailed}</p>}
      {duplicate && <p role="alert" className="rounded-lg bg-gold-soft p-3 text-sm">
        {t.shortlist.duplicate} <Link className="text-accent underline" to={'/tickets/' + duplicate.number}>{duplicate.number} — {duplicate.title}</Link>
      </p>}

      <ShortlistFields value={v} set={set} />

      <Field label={t.ticket.deadline} htmlFor="f-deadline" hint={fmt(t.ticket.deadlineHint, { tz: meta.timezone })}>
        <Input
          id="f-deadline"
          type="datetime-local"
          className="sm:max-w-xs"
          value={v.deadline}
          onChange={(e) => set('deadline', e.target.value)}
        />
      </Field>

      {showDescription && (
        <Field label={`${t.ticket.description} (${t.common.optional})`} htmlFor="f-desc">
          <MarkdownEditor
            id="f-desc"
            value={v.description}
            onChange={(val) => set('description', val)}
            placeholder={t.ticket.descriptionPlaceholder}
            minRows={6}
          />
        </Field>
      )}

      {withFiles && (
        <Field label={`${t.ticket.tzFiles} (${t.common.optional})`}>
          <Dropzone
            compact
            accept=".pdf,.docx,.xlsx"
            maxMb={meta.upload_max_mb}
            disabled={busy}
            title={t.ticket.tzDrop}
            hint={fmt(t.ticket.tzFilesHint, { mb: meta.upload_max_mb })}
            onFiles={addFiles}
          />
          {fileError && <p className="text-[13px] whitespace-pre-line text-danger">{fileError}</p>}
          {files.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {files.map((f) => (
                <li key={f.name + f.size} className="flex items-center gap-3 px-3 py-2">
                  {fileIcon(f.name)}
                  <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                  <span className="num text-[12px] text-muted">{formatSize(f.size)}</span>
                  <IconButton
                    label={fmt(t.ticket.removeFile, { name: f.name })}
                    className="size-7"
                    disabled={busy}
                    onClick={() => setFiles((cur) => cur.filter((c) => c !== f))}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Field>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>}
      {busy && progress && <p className="text-sm text-muted">{progress}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>{t.common.cancel}</Button>}
        <Button type="submit" variant="primary" loading={busy} disabled={!v.title.trim() || !!duplicate}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
