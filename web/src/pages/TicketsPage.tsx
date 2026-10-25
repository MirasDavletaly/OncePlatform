import { calendarWeek } from '../lib/shortlist'
import { dayKey } from '../lib/format'
import { ShortlistFilters, SHORTLIST_FILTERS } from '../components/ShortlistFilters'
import { ShortlistSummary, SHORTLIST_COLUMNS, shortlistDisplay } from '../components/Shortlist'
import { submissionPending } from '../lib/shortlist'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Download, FileSearch, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import type { Page, Ticket } from '../lib/types'
import { cn } from '../lib/utils'
import { DeadlineBadge, PriorityBadge, StatusBadge } from '../components/badges'
import { useUsers } from '../components/inputs'
import { Button, Card, EmptyState, ErrorState, Input, Loading, PageHeader, Pagination, buttonClass } from '../components/ui'

const MULTI = ['status', 'priority', 'assignee_id'] as const
const SINGLE = ['q', 'mine', 'deadline_from', 'deadline_to', 'overdue', 'sort', 'order', 'page', ...SHORTLIST_FILTERS] as const

function Chips({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: { value: string; label: string }[]
  selected: string[]
  onToggle: (v: string) => void
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[12px] font-medium text-muted">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected.includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(o.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[12.5px] transition-colors',
                on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink hover:border-line-strong',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

export function TicketsPage() {
  const { can } = useSession()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [showFilters, setShowFilters] = useState(() => MULTI.some((k) => params.getAll(k).length) || SINGLE.some((k) => !!params.get(k)))
  const { data: users = [] } = useUsers()

  const apiQuery = new URLSearchParams()
  for (const k of MULTI) params.getAll(k).forEach((v) => apiQuery.append(k, v))
  for (const k of SINGLE) {
    const v = params.get(k)
    if (v) apiQuery.set(k, v)
  }
  const page = Number(params.get('page') ?? '1') || 1
  const pageSize = 25
  apiQuery.set('page_size', String(pageSize))

  const list = useQuery({
    queryKey: ['tickets', apiQuery.toString()],
    queryFn: () => api.get<Page<Ticket>>('/tickets?' + apiQuery.toString()),
    placeholderData: keepPreviousData,
  })

  const update = (mut: (p: URLSearchParams) => void, keepPage = false) => {
    const next = new URLSearchParams(params)
    mut(next)
    if (!keepPage) next.delete('page')
    setParams(next, { replace: true })
  }
  const toggle = (k: string, v: string) =>
    update((p) => {
      const cur = p.getAll(k)
      p.delete(k)
      ;(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).forEach((x) => p.append(k, x))
    })
  const setSingle = (k: string, v: string) => update((p) => (v ? p.set(k, v) : p.delete(k)))
  const sortBy = (col: string) =>
    update((p) => {
      const cur = p.get('sort')
      const order = p.get('order') ?? 'desc'
      p.set('sort', col)
      if (col === 'budget_amount' && !p.get('currency')) { p.set('currency', 'KZT'); setShowFilters(true) }
      p.set('order', cur === col && order === 'desc' ? 'asc' : 'desc')
    })
  const hasFilters =
    MULTI.some((k) => params.getAll(k).length) || SINGLE.some((k) => k !== 'sort' && k !== 'order' && k !== 'page' && params.get(k))

  const exportQuery = new URLSearchParams(apiQuery)
  exportQuery.delete('page')
  exportQuery.delete('page_size')

  const th = (col: string, label: ReactNode, className?: string) => {
    const active = params.get('sort') === col
    const order = params.get('order') ?? 'desc'
    return (
      <th key={col} className={cn('px-3 py-2.5 text-left font-medium', className)} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => sortBy(col)} className="inline-flex items-center gap-1 hover:text-ink">
          {label}
          {active && (order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
        </button>
      </th>
    )
  }
  const assigneeLabel = (tk: Ticket) => tk.assignee_name ?? t.common.everyone

  return (
    <>
      <PageHeader
        title={t.tickets.title}
        subtitle={list.data ? fmt(t.common.total, { n: list.data.total }) : undefined}
        actions={
          <>
            <a href={'/api/v1/tickets/export.csv?' + exportQuery.toString()} className={buttonClass('secondary', 'md')}>
              <Download className="size-4" /> {t.tickets.export}
            </a>
            {can('ticket.create') && (
              <Link to="/tickets/new" className={buttonClass('primary', 'md')}>
                <Plus className="size-4" /> {t.tickets.new}
              </Link>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="relative min-w-0 flex-1 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault()
            setSingle('q', q.trim())
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.tickets.searchPlaceholder}
            className="pl-9"
            aria-label={t.common.search}
          />
        </form>
        <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
          {t.common.filters}
        </Button>
        <Button variant={params.get('mine') ? 'primary' : 'secondary'} onClick={() => setSingle('mine', params.get('mine') ? '' : '1')}>
          {t.tickets.myOnly}
        </Button>
        <Button variant={params.get('overdue') ? 'primary' : 'secondary'} onClick={() => setSingle('overdue', params.get('overdue') ? '' : '1')}>
          {t.tickets.overdueOnly}
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            onClick={() => {
              setQ('')
              setParams(new URLSearchParams(), { replace: true })
            }}
          >
            {t.tickets.resetFilters}
          </Button>
        )}
      </div>

      {showFilters && (
        <Card className="mb-4 grid gap-5 p-5 md:grid-cols-2 xl:grid-cols-4">
          <Chips
            label={t.tickets.filter.status}
            options={Object.entries(t.status).map(([value, label]) => ({ value, label }))}
            selected={params.getAll('status')}
            onToggle={(v) => toggle('status', v)}
          />
          <Chips
            label={t.tickets.filter.priority}
            options={Object.entries(t.priority).map(([value, label]) => ({ value, label }))}
            selected={params.getAll('priority')}
            onToggle={(v) => toggle('priority', v)}
          />
          <Chips
            label={t.tickets.filter.assignee}
            options={[{ value: 'everyone', label: t.common.everyone }, ...users.map((u) => ({ value: u.id, label: u.full_name }))]}
            selected={params.getAll('assignee_id')}
            onToggle={(v) => toggle('assignee_id', v)}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-muted">{t.tickets.filter.deadline}</span>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                aria-label={t.common.dateFrom}
                value={params.get('deadline_from') ?? ''}
                onChange={(e) => setSingle('deadline_from', e.target.value)}
              />
              <span className="text-muted">—</span>
              <Input
                type="date"
                aria-label={t.common.dateTo}
                value={params.get('deadline_to') ?? ''}
                onChange={(e) => setSingle('deadline_to', e.target.value)}
              />
            </div>
            <Button size="sm" onClick={() => update((p) => {
              const [from, to] = calendarWeek(dayKey(new Date()))
              p.set('deadline_from', from); p.set('deadline_to', to)
            })}>{t.shortlist.thisWeek}</Button>
          </div>
          <ShortlistFilters key={params.toString()} params={params} apply={(values) => update((p) => {
            for (const key of SHORTLIST_FILTERS) { const value = values[key]?.trim(); if (value) p.set(key, value); else p.delete(key) }
          })} />
        </Card>
      )}

      <Card className="overflow-hidden">
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            icon={<FileSearch className="size-7" />}
            text={hasFilters ? t.tickets.empty : t.tickets.emptyAll}
            action={
              !hasFilters && can('ticket.create') ? (
                <Link to="/tickets/new" className={buttonClass('primary', 'sm')}>
                  {t.tickets.new}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Table on wide screens */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-2 text-[12px] text-muted">
                  <tr>
                    {th('number', t.tickets.col.number, 'w-28')}
                    {th('title', t.tickets.col.title)}
                    {SHORTLIST_COLUMNS.map((key) => th(key, t.shortlist[key]))}
                    {th('status', t.tickets.col.status)}
                    {th('deadline', t.tickets.col.deadline)}
                    {th('priority', t.tickets.col.priority, 'hidden lg:table-cell')}
                    {th('assignee', t.tickets.col.assignee, 'hidden lg:table-cell')}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((tk) => (
                    <tr
                      key={tk.id}
                      className="cursor-pointer hover:bg-surface-2"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('a')) return
                        navigate(`/tickets/${tk.number}`)
                      }}
                    >
                      <td className="num px-3 py-3 text-[12.5px] text-muted">{tk.number}</td>
                      <td className="max-w-md px-3 py-3">
                        <Link to={`/tickets/${tk.number}`} className="line-clamp-2 font-medium hover:text-accent">
                          {tk.title}
                        </Link>
                      </td>
                      {SHORTLIST_COLUMNS.map((key) => <td key={key} className="max-w-48 px-3 py-3 text-[13px]">
                        <span className={key === 'budget_amount' ? 'whitespace-nowrap' : 'line-clamp-2'}>{shortlistDisplay(tk, key)}</span>
                      </td>)}
                      <td className="px-3 py-3">
                        <StatusBadge status={tk.status} result={tk.close_result} />
                      </td>
                      <td className="px-3 py-3">
                        <DeadlineBadge deadline={tk.deadline} closed={!submissionPending(tk.status)} />
                      </td>
                      <td className="hidden px-3 py-3 lg:table-cell">
                        <PriorityBadge priority={tk.priority} />
                      </td>
                      <td className={cn('hidden px-3 py-3 lg:table-cell', tk.assignee_name ? 'text-muted' : 'text-accent')}>
                        {assigneeLabel(tk)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Cards on phones */}
            <ul className="divide-y divide-line md:hidden">
              {list.data.items.map((tk) => (
                <li key={tk.id}>
                  <Link to={`/tickets/${tk.number}`} className="block px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="num text-[12px] text-muted">{tk.number}</span>
                      <StatusBadge status={tk.status} result={tk.close_result} />
                    </div>
                    <p className="mt-1 font-medium">{tk.title}</p>
                    <ShortlistSummary ticket={tk} />
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <DeadlineBadge deadline={tk.deadline} closed={!submissionPending(tk.status)} />
                      <PriorityBadge priority={tk.priority} compact />
                      <span className="text-[12px] text-muted">{assigneeLabel(tk)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-4">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={list.data.total}
                onPage={(p) => update((sp) => sp.set('page', String(p)), true)}
              />
            </div>
          </>
        )}
      </Card>
    </>
  )
}
