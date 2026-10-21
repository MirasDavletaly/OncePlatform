import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { language, setLanguage, t } from '../i18n'
import { api, errorMessage, refreshCSRF } from '../lib/api'
import type { Me } from '../lib/types'
import { safeNext } from '../lib/utils'
import { Button, Field, Input } from '../components/ui'
import { LanguageToggle } from '../components/LanguageToggle'

export function LoginPage({ loggedIn }: { loggedIn: boolean }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [, rerender] = useState(0)
  const next = safeNext(params.get('next'))

  useEffect(() => {
    if (loggedIn) {
      if (next && next.startsWith('/oauth/')) window.location.assign(next)
      else navigate(next ?? '/', { replace: true })
      return
    }
    void refreshCSRF()
  }, [loggedIn, next, navigate])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      let me = await api.post<Me>('/auth/login', { username, password })
      // Keep the language chosen on this page as the user's preference.
      if (me.user.language !== language) {
        me = await api.patch<Me>('/auth/me', { language })
      }
      // OAuth consent and other server-rendered pages need a full page load.
      if (next && (next.startsWith('/oauth/') || next.startsWith('/api/'))) {
        window.location.assign(next)
        return
      }
      qc.setQueryData(['me'], me)
      navigate(next ?? '/', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-accent-strong p-12 text-white lg:flex lg:flex-col lg:justify-between dark:bg-[#0a2a33]">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 64 64" className="size-10" aria-hidden>
            <rect width="64" height="64" rx="14" fill="#ffffff22" />
            <circle cx="32" cy="32" r="15" fill="none" stroke="#e8a400" strokeWidth="6" />
            <path d="M32 22v10l7 5" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-display text-lg font-semibold">{t.app.name}</span>
        </div>
        <div className="max-w-lg">
          <p className="font-display text-[34px] leading-[1.15] font-semibold tracking-tight">{t.app.tagline}</p>
          <p className="mt-4 text-[15px] leading-relaxed text-white/80">{t.login.subtitle}</p>
        </div>
        <ol className="flex flex-wrap gap-2 text-[13px]" aria-label={t.login.stages}>
          {(['new', 'analysis', 'solution', 'sent', 'closed'] as const).map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className="rounded-full border border-white/30 px-3 py-1 text-white/90">{t.status[s]}</span>
              {i < 4 && <span className="text-[#e8a400]" aria-hidden>→</span>}
            </li>
          ))}
        </ol>
      </div>
      <div className="relative flex items-center justify-center p-6">
        <LanguageToggle
          className="absolute top-5 right-5"
          onChange={(l) => {
            setLanguage(l)
            rerender((n) => n + 1)
          }}
        />
        <form onSubmit={submit} className="w-full max-w-sm" noValidate>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{t.login.title}</h1>
          <p className="mt-2 text-sm text-muted lg:hidden">{t.login.subtitle}</p>
          <div className="mt-8 flex flex-col gap-4">
            <Field label={t.login.username} htmlFor="username">
              <Input
                id="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label={t.login.password} htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" loading={busy} disabled={!username || !password} className="mt-2 w-full">
              {busy ? t.login.submitting : t.login.submit}
            </Button>
            <p className="text-[13px] leading-relaxed text-muted">{t.login.noAccount}</p>
          </div>
        </form>
      </div>
    </div>
  )
}
