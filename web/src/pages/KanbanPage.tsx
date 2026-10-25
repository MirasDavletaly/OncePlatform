import { ShortlistSummary } from '../components/Shortlist'
import { submissionPending } from '../lib/shortlist'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { MessageSquare, Paperclip, Search } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api, qs } from '../lib/api'
import { urgency } from '../lib/format'
import type { Status, Ticket } from '../lib/types'
import { cn } from '../lib/utils'
import { DeadlineBadge, PriorityBadge, statusDot } from '../components/badges'
import { useUsers } from '../components/inputs'
import { useStatusChange } from '../components/StatusChange'
import { ErrorState, Input, Loading, PageHeader, Select } from '../components/ui'

interface Column {
  status: Status
  total: number
  items: Ticket[]
}

function Card({ tk, overlay }: { tk: Ticket; overlay?: boolean }) {
  const u = urgency(tk.deadline, !submissionPending(tk.status))
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface p-3 shadow-sm',
        overlay && 'rotate-1 shadow-2xl ring-2 ring-accent/40',
        (u === 'red' || u === 'overdue') && 'border-l-[3px] border-l-danger',
        u === 'gold' && 'border-l-[3px] border-l-gold-fill',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="num text-[11px] font-semibold text-muted">{tk.number}</span>
        <PriorityBadge priority={tk.priority} compact />
      </div>
      <Link
        to={`/tickets/${tk.number}`}
        className="mt-1 line-clamp-3 block text-[13.5px] leading-snug font-medium hover:text-accent"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {tk.title}
      </Link>
      <ShortlistSummary ticket={tk} />
      {tk.status === 'closed' && tk.close_result && (
        <p className={cn('mt-1 text-[12px] font-medium', tk.close_result === 'won' ? 'text-ok' : 'text-muted')}>
          {t.result[tk.close_result]}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <DeadlineBadge deadline={tk.deadline} closed={!submissionPending(tk.status)} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted">
        <span className={cn('truncate', !tk.assignee_name && 'text-accent')}>{tk.assignee_name ?? t.common.everyone}</span>
        <span className="flex shrink-0 items-center gap-2.5">
          {tk.comments_count > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare className="size-3.5" aria-hidden />
              {tk.comments_count}
            </span>
          )}
          {tk.attachments_count > 0 && (
            <span className="flex items-center gap-0.5">
              <Paperclip className="size-3.5" aria-hidden />
              {tk.attachments_count}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

function DraggableCard({ tk }: { tk: Ticket }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: tk.id, data: { ticket: tk } })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn('cursor-grab touch-manipulation active:cursor-grabbing', isDragging && 'opacity-30')}
      {...listeners}
      {...attributes}
    >
      <Card tk={tk} />
    </div>
  )
}

function DropColumn({ col, children }: { col: Column; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.status })
  return (
    <section
      ref={setNodeRef}
      aria-label={t.status[col.status]}
      className={cn(
        'flex w-[280px] shrink-0 flex-col rounded-xl border bg-surface-2 transition-colors sm:w-[300px]',
        isOver ? 'border-accent bg-accent-soft/60' : 'border-line',
      )}
    >
      <header className="flex items-center gap-2 px-3 py-3">
        <span className={cn('size-2 rounded-full', statusDot(col.status))} aria-hidden />
        <h2 className="text-[13px] font-semibold">{t.status[col.status]}</h2>
        <span className="num ml-auto rounded-full bg-surface px-2 text-[12px] text-muted ring-1 ring-line">{col.total}</span>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-3">{children}</div>
    </section>
  )
}

export function KanbanPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const { data: users = [] } = useUsers()
  const filters = {
    q: params.get('q') ?? '',
    assignee_id: params.get('assignee_id') ?? '',
  }
  const key = ['board', filters]
  const board = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ columns: Column[] }>('/tickets/board' + qs(filters)),
    refetchInterval: 60_000,
  })
  const { change, dialog } = useStatusChange()
  const [active, setActive] = useState<Ticket | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const moveLocally = (ticketId: string, to: Status) => {
    qc.setQueryData<{ columns: Column[] }>(key, (old) => {
      if (!old) return old
      let moved: Ticket | undefined
      const cols = old.columns.map((c) => {
        const idx = c.items.findIndex((i) => i.id === ticketId)
        if (idx < 0) return c
        moved = c.items[idx]
        return { ...c, total: c.total - 1, items: c.items.filter((i) => i.id !== ticketId) }
      })
      if (!moved) return old
      return {
        columns: cols.map((c) =>
          c.status === to ? { ...c, total: c.total + 1, items: [{ ...moved!, status: to }, ...c.items] } : c,
        ),
      }
    })
  }

  const onDragStart = (e: DragStartEvent) => setActive((e.active.data.current?.ticket as Ticket) ?? null)

  const onDragEnd = async (e: DragEndEvent) => {
    setActive(null)
    const tk = e.active.data.current?.ticket as Ticket | undefined
    const to = e.over?.id as Status | undefined
    if (!tk || !to || to === tk.status) return
    const snapshot = qc.getQueryData(key)
    moveLocally(tk.id, to)
    const updated = await change(tk, to)
    if (!updated) {
      // Refused by the server or cancelled: put the card back.
      qc.setQueryData(key, snapshot)
    }
    void qc.invalidateQueries({ queryKey: ['board'] })
  }

  const columns = useMemo(() => board.data?.columns ?? [], [board.data])

  return (
    <>
      <PageHeader title={t.kanban.title} subtitle={t.kanban.hint} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="relative w-full sm:w-72"
          onSubmit={(e) => {
            e.preventDefault()
            setFilter('q', q.trim())
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => setFilter('q', q.trim())}
            placeholder={t.tickets.searchPlaceholder}
            className="pl-9"
            aria-label={t.common.search}
          />
        </form>
        <Select
          value={filters.assignee_id}
          onChange={(e) => setFilter('assignee_id', e.target.value)}
          className="w-auto min-w-52"
          aria-label={t.tickets.filter.assignee}
        >
          <option value="">
            {t.tickets.filter.assignee}: {t.common.all.toLowerCase()}
          </option>
          <option value="everyone">{t.common.everyone}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
            </option>
          ))}
        </Select>
      </div>
      {board.isPending && <Loading />}
      {board.isError && <ErrorState error={board.error} onRetry={() => board.refetch()} />}
      {board.data && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActive(null)}
          accessibility={{
            announcements: {
              onDragStart: ({ active: a }) => `${(a.data.current?.ticket as Ticket)?.number ?? ''}`,
              onDragOver: ({ over }) => (over ? t.status[String(over.id)] ?? '' : ''),
              onDragEnd: ({ active: a, over }) =>
                over
                  ? fmt(t.kanban.moved, {
                      number: (a.data.current?.ticket as Ticket)?.number ?? '',
                      status: t.status[String(over.id)] ?? '',
                    })
                  : '',
              onDragCancel: () => '',
            },
          }}
        >
          <div className="scroll-thin -mx-4 flex gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
            {columns.map((col) => (
              <DropColumn key={col.status} col={col}>
                {col.items.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12px] text-muted">
                    {active ? t.kanban.dropHere : t.kanban.empty}
                  </p>
                ) : (
                  col.items.map((tk) => <DraggableCard key={tk.id} tk={tk} />)
                )}
              </DropColumn>
            ))}
          </div>
          <DragOverlay dropAnimation={null}>{active ? <Card tk={active} overlay /> : null}</DragOverlay>
        </DndContext>
      )}
      {dialog}
    </>
  )
}
