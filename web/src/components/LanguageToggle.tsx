import { useMutation, useQueryClient } from '@tanstack/react-query'
import { language, t, type Language } from '../i18n'
import { api } from '../lib/api'
import type { Me } from '../lib/types'
import { cn } from '../lib/utils'

const LANGS: { id: Language; short: string }[] = [
  { id: 'en', short: 'EN' },
  { id: 'ru', short: 'RU' },
]

/** Compact EN | RU switch. */
export function LanguageToggle({
  onChange,
  disabled,
  className,
}: {
  onChange: (lang: Language) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div role="group" aria-label={t.nav.language} className={cn('inline-flex rounded-lg bg-paper p-0.5 ring-1 ring-line', className)}>
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          title={t.nav.languages[l.id]}
          aria-pressed={language === l.id}
          disabled={disabled}
          onClick={() => language !== l.id && onChange(l.id)}
          className={cn(
            'rounded-md px-2 py-1 text-[12px] font-semibold transition-colors',
            language === l.id ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
          )}
        >
          {l.short}
        </button>
      ))}
    </div>
  )
}

/** Saves the interface language of the signed-in user on the server. */
export function useSaveLanguage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lang: Language) => api.patch<Me>('/auth/me', { language: lang }),
    onSuccess: (data) => {
      qc.setQueryData(['me'], data)
      void qc.invalidateQueries()
    },
  })
}
