import { Bot, Clock, Flame } from 'lucide-react'
import { t } from '../i18n'
import { formatDateTime, relativeDays, urgency } from '../lib/format'
import { cn } from '../lib/utils'
import { Badge } from './ui'

const statusStyles: Record<string, string> = {
  new: 'bg-surface-2 text-muted ring-1 ring-line',
  analysis: 'bg-accent-soft text-accent',
  solution: 'bg-gold-soft text-gold',
  sent: 'bg-info-soft text-info',
  closed: 'bg-ok-soft text-ok',
}

const statusDots: Record<string, string> = {
  new: 'bg-muted/50',
  analysis: 'bg-accent-bright',
  solution: 'bg-gold-fill',
  sent: 'bg-info',
  closed: 'bg-ok',
}

export function statusDot(status: string) {
  return statusDots[status] ?? 'bg-muted'
}

export function StatusBadge({ status, result }: { status: string; result?: string }) {
  const lost = status === 'closed' && result && result !== 'won'
  return (
    <Badge className={cn(lost ? 'bg-surface-2 text-muted ring-1 ring-line' : statusStyles[status])}>
      <span className={cn('size-1.5 rounded-full', lost ? 'bg-muted/60' : statusDots[status])} aria-hidden />
      {t.status[status] ?? status}
      {status === 'closed' && result ? ` · ${t.result[result] ?? result}` : ''}
    </Badge>
  )
}

export function PriorityBadge({ priority, compact }: { priority: string; compact?: boolean }) {
  if (priority === 'normal' && compact) return null
  const cls =
    priority === 'urgent'
      ? 'bg-danger-soft text-danger'
      : priority === 'high'
        ? 'bg-gold-soft text-gold'
        : priority === 'low'
          ? 'text-muted'
          : 'bg-surface-2 text-muted'
  return (
    <Badge className={cls}>
      {priority === 'urgent' && <Flame className="size-3" aria-hidden />}
      {t.priority[priority] ?? priority}
    </Badge>
  )
}

/**
 * Deadline countdown. Red under 3 days and when overdue, gold within a week.
 * The numerals use the display face: the deadline is the most important
 * number in tender work.
 */
export function DeadlineBadge({
  deadline,
  closed,
  size = 'sm',
}: {
  deadline: string | null
  closed?: boolean
  size?: 'sm' | 'lg'
}) {
  if (!deadline) {
    return size === 'lg' ? <span className="text-sm text-muted">{t.deadline.noDeadline}</span> : null
  }
  const u = urgency(deadline, closed)
  const rel = relativeDays(deadline)
  const color =
    u === 'overdue' || u === 'red'
      ? 'text-danger'
      : u === 'gold'
        ? 'text-gold'
        : 'text-muted'
  if (size === 'lg') {
    return (
      <div className="flex flex-col gap-0.5">
        <span className={cn('font-display text-lg leading-tight font-semibold', closed ? 'text-muted' : color)}>
          {closed ? formatDateTime(deadline) : rel.label}
        </span>
        {!closed && <span className="num text-[12px] text-muted">{formatDateTime(deadline)}</span>}
      </div>
    )
  }
  return (
    <span
      title={formatDateTime(deadline)}
      className={cn('inline-flex items-center gap-1 text-[12px] font-medium whitespace-nowrap', closed ? 'text-muted' : color)}
    >
      <Clock className="size-3.5" aria-hidden />
      {closed ? formatDateTime(deadline) : rel.label}
    </span>
  )
}

export function ViaBadge({ via }: { via: string }) {
  if (via !== 'mcp') return null
  return (
    <Badge className="bg-info-soft text-info" title={t.common.viaClaudeTitle}>
      <Bot className="size-3" aria-hidden />
      {t.common.viaClaude}
    </Badge>
  )
}
