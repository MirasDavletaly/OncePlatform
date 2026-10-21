import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Inbox } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api } from '../lib/api'
import { dayKey, formatDate, formatTime, urgency, weekday } from '../lib/format'
import { useSession } from '../lib/session'
import type { Overview, Status, Ticket } from '../lib/types'
import { cn } from '../lib/utils'
import { DeadlineBadge, PriorityBadge, StatusBadge, statusDot } from '../components/badges'
import { ActivityItem } from '../components/activity'
import { Card, CardHeader, EmptyState, ErrorState, Loading, PageHeader } from '../components/ui'

const STATUSES: Status[] = ['new', 'analysis', 'solution', 'sent', 'closed']

/**
 * The deadline ribbon: overdue tickets, today and the next six days, with
 * each ticket placed on the day its submission is due.
 */
function DeadlineRibbon({ upcoming, overdue }: { upcoming: Ticket[]; overdue: Ticket[] }) {
  const days: Date[] = []
  const now = new Date()
  for (let i = 0; i < 7; i++) days.push(new Date(now.getTime() + i * 86400000))
  const byDay = new Map<string, Ticket[]>()
  for (const tk of upcoming) {
    if (!tk.deadline) continue
    const k = dayKey(tk.deadline)
    byDay.set(k, [...(byDay.get(k) ?? []), tk])
  }
  const chip = (tk: Ticket) => {
    const u = urgency(tk.deadline)
    return (
      <Link
        key={tk.id}
        to={`/tickets/${tk.number}`}
        title={tk.title}
        className={cn(
          'group block rounded-lg border-l-[3px] bg-surface px-2.5 py-2 text-left shadow-sm ring-1 ring-line transition-shadow hover:shadow-md',
          u === 'overdue' || u === 'red' ? 'border-l-danger' : u === 'gold' ? 'border-l-gold-fill' : 'border-l-accent-bright',
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="num text-[11px] font-semibold text-muted">{tk.number}</span>
          {tk.deadline && <span className="num text-[11px] text-muted">{formatTime(tk.deadline)}</span>}
        </span>
        <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug font-medium group-hover:text-accent">{tk.title}</span>
      </Link>
    )
  }
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t.dashboard.ribbonTitle} hint={t.dashboard.ribbonHint} />
      <div className="scroll-thin overflow-x-auto">
        <div className="grid min-w-[900px] grid-cols-[minmax(150px,1.1fr)_repeat(7,minmax(110px,1fr))] divide-x divide-line">
          <div className="bg-danger-soft/50 p-3">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold tracking-wide text-danger uppercase">{t.dashboard.overdueColumn}</span>
              <span className="font-display text-xl font-semibold text-danger">{overdue.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {overdue.slice(0, 6).map(chip)}
              {overdue.length > 6 && (
                <Link to="/tickets?overdue=1" className="text-[12px] text-danger hover:underline">
                  +{overdue.length - 6}
                </Link>
              )}
            </div>
          </div>
          {days.map((d, i) => {
            const k = dayKey(d)
            const items = byDay.get(k) ?? []
            const soon = i < 3
            return (
              <div key={k} className={cn('p-3', i === 0 && 'bg-accent-soft/40')}>
                <div className="mb-3 flex items-baseline justify-between gap-1">
                  <span className={cn('text-[12px] font-semibold uppercase', soon ? 'text-danger' : 'text-muted')}>
                    {i === 0 ? t.dashboard.today : weekday(d)}
                  </span>
                  <span className={cn('font-display text-xl leading-none font-semibold', items.length ? (soon ? 'text-danger' : 'text-ink') : 'text-line-strong')}>
                    {formatDate(d).slice(0, 5)}
                  </span>
                </div>
                <div className="flex flex-col gap-2">{items.map(chip)}</div>
              </div>
            )
          })}
        </div>
      </div>
      {upcoming.length === 0 && overdue.length === 0 && (
        <p className="border-t border-line px-5 py-3 text-[13px] text-muted">{t.dashboard.ribbonEmpty}</p>
      )}
    </Card>
  )
}

/** The workflow as a rail of stations with ticket counts. */
function PipelineRail({ o }: { o: Overview }) {
  const r = o.closed_by_result
  return (
    <Card>
      <CardHeader title={t.dashboard.pipeline} hint={t.dashboard.pipelineHint} />
      <ol className="grid grid-cols-2 gap-px bg-line sm:grid-cols-5">
        {STATUSES.map((s, i) => (
          <li key={s} className="bg-surface">
            <Link to={`/tickets?status=${s}`} className="group flex h-full flex-col gap-2 p-4 hover:bg-surface-2">
              <span className="flex items-center gap-2 text-[13px] text-muted">
                <span className={cn('size-2 rounded-full', statusDot(s))} aria-hidden />
                {t.status[s]}
                {i < 4 && <ArrowRight className="ml-auto hidden size-3.5 text-line-strong sm:block" aria-hidden />}
              </span>
              <span className="font-display text-[30px] leading-none font-semibold group-hover:text-accent">
                {o.counts[s] ?? 0}
              </span>
              {s === 'closed' && (
                <span className="text-[11px] leading-snug text-muted">
                  {fmt(t.dashboard.closedBreakdown, {
                    won: r.won ?? 0,
                    lost: r.lost ?? 0,
                    cancelled: r.cancelled ?? 0,
                    no_bid: r.no_bid ?? 0,
                  })}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  )
}

function TicketRow({ tk }: { tk: Ticket }) {
  return (
    <li>
      <Link to={`/tickets/${tk.number}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="num text-[12px] text-muted">{tk.number}</span>
            <PriorityBadge priority={tk.priority} compact />
          </div>
          <p className="truncate text-sm font-medium">{tk.title}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={tk.status} result={tk.close_result} />
          <DeadlineBadge deadline={tk.deadline} closed={tk.status === 'closed'} />
        </div>
      </Link>
    </li>
  )
}

export function DashboardPage() {
  const { me } = useSession()
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Overview>('/dashboard'), refetchInterval: 60_000 })
  if (q.isPending) return <Loading />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const o = q.data
  const firstName = me.user.full_name.split(' ')[0]
  return (
    <>
      <PageHeader title={t.dashboard.title} subtitle={`${firstName}, ${formatDate(new Date())}`} />
      <div className="flex flex-col gap-6">
        <DeadlineRibbon upcoming={o.upcoming_deadlines} overdue={o.overdue} />
        <PipelineRail o={o} />
        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <Card>
            <CardHeader
              title={t.dashboard.myTickets}
              hint={t.dashboard.myTicketsHint}
              actions={
                <Link to="/tickets?mine=1" className="text-[13px] text-accent hover:underline">
                  {t.common.all}
                </Link>
              }
            />
            {o.my_tickets.length === 0 ? (
              <EmptyState icon={<Inbox className="size-6" />} text={t.dashboard.myTicketsEmpty} />
            ) : (
              <ul className="divide-y divide-line">
                {o.my_tickets.map((tk) => (
                  <TicketRow key={tk.id} tk={tk} />
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title={t.dashboard.activity} />
            {(o.activity ?? []).length === 0 ? (
              <EmptyState text={t.dashboard.activityEmpty} />
            ) : (
              <ul className="max-h-[520px] overflow-y-auto px-5 py-1">
                {(o.activity ?? []).map((r) => (
                  <ActivityItem key={r.id} r={r} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
