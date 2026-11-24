import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { language, setLanguage, t } from '../i18n'
import { api, errorMessage, refreshCSRF } from '../lib/api'
import type { Me } from '../lib/types'
import { Button, Field, Input, Loading } from '../components/ui'
import { LanguageToggle } from '../components/LanguageToggle'

/** The shared registration link (/join/:token): a person creates their own recruiter account. */
export function RegisterPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [, rerender] = useState(0)
  const open = useQuery({
    queryKey: ['registration-open', token],
    queryFn: () => api.get<{ open: boolean }>(`/auth/register?token=${encodeURIComponent(token)}`),
  })

  useEffect(() => {
    void refreshCSRF()
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError(t.login.mismatch)
      return
    }
    setBusy(true)
    try {
      let me = await api.post<Me>('/auth/register', { token, username, full_name: name, password })
      if (me.user.language !== language) me = await api.patch<Me>('/auth/me', { language })
      qc.setQueryData(['me'], me)
      navigate('/cv', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <LanguageToggle
        className="absolute top-5 right-5"
        onChange={(l) => {
          setLanguage(l)
          rerender((n) => n + 1)
        }}
      />
      <div className="w-full max-w-sm">
        <p className="font-display text-sm font-semibold text-accent">{t.app.name}</p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">{t.login.registerTitle}</h1>
        {open.isPending ? (
          <Loading />
        ) : !open.data?.open ? (
          <p role="alert" className="mt-6 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {open.isError ? errorMessage(open.error) : t.login.linkClosed}
          </p>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="mt-2 text-sm text-muted">{t.login.registerIntro}</p>
            <div className="mt-8 flex flex-col gap-4">
              <Field label={t.login.fullName} htmlFor="name" hint={t.login.fullNameHint}>
                <Input id="name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label={t.login.username} htmlFor="username" hint={t.login.usernameHint}>
                <Input
                  id="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field label={t.login.newPassword} htmlFor="password" hint={t.login.newPasswordHint}>
                <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label={t.login.confirmPassword} htmlFor="confirm">
                <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
              {error && (
                <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {error}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={!name.trim() || !username.trim() || password.length < 8 || !confirm}
                className="mt-2 w-full"
              >
                {busy ? t.login.registering : t.login.register}
              </Button>
            </div>
          </form>
        )}
        <Link to="/login" className="mt-4 inline-block text-[13px] text-accent hover:underline">
          {t.login.haveAccount}
        </Link>
      </div>
    </div>
  )
}
