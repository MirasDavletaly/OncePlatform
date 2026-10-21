import { Fragment, useState } from 'react'
import { useSearchParams } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { t } from '../../i18n'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { AuditRecord, Page } from '../../lib/types'
import { useUsers } from '../../components/inputs'
import { Badge, Card, ErrorState, Input, Loading, PageHeader, Pagination, Select } from '../../components/ui'

const ENTITY_TYPES = ['ticket', 'comment', 'attachment', 'client', 'contact', 'kb_article', 'user', 'api_token', 'oauth_client']

function objectLabel(r: AuditRecord): string {
  const d = r.details as Record<string, unknown>
  const pick = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
  return [pick('number'), pick('title') || pick('name') || pick('full_name') || pick('client_name') || pick('email')]
    .filter(Boolean)
    .join(' ')
}

export function AdminAuditPage() {
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState<string | null>(null)
  const { data: users = [] } = useUsers(true)
  const page = Number(params.get('page') ?? '1') || 1
  const query = new URLSearchParams(params)
  query.set('page_size', '50')
  const list = useQuery({
    queryKey: ['audit', query.toString()],
    queryFn: () => api.get<Page<AuditRecord>>('/admin/audit?' + query.toString()),
    placeholderData: keepPreviousData,
  })
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    if (k !== 'page') next.delete('page')
    setParams(next, { replace: true })
  }
  const via = (v: string) =>
    v === 'mcp' ? (
      <Badge className="bg-info-soft text-info">{t.admin.viaMcp}</Badge>
    ) : v === 'system' ? (
      <Badge className="bg-surface-2 text-muted">{t.admin.viaSystem}</Badge>
    ) : (
      <Badge className="bg-surface-2 text-ink">{t.admin.viaWeb}</Badge>
    )
  return (
    <>
      <PageHeader title={t.admin.auditTitle} subtitle={t.admin.auditHint} />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <Select aria-label={t.admin.who} value={params.get('user_id') ?? ''} onChange={(e) => set('user_id', e.target.value)}>
          <option value="">{t.admin.who}: {t.common.all.toLowerCase()}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
            </option>
          ))}
        </Select>
        <Select aria-label={t.admin.entityType} value={params.get('entity_type') ?? ''} onChange={(e) => set('entity_type', e.target.value)}>
          <option value="">{t.admin.entityType}: {t.common.all.toLowerCase()}</option>
          {ENTITY_TYPES.map((et) => (
            <option key={et} value={et}>
              {et}
            </option>
          ))}
        </Select>
        <Input
          aria-label={t.admin.actionPrefix}
          placeholder={t.admin.actionPrefix}
          defaultValue={params.get('action') ?? ''}
          onBlur={(e) => set('action', e.target.value.trim())}
        />
        <Select aria-label={t.admin.channel} value={params.get('via') ?? ''} onChange={(e) => set('via', e.target.value)}>
          <option value="">{t.admin.channel}: {t.common.all.toLowerCase()}</option>
          <option value="web">{t.admin.viaWeb}</option>
          <option value="mcp">{t.admin.viaMcp}</option>
          <option value="system">{t.admin.viaSystem}</option>
        </Select>
        <Input type="date" aria-label={t.common.dateFrom} value={params.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} />
        <Input type="date" aria-label={t.common.dateTo} value={params.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} />
      </Card>
      <Card className="overflow-hidden">
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-2 text-left text-[12px] text-muted">
                  <tr>
                    <th className="w-8" />
                    <th className="px-3 py-2.5 font-medium">{t.admin.when}</th>
                    <th className="px-3 py-2.5 font-medium">{t.admin.who}</th>
                    <th className="px-3 py-2.5 font-medium">{t.admin.action}</th>
                    <th className="hidden px-3 py-2.5 font-medium lg:table-cell">{t.admin.object}</th>
                    <th className="px-3 py-2.5 font-medium">{t.admin.channel}</th>
                    <th className="hidden px-3 py-2.5 font-medium xl:table-cell">{t.admin.ip}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((r) => (
                    <Fragment key={r.id}>
                      <tr className="cursor-pointer hover:bg-surface-2" onClick={() => setOpen(open === r.id ? null : r.id)}>
                        <td className="pl-3 text-muted">{open === r.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</td>
                        <td className="num px-3 py-2.5 text-[12.5px] whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{r.user_name || t.common.system}</td>
                        <td className="px-3 py-2.5">
                          <span className="num text-[12.5px]">{r.action}</span>
                          {t.activity[r.action] && <span className="block text-[12px] text-muted">{t.activity[r.action]}</span>}
                        </td>
                        <td className="hidden max-w-xs truncate px-3 py-2.5 text-muted lg:table-cell">{objectLabel(r)}</td>
                        <td className="px-3 py-2.5">{via(r.via)}</td>
                        <td className="num hidden px-3 py-2.5 text-[12px] text-muted xl:table-cell">{r.ip}</td>
                      </tr>
                      {open === r.id && (
                        <tr className="bg-surface-2">
                          <td colSpan={7} className="px-4 py-3">
                            <p className="mb-1 text-[12px] text-muted">
                              {t.admin.details} · {r.entity_type} {r.entity_id}
                            </p>
                            <pre className="max-h-80 overflow-auto rounded-lg bg-surface p-3 font-mono text-[12px] whitespace-pre-wrap">
                              {JSON.stringify(r.details, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line px-4">
              <Pagination page={page} pageSize={50} total={list.data.total} onPage={(p) => set('page', String(p))} />
            </div>
          </>
        )}
      </Card>
    </>
  )
}
