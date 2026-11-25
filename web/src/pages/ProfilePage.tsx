import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppWindow, Bot, Check, Copy, KeyRound } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api, errorMessage } from '../lib/api'
import { formatDate, formatDateTime } from '../lib/format'
import { useSession } from '../lib/session'
import type { APIToken, Grant } from '../lib/types'
import { copyText } from '../lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, useConfirm, useToast } from '../components/ui'

export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-stretch gap-2">
      <code className={`min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] whitespace-nowrap ${mono ? 'font-mono' : ''}`}>
        {value}
      </code>
      <Button
        onClick={async () => {
          if (await copyText(value)) {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
          }
        }}
        icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      >
        {copied ? t.common.copied : t.common.copy}
      </Button>
    </div>
  )
}

function PasswordCard() {
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const change = useMutation({
    mutationFn: () => api.post('/auth/password', { current_password: cur, new_password: next }),
    onSuccess: () => {
      setCur('')
      setNext('')
      setRepeat('')
      toast(t.profile.passwordChanged)
    },
  })
  const others = useMutation({
    mutationFn: () => api.post<{ ended: number }>('/auth/logout-others'),
    onSuccess: (r) => toast(fmt(t.profile.loggedOutOthers, { n: r.ended })),
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const mismatch = repeat !== '' && next !== repeat
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mismatch) change.mutate()
  }
  return (
    <Card>
      <CardHeader title={t.profile.changePassword} />
      <form onSubmit={submit} className="flex flex-col gap-4 p-5">
        <Field label={t.profile.currentPassword} htmlFor="pw-cur">
          <Input id="pw-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label={t.profile.newPassword} htmlFor="pw-new" hint={t.profile.passwordHint}>
          <Input id="pw-new" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t.profile.repeatPassword} htmlFor="pw-rep" error={mismatch ? t.profile.passwordMismatch : undefined}>
          <Input id="pw-rep" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        {change.error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{errorMessage(change.error)}</p>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!cur || next.length < 8 || next !== repeat}>
            {t.common.save}
          </Button>
        </div>
      </form>
      <div className="flex flex-col gap-2 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-muted">{t.profile.logoutOthersHint}</p>
        <Button size="sm" loading={others.isPending} onClick={() => others.mutate()}>
          {t.profile.logoutOthers}
        </Button>
      </div>
    </Card>
  )
}

export function TokensCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [name, setName] = useState('')
  const [days, setDays] = useState('365')
  const [created, setCreated] = useState<string | null>(null)
  const list = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<{ items: APIToken[] }>('/me/tokens') })
  const create = useMutation({
    mutationFn: () => api.post<{ token: string; item: APIToken }>('/me/tokens', { name, expires_in_days: Number(days) }),
    onSuccess: (r) => {
      setCreated(r.token)
      setName('')
      void qc.invalidateQueries({ queryKey: ['tokens'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/me/tokens/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tokens'] })
      toast(t.profile.tokenRevoked)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const status = (tk: APIToken) => {
    if (tk.revoked_at) return <Badge className="bg-surface-2 text-muted">{t.profile.tokenStatusRevoked}</Badge>
    if (tk.expires_at && new Date(tk.expires_at) < new Date()) return <Badge className="bg-surface-2 text-muted">{t.profile.tokenStatusExpired}</Badge>
    return null
  }
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-muted" />{t.profile.tokens}</span>} hint={t.profile.tokensHint} />
      <form
        className="grid gap-3 border-b border-line p-5 sm:grid-cols-[1fr_160px_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
      >
        <Field label={t.profile.tokenName} htmlFor="tok-name">
          <Input id="tok-name" value={name} placeholder={t.profile.tokenNamePlaceholder} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.profile.tokenExpires} htmlFor="tok-days">
          <Select id="tok-days" value={days} onChange={(e) => setDays(e.target.value)}>
            {['30', '90', '365'].map((d) => (
              <option key={d} value={d}>
                {fmt(t.profile.tokenDays, { n: d })}
              </option>
            ))}
            <option value="0">{t.profile.tokenNoExpiry}</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          {t.profile.tokenCreate}
        </Button>
        {create.error && <p className="text-sm text-danger sm:col-span-3">{errorMessage(create.error)}</p>}
      </form>
      {list.isPending ? (
        <Loading className="py-8" />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <p className="px-5 py-4 text-sm text-muted">{t.profile.tokensEmpty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {list.data!.items.map((tk) => (
            <li key={tk.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {tk.name} {status(tk)}
                </p>
                <p className="text-[12px] text-muted">
                  <span className="num">{tk.prefix}…</span> · {formatDate(tk.created_at)}
                  {tk.expires_at && ` → ${formatDate(tk.expires_at)}`} · {t.profile.tokenLastUsed}:{' '}
                  {tk.last_used_at ? formatDateTime(tk.last_used_at) : t.profile.tokenNever}
                </p>
              </div>
              {!tk.revoked_at && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (await confirm(fmt(t.profile.tokenRevokeConfirm, { name: tk.name }), { danger: true, confirmLabel: t.profile.tokenRevoke }))
                      revoke.mutate(tk.id)
                  }}
                >
                  {t.profile.tokenRevoke}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!created} onClose={() => setCreated(null)} title={t.profile.tokenCreate} wide>
        <p className="mb-3 text-sm">{t.profile.tokenCreated}</p>
        {created && <CopyField value={created} />}
      </Modal>
    </Card>
  )
}

function AppsCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const list = useQuery({ queryKey: ['grants'], queryFn: () => api.get<{ items: Grant[] }>('/me/oauth-grants') })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/me/oauth-grants/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['grants'] })
      toast(t.profile.appRevoked)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><AppWindow className="size-4 text-muted" />{t.profile.apps}</span>} hint={t.profile.appsHint} />
      {list.isPending ? (
        <Loading className="py-8" />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          text={t.profile.appsEmpty}
          action={
            <Link to="/settings/claude" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              <Bot className="size-4" /> {t.nav.connectClaude}
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {list.data!.items.map((g) => (
            <li key={g.client_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{g.client_name}</p>
                <p className="text-[12px] text-muted">
                  {g.redirect_host} · {fmt(t.profile.appAuthorized, { date: formatDate(g.authorized_at) })}
                  {g.last_used_at && ` · ${t.profile.tokenLastUsed}: ${formatDateTime(g.last_used_at)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (await confirm(fmt(t.profile.appRevokeConfirm, { name: g.client_name }), { danger: true, confirmLabel: t.profile.appRevoke }))
                    revoke.mutate(g.client_id)
                }}
              >
                {t.profile.appRevoke}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function ProfilePage() {
  const { me, can } = useSession()
  // Claude (OAuth applications, API tokens) is for the tender team; the recruiter has the password only
  const claude = can('view')
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.profile.title} subtitle={[me.user.full_name, me.user.email, t.role[me.user.role]].filter(Boolean).join(' · ')} />
      <div className="grid gap-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <PasswordCard />
          {claude && <AppsCard />}
        </div>
        {claude && <TokensCard />}
      </div>
    </div>
  )
}
