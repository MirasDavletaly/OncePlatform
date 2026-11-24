import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, MessageSquare, Search, Ticket as TicketIcon } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api, qs } from '../lib/api'
import { formatDate } from '../lib/format'
import type { SearchResponse, SearchResult } from '../lib/types'
import { Highlight } from '../components/inputs'
import { Button, Card, EmptyState, ErrorState, Input, Loading, PageHeader } from '../components/ui'

const icons = {
  ticket: <TicketIcon className="size-4" />,
  comment: <MessageSquare className="size-4" />,
  attachment: <FileText className="size-4" />,
}

function resultLink(r: SearchResult): string {
  switch (r.kind) {
    case 'ticket':
      return `/tickets/${r.ticket_number}`
    case 'comment':
      return `/tickets/${r.ticket_number}?tab=comments`
    case 'attachment':
      return `/tickets/${r.ticket_number}?tab=files`
  }
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const kind = params.get('kind') ?? ''
  const [q, setQ] = useState(query)
  useEffect(() => setQ(query), [query])
  const enabled = query.trim().length >= 2
  const res = useQuery({
    queryKey: ['search', query, kind],
    queryFn: () => api.get<SearchResponse>('/search' + qs({ q: query, kind, limit: kind ? 50 : 8 })),
    enabled,
  })

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.search.title} subtitle={t.search.hint} />
      <form
        className="relative mb-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (q.trim().length >= 2) setParams({ q: q.trim() })
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          type="search"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.search.placeholder}
          className="h-12 pl-11 text-base"
          aria-label={t.search.title}
        />
      </form>

      {!enabled ? (
        query && <p className="text-sm text-muted">{t.search.minLength}</p>
      ) : res.isPending ? (
        <Loading />
      ) : res.isError ? (
        <ErrorState error={res.error} onRetry={() => res.refetch()} />
      ) : res.data.total === 0 ? (
        <Card>
          <EmptyState icon={<Search className="size-7" />} text={fmt(t.search.nothing, { q: query })} />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{fmt(t.search.found, { n: res.data.total })}</span>
            {kind && (
              <Button size="sm" variant="ghost" onClick={() => setParams({ q: query })}>
                {t.common.all}
              </Button>
            )}
          </div>
          {res.data.groups
            .filter((g) => g.total > 0)
            .map((g) => (
              <section key={g.kind}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold">
                    <span className="text-accent">{icons[g.kind]}</span>
                    {t.search.kinds[g.kind]}
                    <span className="num rounded-full bg-surface-2 px-2 text-[12px] text-muted ring-1 ring-line">{g.total}</span>
                  </h2>
                  {!kind && g.total > g.items.length && (
                    <button type="button" onClick={() => setParams({ q: query, kind: g.kind })} className="text-[13px] text-accent hover:underline">
                      {fmt(t.search.showAll, { n: g.total })}
                    </button>
                  )}
                </div>
                <Card className="divide-y divide-line overflow-hidden">
                  {g.items.map((r) => (
                    <Link key={r.kind + r.id} to={resultLink(r)} className="block px-5 py-3.5 hover:bg-surface-2">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {r.ticket_number && <span className="num text-[12px] text-muted">{r.ticket_number}</span>}
                        <span className="font-medium">
                          <Highlight text={r.title} marks={[res.data.mark_start, res.data.mark_stop]} query={query} />
                        </span>
                      </div>
                      {r.context && <p className="text-[12px] text-muted">{r.context}</p>}
                      {r.snippet && (
                        <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted">
                          <Highlight text={r.snippet} marks={[res.data.mark_start, res.data.mark_stop]} query={query} />
                        </p>
                      )}
                      <p className="num mt-1 text-[11px] text-muted">{formatDate(r.updated_at)}</p>
                    </Link>
                  ))}
                </Card>
              </section>
            ))}
        </div>
      )}
    </div>
  )
}