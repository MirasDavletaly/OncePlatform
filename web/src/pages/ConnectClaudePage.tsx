import { AlertTriangle, Laptop, Smartphone, Sparkles, Terminal } from 'lucide-react'
import { t } from '../i18n'
import { useSession } from '../lib/session'
import { Card, CardHeader, PageHeader } from '../components/ui'
import { CopyField, TokensCard } from './ProfilePage'

export function ConnectClaudePage() {
  const { meta } = useSession()
  const command = `claude mcp add --transport http portal ${meta.mcp_url} --header "Authorization: Bearer ${t.claude.tokenPlaceholder}"`
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.claude.title} subtitle={t.claude.intro} />
      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <p className="mb-2 text-[13px] font-medium text-muted">{t.claude.serverUrl}</p>
          <CopyField value={meta.mcp_url} />
          {!meta.https && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-gold-soft px-3 py-2.5 text-[13px] text-gold">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t.claude.httpsWarning}
            </p>
          )}
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Laptop className="size-4 text-muted" />
                <Smartphone className="size-4 text-muted" />
                {t.claude.appsTitle}
              </span>
            }
          />
          <ol className="flex flex-col gap-3 p-5">
            {t.claude.appsSteps.map((step, i) => (
              <li key={step} className="flex gap-3 text-sm">
                <span className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
                  {i + 1}
                </span>
                <span className="pt-0.5 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Terminal className="size-4 text-muted" />{t.claude.codeTitle}</span>} />
          <div className="flex flex-col gap-3 p-5">
            <p className="text-sm">{t.claude.codeSteps}</p>
            <CopyField value={command} />
          </div>
        </Card>

        <TokensCard />

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-gold" />{t.claude.examplesTitle}</span>} />
          <ul className="flex flex-col gap-2 p-5">
            {t.claude.examples.map((ex) => (
              <li key={ex} className="rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-sm">
                {ex}
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-5 py-3 text-[13px] text-muted">{t.claude.promptHint}</p>
        </Card>
      </div>
    </div>
  )
}
