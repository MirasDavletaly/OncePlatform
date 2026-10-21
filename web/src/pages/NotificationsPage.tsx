import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AtSign, Bell, CalendarClock, CheckCheck, GitPullRequestArrow, UserPlus } from 'lucide-react'
import { t } from '../i18n'
import { api } from '../lib/api'
import { formatDateTime, timeAgo } from '../lib/format'
import type { Notification } from '../lib/types'
import { cn } from '../lib/utils'
import { Button, Card, Checkbox, EmptyState, ErrorState, Loading, PageHeader, Pagination } from '../components/ui'

const icons: Record<string, ReactNode> = {
  assigned: <UserPlus className="size-4" />,
  status_changed: <GitPullRequestArrow className="size-4" />,
  mentioned: <AtSign className="size-4" />,
  deadline_3d: <CalendarClock className="size-4" />,
  deadline_1d: <CalendarClock className="size-4" />,
}

export function NotificationsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [page, setPage] = useState(1)
  const list = useQuery({
    queryKey: ['notifications', 'page', unreadOnly, page],
    queryFn: () =>
      api.get<{ items: Notification[]; total: number; unread: number }>(`/notifications?page=${page}&page_size=30${unreadOnly ? '&unread=1' : ''}`),
    placeholderData: keepPreviousData,
  })
  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  const open = (n: Notification) => {
    if (!n.read_at) read.mutate(n.id)
    if (n.ticket_number) navigate(`/tickets/${n.ticket_number}`)
  }
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t.notifications.title}
        actions={
          <Button icon={<CheckCheck className="size-4" />} onClick={() => readAll.mutate()} disabled={!list.data?.unread} loading={readAll.isPending}>
            {t.notifications.markAll}
          </Button>
        }
      />
      <div className="mb-3">
        <Checkbox
          label={t.notifications.unreadOnly}
          checked={unreadOnly}
          onChange={(v) => {
            setUnreadOnly(v)
            setPage(1)
          }}
        />
      </div>
      <Card className="overflow-hidden">
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={<Bell className="size-7" />} text={t.notifications.empty} />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => open(n)} className={cn('flex w-full gap-3 px-5 py-4 text-left hover:bg-surface-2', !n.read_at && 'bg-accent-soft/30')}>
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                      n.type === 'deadline_1d' ? 'bg-danger-soft text-danger' : n.type === 'deadline_3d' ? 'bg-gold-soft text-gold' : 'bg-accent-soft text-accent',
                    )}
                  >
                    {icons[n.type] ?? <Bell className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                      <span className="font-medium">{t.notifications.types[n.type] ?? n.type}</span>
                      <span title={formatDateTime(n.created_at)}>{timeAgo(n.created_at)}</span>
                      {!n.read_at && <span className="size-2 rounded-full bg-accent-bright" aria-label={t.notifications.newMark} />}
                    </span>
                    <span className="mt-0.5 block text-sm leading-snug">{n.text}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data && (
          <div className="border-t border-line px-4">
            <Pagination page={page} pageSize={30} total={list.data.total} onPage={setPage} />
          </div>
        )}
      </Card>
    </div>
  )
}
