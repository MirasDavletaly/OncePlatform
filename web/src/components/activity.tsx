import { Link } from 'react-router'
import { t } from '../i18n'
import { timeAgo } from '../lib/format'
import type { AuditRecord } from '../lib/types'
import { ViaBadge } from './badges'

type D = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Object of an activity record: a link to the ticket, client or article. */
function Target({ r }: { r: AuditRecord }) {
  const d = r.details as D
  const number = str(d.number)
  if (number) {
    return (
      <Link to={`/tickets/${number}`} className="font-medium text-accent hover:underline">
        <span className="num">{number}</span>
        {str(d.title) && <span className="text-ink"> — {str(d.title)}</span>}
      </Link>
    )
  }
  return null
}

export function ActivityItem({ r }: { r: AuditRecord }) {
  const d = r.details as D
  let extra = ''
  if (r.action === 'ticket.status_change') {
    extra = `→ ${t.status[str(d.to)] ?? str(d.to)}${str(d.result) ? ` (${t.result[str(d.result)] ?? str(d.result)})` : ''}`
  } else if (r.action.startsWith('attachment.') && str(d.name)) {
    extra = `· ${str(d.name)}`
  }
  return (
    <li className="flex gap-3 py-2.5">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-line-strong" aria-hidden />
      <div className="min-w-0 text-[13px] leading-snug">
        <span className="font-medium">{r.user_name || t.common.system}</span>{' '}
        <span className="text-muted">{t.activity[r.action] ?? r.action}</span> <Target r={r} />
        {extra && <span className="text-muted"> {extra}</span>}
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
          {timeAgo(r.created_at)}
          <ViaBadge via={r.via} />
        </div>
      </div>
    </li>
  )
}
