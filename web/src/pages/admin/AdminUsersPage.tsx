import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, Plus, UserCheck, UserX } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Role, User } from '../../lib/types'
import { useUsers } from '../../components/inputs'
import { Badge, Button, Card, ErrorState, Field, IconButton, Input, Loading, Modal, PageHeader, Select, useConfirm, useToast } from '../../components/ui'
import { CopyField } from '../ProfilePage'

const ROLES: Role[] = ['admin', 'coordinator', 'analyst']

function UserForm({ user, onDone }: { user?: User; onDone: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [username, setUsername] = useState(user?.username ?? '')
  const [name, setName] = useState(user?.full_name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState<Role>(user?.role ?? 'analyst')
  const [password, setPassword] = useState('')
  const save = useMutation({
    mutationFn: () =>
      user
        ? api.patch<User>(`/users/${user.id}`, { username, email, full_name: name, role })
        : api.post<User>('/users', { username, email, full_name: name || username, role, password }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      toast(user ? t.admin.updated : t.admin.created)
      onDone()
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
      <Field label={t.admin.role} htmlFor="u-role">
        <Select id="u-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t.role[r]}
            </option>
          ))}
        </Select>
      </Field>
      {!user && (
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
          disabled={!username.trim() || (!user && password.length < 8)}
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

export function AdminUsersPage() {
  const { me } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const users = useUsers(true)
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState<{ name: string; password: string } | null>(null)
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
        {editing && <UserForm user={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
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
