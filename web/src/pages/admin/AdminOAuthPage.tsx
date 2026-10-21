import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { OAuthClient } from '../../lib/types'
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, useConfirm, useToast } from '../../components/ui'

export function AdminOAuthPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const list = useQuery({ queryKey: ['oauth-clients'], queryFn: () => api.get<{ items: OAuthClient[] }>('/admin/oauth-clients') })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/admin/oauth-clients/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['oauth-clients'] })
      toast(t.admin.revokedToast)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  return (
    <>
      <PageHeader title={t.admin.oauthTitle} subtitle={t.admin.oauthHint} />
      <Card className="overflow-hidden">
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <EmptyState text={t.admin.oauthEmpty} />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.items.map((c) => (
              <li key={c.id} className={`flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center ${c.revoked_at ? 'opacity-60' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {c.client_name}
                    {c.revoked_at && <Badge className="bg-surface-2 text-muted">{t.admin.revoked}</Badge>}
                    <Badge className="bg-surface-2 text-muted">{c.token_endpoint_auth_method}</Badge>
                  </p>
                  <p className="num mt-0.5 truncate text-[12px] text-muted">{c.client_id}</p>
                  <p className="mt-1 text-[12.5px] text-muted">
                    {t.admin.redirect}: <span className="break-all text-ink">{c.redirect_uris.join(', ')}</span>
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12.5px] text-muted lg:w-[420px]">
                  <span>{t.admin.registered}</span>
                  <span className="num text-ink">{formatDateTime(c.created_at)}</span>
                  <span>{t.admin.lastUsed}</span>
                  <span className="num text-ink">{c.last_used_at ? formatDateTime(c.last_used_at) : '—'}</span>
                  <span>{t.admin.usersOf}</span>
                  <span className="text-ink">{c.users.length ? c.users.join(', ') : '—'}</span>
                  <span>{t.admin.activeTokens}</span>
                  <span className="num text-ink">{c.active_tokens}</span>
                </div>
                {!c.revoked_at && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm(fmt(t.admin.revokeConfirm, { name: c.client_name }), { danger: true, confirmLabel: t.admin.revoke }))
                        revoke.mutate(c.id)
                    }}
                  >
                    {t.admin.revoke}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
