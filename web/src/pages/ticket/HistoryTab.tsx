import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fmt, t } from '../../i18n'
import { api } from '../../lib/api'
import { formatDateTime, formatNumber } from '../../lib/format'
import type { AuditRecord, StatusChange, Ticket } from '../../lib/types'
import { cn } from '../../lib/utils'
import { StatusBadge, ViaBadge, statusDot } from '../../components/badges'
import { Card, EmptyState, ErrorState, Loading } from '../../components/ui'

type D = Record<string, unknown>
type Change = { from?: unknown; to?: unknown; changed?: boolean }

function s(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function fieldValue(field: string, v: unknown): string {
  if (field === 'assignee_id' && (v === null || v === undefined)) return t.common.everyone
  if (v === null || v === undefined || v === '') return '—'
  switch (field) {
    case 'priority':
      return t.priority[s(v)] ?? s(v)
    case 'deadline':
      return formatDateTime(s(v))
    default:
      return typeof v === 'string' ? v : JSON.stringify(v)
  }
}

function describe(r: AuditRecord): { text: string; body?: ReactNode } {
  const d = r.details as D
  switch (r.action) {
    case 'ticket.create':
      return { text: t.history.created }
    case 'ticket.delete':
      return { text: t.history.deleted }
    case 'ticket.status_change': {
      const to = t.status[s(d.to)] ?? s(d.to)
      const from = t.status[s(d.from)] ?? s(d.from)
      const text = s(d.result)
        ? fmt(t.history.closed, { result: t.result[s(d.result)] ?? s(d.result) })
        : fmt(t.history.statusFrom, { from, to })
      return {
        text: text + (s(d.loss_reason) ? ' · ' + (t.lossReasons[s(d.loss_reason)] ?? s(d.loss_reason)) : ''),
        body: s(d.comment) ? (
          <p className="mt-1.5 rounded-lg bg-gold-soft/60 px-3 py-2 text-[13px]">
            <span className="font-medium text-gold">{t.history.reason}:</span> {s(d.comment)}
          </p>
        ) : undefined,
      }
    }
    case 'ticket.update': {
      const changes = (d.changes ?? {}) as Record<string, Change>
      const names = Object.keys(changes).map((k) => t.history.fieldNames[k] ?? k)
      return {
        text: fmt(t.history.changed, { fields: names.join(', ') }),
        body: (
          <ul className="mt-1.5 flex flex-col gap-0.5 text-[13px] text-muted">
            {Object.entries(changes)
              .filter(([, c]) => !c.changed)
              .map(([k, c]) => (
                <li key={k}>
                  <span className="text-ink">{t.history.fieldNames[k] ?? k}:</span>{' '}
                  <span className="line-through decoration-line-strong">{fieldValue(k, c.from)}</span> → {fieldValue(k, c.to)}
                </li>
              ))}
          </ul>
        ),
      }
    }
    case 'ticket.solution_save':
      return d.restored_from
        ? { text: t.history.solutionRestored }
        : { text: fmt(t.history.solution, { n: formatNumber(Number(d.length ?? 0)) }) }
    case 'comment.create':
      return {
        text: t.history.comment,
        body: s(d.excerpt) ? <p className="mt-1 line-clamp-2 text-[13px] text-muted">{s(d.excerpt)}</p> : undefined,
      }
    case 'comment.update':
      return { text: t.history.commentEdit }
    case 'comment.delete':
      return { text: t.history.commentDelete }
    case 'attachment.upload':
      return { text: fmt(t.history.upload, { name: s(d.name) }) }
    case 'attachment.update':
      return { text: fmt(t.history.fileUpdate, { name: s(d.name) }) }
    case 'attachment.delete':
      return { text: fmt(t.history.fileDelete, { name: s(d.name) }) }
  }
  return { text: r.action }
}

export function HistoryTab({ ticket }: { ticket: Ticket }) {
  const q = useQuery({
    queryKey: ['history', ticket.number],
    queryFn: () => api.get<{ statuses: StatusChange[]; events: AuditRecord[] }>(`/tickets/${ticket.number}/history`),
  })
  if (q.isPending) return <Loading />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const { statuses, events } = q.data
  return (
    <div className="grid gap-5 2xl:grid-cols-[1fr_280px]">
      <Card className="p-5">
        {events.length === 0 ? (
          <EmptyState text={t.history.empty} />
        ) : (
          <ol className="relative flex flex-col gap-5 border-l border-line pl-6">
            {[...events].reverse().map((r) => {
              const { text, body } = describe(r)
              const statusTo = r.action === 'ticket.status_change' ? s((r.details as D).to) : ''
              return (
                <li key={r.id} className="relative">
                  <span
                    className={cn(
                      'absolute top-1.5 -left-[29px] size-2.5 rounded-full ring-4 ring-surface',
                      statusTo ? statusDot(statusTo) : 'bg-line-strong',
                    )}
                    aria-hidden
                  />
                  <div className="text-sm">
                    <span className="font-medium">{r.user_name || t.common.system}</span> <span className="text-muted">{text}</span>
                  </div>
                  {body}
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                    <span className="num">{formatDateTime(r.created_at)}</span>
                    <ViaBadge via={r.via} />
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Card>
      <Card className="h-fit p-5">
        <h3 className="mb-3 text-[13px] font-semibold text-muted">{t.ticket.transitions}</h3>
        <ol className="flex flex-col gap-3">
          {statuses.map((h) => (
            <li key={h.id} className="flex flex-col gap-1">
              <StatusBadge status={h.to_status} result={h.close_result} />
              {h.loss_reason && <span className="text-[12px] text-muted">{t.shortlist.lossReason}: {t.lossReasons[h.loss_reason]}</span>}
              <span className="text-[12px] text-muted">
                {h.changed_by_name}, <span className="num">{formatDateTime(h.created_at)}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}
