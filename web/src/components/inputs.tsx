import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api } from '../lib/api'
import type { User } from '../lib/types'
import { cn } from '../lib/utils'
import { Select, Textarea } from './ui'

// ---------------------------------------------------------------------------
// Data-backed selects
// ---------------------------------------------------------------------------

export function useUsers(includeInactive = false) {
  return useQuery({
    queryKey: ['users', includeInactive],
    queryFn: () => api.get<{ items: User[] }>(`/users${includeInactive ? '?include_inactive=1' : ''}`),
    staleTime: 60_000,
    select: (d) => d.items,
  })
}

/** Assignee picker: "Everyone" (empty value) or a specific person. */
export function UserSelect({
  value,
  onChange,
  emptyLabel = t.common.everyone,
  id,
}: {
  value: string
  onChange: (v: string) => void
  emptyLabel?: string
  id?: string
}) {
  const { data = [] } = useUsers()
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {data.map((u) => (
        <option key={u.id} value={u.id}>
          {u.full_name} · {t.role[u.role]}
        </option>
      ))}
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Comment box with @mention autocomplete
// ---------------------------------------------------------------------------

/** Handle used in @mentions: the user's login. */
export function mentionHandle(u: User): string {
  return u.username
}

export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 3,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
  rows?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const { data: users = [] } = useUsers()
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const matches = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    return users
      .filter((u) => u.full_name.toLowerCase().includes(q) || mentionHandle(u).toLowerCase().includes(q))
      .slice(0, 6)
  }, [query, users])

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const m = /(^|[^\p{L}\p{N}_.@])@([\p{L}\p{N}._-]*)$/u.exec(before)
    setQuery(m ? m[2] : null)
    setActive(0)
  }

  const choose = (u: User) => {
    const ta = ref.current
    if (!ta) return
    const caret = ta.selectionStart
    const before = value.slice(0, caret).replace(/@([\p{L}\p{N}._-]*)$/u, '@' + mentionHandle(u) + ' ')
    const next = before + value.slice(caret)
    onChange(next)
    setQuery(null)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(before.length, before.length)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(matches[active])
        return
      }
      if (e.key === 'Escape') {
        setQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          detect(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => detect(value, (e.target as HTMLTextAreaElement).selectionStart)}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        className="resize-y"
      />
      {matches.length > 0 && (
        <ul
          role="listbox"
          aria-label={t.comments.mentionHint}
          className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-xl"
        >
          {matches.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(u)
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm',
                  i === active ? 'bg-accent-soft' : 'hover:bg-surface-2',
                )}
              >
                <span className="truncate">{u.full_name}</span>
                <span className="num text-[12px] text-muted">@{mentionHandle(u)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File drop zone
// ---------------------------------------------------------------------------

const ALL_ALLOWED = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.zip,.txt,.md,.csv'

export function Dropzone({
  onFiles,
  maxMb,
  disabled,
  accept = ALL_ALLOWED,
  title,
  hint,
  compact,
}: {
  onFiles: (files: File[]) => void
  maxMb: number
  disabled?: boolean
  accept?: string
  title?: string
  hint?: string
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (disabled) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length) onFiles(files)
  }
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 text-center transition-colors',
        compact ? 'py-5' : 'py-8',
        over ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2',
        disabled && 'opacity-60',
      )}
    >
      <Upload className="size-6 text-accent" aria-hidden />
      <p className="text-sm font-medium">{title ?? t.files.drop}</p>
      <p className="max-w-lg text-[12px] text-muted">{hint ?? fmt(t.files.allowed, { mb: maxMb })}</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="mt-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-line-strong"
      >
        {t.files.choose}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onFiles(files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Renders a search snippet, turning ⟦…⟧ markers (or plain query matches) into <mark>. */
export function Highlight({ text, marks, query }: { text: string; marks: [string, string]; query?: string }) {
  const [start, stop] = marks
  if (text.includes(start)) {
    const parts: { s: string; hit: boolean }[] = []
    let rest = text
    while (rest) {
      const i = rest.indexOf(start)
      if (i < 0) {
        parts.push({ s: rest, hit: false })
        break
      }
      if (i > 0) parts.push({ s: rest.slice(0, i), hit: false })
      const j = rest.indexOf(stop, i + start.length)
      if (j < 0) {
        parts.push({ s: rest.slice(i + start.length), hit: true })
        break
      }
      parts.push({ s: rest.slice(i + start.length, j), hit: true })
      rest = rest.slice(j + stop.length)
    }
    return (
      <>
        {parts.map((p, i) =>
          p.hit ? (
            <mark key={i} className="rounded-sm bg-gold-soft px-0.5 text-ink">
              {p.s}
            </mark>
          ) : (
            <span key={i}>{p.s}</span>
          ),
        )}
      </>
    )
  }
  const q = query?.trim()
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-gold-soft px-0.5 text-ink">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}
