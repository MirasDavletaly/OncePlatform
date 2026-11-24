import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Link2, Link2Off, Pencil, Plus, RefreshCw, TicketCheck, UserCheck, UserX } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Role, User } from '../../lib/types'
import { useUsers } from '../../components/inputs'
import { Badge, Button, Card, Checkbox, ErrorState, Field, IconButton, Input, Loading, Modal, PageHeader, Select, useConfirm, useToast } from '../../components/ui'
import { CopyField } from '../ProfilePage'

const ROLES: Role[] = ['admin', 'coordinator', 'analyst', 'recruiter']

/** A one-time code shown to the admin once. */
interface Invitation {
  name: string
  login: string
  code: string
  until: string
}

type CreatedUser = User & { invite_code?: string; invite_valid_until?: string }

function UserForm({ user, onDone, onInvite }: { user?: User; onDone: () => void; onInvite: (i: Invitation) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [username, setUsername] = useState(user?.username ?? '')
  const [name, setName] = useState(user?.full_name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState<Role>(user?.role ?? 'analyst')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState(true)
  const save = useMutation({
    mutationFn: () =>
      user
        ? api.patch<CreatedUser>(`/users/${user.id}`, { username, email, full_name: name, role })
        : api.post<CreatedUser>('/users', { username, email, full_name: name || username, role, ...(invite ? { invite: true } : { password }) }),
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      toast(user ? t.admin.updated : t.admin.created)
      onDone()
      if (u.invite_code && u.invite_valid_until) onInvite({ name: u.full_name, login: u.username, code: u.invite_code, until: u.invite_valid_until })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label={t.admin.username} htmlFor="u-login" hint={t.admin.usernameHint}>
        <Input
          id="u-login"
          required
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>
      <Field label={t.admin.name} htmlFor="u-name">
        <Input id="u-name" value={name} placeholder={username} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={`${t.admin.email} (${t.common.optional})`} htmlFor="u-email">
        <Input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label={t.admin.role} htmlFor="u-role" hint={t.admin.roleHint[role]}>
        <Select id="u-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t.role[r]}
            </option>
          ))}
        </Select>
      </Field>
      {!user && (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <Checkbox label={t.admin.invite} checked={invite} onChange={setInvite} />
          <p className="mt-1 pl-6 text-[12px] text-muted">{t.admin.inviteHint}</p>
        </div>
      )}
      {!user && !invite && (
        <Field label={t.admin.password} htmlFor="u-pass" hint={t.admin.passwordHint}>
          <Input
            id="u-pass"
            type="text"
            autoComplete="off"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="num"
          />
        </Field>
      )}
      {save.error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{errorMessage(save.error)}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{t.common.cancel}</Button>
        <Button
          type="submit"
          variant="primary"
          loading={save.isPending}
          disabled={!username.trim() || (!user && !invite && password.length < 8)}
        >
          {user ? t.common.save : t.common.create}
        </Button>
      </div>
    </form>
  )
}

function PasswordForm({ user, onDone }: { user: User; onDone: (password: string) => void }) {
  const [password, setPassword] = useState('')
  const reset = useMutation({
    mutationFn: () => api.post<{ password: string }>(`/users/${user.id}/reset-password`, { password }),
    onSuccess: (r) => onDone(r.password),
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        reset.mutate()
      }}
      className="flex flex-col gap-4"
    >
      <Field label={t.profile.newPassword} htmlFor="rp-pass" hint={t.admin.resetHint}>
        <Input
          id="rp-pass"
          type="text"
          autoComplete="off"
          className="num"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {reset.error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{errorMessage(reset.error)}</p>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={reset.isPending} disabled={password !== '' && password.length < 8}>
          {t.common.save}
        </Button>
      </div>
    </form>
  )
}

type RegLink = { url: string | null; created_at?: string }

/** The shared registration link: whoever opens it creates their own recruiter account. */
function RegistrationLinkCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const link = useQuery({ queryKey: ['registration-link'], queryFn: () => api.get<RegLink>('/users/registration-link') })
  const save = (l: RegLink) => qc.setQueryData(['registration-link'], l)
  const create = useMutation({ mutationFn: () => api.post<RegLink>('/users/registration-link'), onSuccess: save, onError: (e) => toast(errorMessage(e), 'error') })
  const disable = useMutation({
    mutationFn: () => api.del('/users/registration-link'),
    onSuccess: () => save({ url: null }),
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const url = link.data?.url
  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold">{t.admin.regTitle}</h2>
          <p className="mt-1 text-[13px] text-muted">{url ? t.admin.regOn : t.admin.regOff}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {url ? (
            <>
              <Button
                size="sm"
                icon={<RefreshCw className="size-3.5" />}
                loading={create.isPending}
                onClick={async () => {
                  if (await confirm(t.admin.regNewConfirm, { confirmLabel: t.admin.regNew })) create.mutate()
                }}
              >
                {t.admin.regNew}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Link2Off className="size-3.5" />}
                loading={disable.isPending}
                onClick={async () => {
                  if (await confirm(t.admin.regDisableConfirm, { danger: true, confirmLabel: t.admin.regDisable })) disable.mutate()
                }}
              >
                {t.admin.regDisable}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon={<Link2 className="size-3.5" />} loading={create.isPending} disabled={link.isPending} onClick={() => create.mutate()}>
              {t.admin.regCreate}
            </Button>
          )}
        </div>
      </div>
      {url && (
        <div className="mt-3">
          <CopyField value={url} />
        </div>
      )}
    </Card>
  )
}

export function AdminUsersPage() {
  const { me } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const users = useUsers(true)
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState<{ name: string; password: string } | null>(null)
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const reinvite = useMutation({
    mutationFn: (u: User) => api.post<{ invite_code: string; invite_valid_until: string }>(`/users/${u.id}/invite`),
    onSuccess: (r, u) => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      setInvitation({ name: u.full_name, login: u.username, code: r.invite_code, until: r.invite_valid_until })
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const toggle = useMutation({
    mutationFn: (u: User) => api.patch<User>(`/users/${u.id}`, { is_active: !u.is_active }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      toast(t.admin.updated)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  return (
    <>
      <PageHeader
        title={t.admin.usersTitle}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            {t.admin.newUser}
          </Button>
        }
      />
      <RegistrationLinkCard />
      <Card className="overflow-hidden">
        {users.isPending ? (
          <Loading />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-2 text-left text-[12px] text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t.admin.name}</th>
                  <th className="px-4 py-2.5 font-medium">{t.admin.role}</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">{t.admin.lastLogin}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.data.map((u) => (
                  <tr key={u.id} className={u.is_active ? '' : 'opacity-60'}>
                    <td className="px-4 py-3">
                      <p className="font-medium">
                        {u.full_name} {u.id === me.user.id && <span className="text-[12px] text-muted">({t.common.you})</span>}
                      </p>
                      <p className="num text-[12px] text-muted">
                        @{u.username}
                        {u.email && ` · ${u.email}`}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1.5">
                        <Badge className="bg-accent-soft text-accent">{t.role[u.role]}</Badge>
                        {!u.is_active && <Badge className="bg-surface-2 text-muted">{t.admin.inactive}</Badge>}
                      </span>
                      {u.invite_pending && u.invite_expires_at ? (
                        <span className="mt-1 block text-[12px] text-muted">{fmt(t.admin.invitePending, { date: formatDateTime(u.invite_expires_at) })}</span>
                      ) : (
                        u.invite_expires_at && !u.last_login_at && <span className="mt-1 block text-[12px] text-danger">{t.admin.inviteExpired}</span>
                      )}
                    </td>
                    <td className="num hidden px-4 py-3 text-[13px] text-muted md:table-cell">
                      {u.last_login_at ? formatDateTime(u.last_login_at) : t.admin.never}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-0.5">
                        <IconButton label={t.common.edit} onClick={() => setEditing(u)}>
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton label={t.admin.resetPassword} onClick={() => setResetting(u)}>
                          <KeyRound className="size-4" />
                        </IconButton>
                        {u.is_active && (
                          <IconButton
                            label={t.admin.newCode}
                            disabled={reinvite.isPending}
                            onClick={async () => {
                              if (await confirm(fmt(t.admin.newCodeConfirm, { name: u.full_name }), { confirmLabel: t.admin.newCode })) reinvite.mutate(u)
                            }}
                          >
                            <TicketCheck className="size-4" />
                          </IconButton>
                        )}
                        {u.id !== me.user.id && (
                          <IconButton
                            label={u.is_active ? t.admin.deactivate : t.admin.activate}
                            onClick={async () => {
                              if (
                                !u.is_active ||
                                (await confirm(fmt(t.admin.deactivateConfirm, { name: u.full_name }), {
                                  danger: true,
                                  confirmLabel: t.admin.deactivate,
                                }))
                              )
                                toggle.mutate(u)
                            }}
                          >
                            {u.is_active ? <UserX className="size-4" /> : <UserCheck className="size-4" />}
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? t.admin.newUser : t.common.edit}>
        {editing && <UserForm user={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} onInvite={setInvitation} />}
      </Modal>
      <Modal open={!!invitation} onClose={() => setInvitation(null)} title={t.admin.inviteTitle} wide>
        {invitation && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{fmt(t.admin.inviteDone, { name: invitation.name })}</p>
            <CopyField value={invitation.code} />
            <p className="text-[13px] text-muted">{fmt(t.admin.inviteHowto, { login: invitation.login, date: formatDateTime(invitation.until) })}</p>
          </div>
        )}
      </Modal>
      <Modal open={!!resetting} onClose={() => setResetting(null)} title={resetting ? fmt(t.admin.resetTitle, { name: resetting.full_name }) : ''}>
        {resetting && (
          <PasswordForm
            user={resetting}
            onDone={(password) => {
              setNewPassword({ name: resetting.full_name, password })
              setResetting(null)
            }}
          />
        )}
      </Modal>
      <Modal open={!!newPassword} onClose={() => setNewPassword(null)} title={t.admin.resetPassword} wide>
        {newPassword && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{fmt(t.admin.resetDone, { name: newPassword.name })}</p>
            <CopyField value={newPassword.password} />
            <p className="text-[13px] text-muted">{t.admin.newPasswordHint}</p>
          </div>
        )}
      </Modal>
    </>
  )
}
