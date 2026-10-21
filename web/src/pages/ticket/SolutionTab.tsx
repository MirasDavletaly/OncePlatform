import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Lock, RotateCcw } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime, formatNumber } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { SolutionVersion, Ticket } from '../../lib/types'
import { cn } from '../../lib/utils'
import { ViaBadge } from '../../components/badges'
import { Markdown, MarkdownEditor } from '../../components/markdown'
import { Button, Card, CardHeader, EmptyState, Loading, Modal, useConfirm, useToast } from '../../components/ui'

export function SolutionTab({ ticket }: { ticket: Ticket }) {
  const { can } = useSession()
  const editable = can('ticket.solution')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const saved = ticket.technical_solution ?? ''
  const [draft, setDraft] = useState(saved)
  const [viewing, setViewing] = useState<string | null>(null)
  const dirty = draft !== saved

  // Pick up changes made elsewhere (e.g. by Claude) while there are no local edits.
  useEffect(() => {
    if (!dirty) setDraft(saved)
  }, [saved])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const versions = useQuery({
    queryKey: ['versions', ticket.number],
    queryFn: () => api.get<{ items: SolutionVersion[] }>(`/tickets/${ticket.number}/solution/versions`),
  })
  const version = useQuery({
    queryKey: ['version', ticket.number, viewing],
    queryFn: () => api.get<SolutionVersion>(`/tickets/${ticket.number}/solution/versions/${viewing}`),
    enabled: !!viewing,
  })

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['ticket', ticket.number] })
    void qc.invalidateQueries({ queryKey: ['versions', ticket.number] })
    void qc.invalidateQueries({ queryKey: ['history', ticket.number] })
  }

  const save = useMutation({
    mutationFn: (body: string) => api.put<SolutionVersion>(`/tickets/${ticket.number}/solution`, { body }),
    onSuccess: async () => {
      await refresh()
      toast(t.solution.saved)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const restore = useMutation({
    mutationFn: (id: string) => api.post<SolutionVersion>(`/tickets/${ticket.number}/solution/versions/${id}/restore`),
    onSuccess: async (v) => {
      setViewing(null)
      await refresh()
      setDraft(v.body ?? '')
      toast(t.solution.restored)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })

  const latestId = versions.data?.items[0]?.id

  return (
    <div className="grid gap-5 2xl:grid-cols-[1fr_280px]">
      <div className="min-w-0">
        {editable ? (
          <div className="flex flex-col gap-3">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              onSave={() => dirty && save.mutate(draft)}
              placeholder={t.solution.emptyEditor}
              minRows={18}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className={cn('text-[13px]', dirty ? 'text-gold' : 'text-muted')}>
                {dirty ? t.common.unsavedChanges : t.editor.saveHint}
              </span>
              <div className="flex gap-2">
                {dirty && <Button onClick={() => setDraft(saved)}>{t.common.cancel}</Button>}
                <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
                  {t.solution.save}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <Card className="p-5 sm:p-6">
            <p className="mb-4 flex items-center gap-2 text-[13px] text-muted">
              <Lock className="size-3.5" /> {t.solution.readOnly}
            </p>
            {saved.trim() ? <Markdown>{saved}</Markdown> : <EmptyState text={t.solution.empty} />}
          </Card>
        )}
      </div>

      <Card className="h-fit">
        <CardHeader title={<span className="flex items-center gap-2"><History className="size-4 text-muted" />{t.solution.versions}</span>} />
        {versions.isPending ? (
          <Loading className="py-6" />
        ) : (versions.data?.items.length ?? 0) === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">{t.solution.noVersions}</p>
        ) : (
          <ul className="max-h-[480px] divide-y divide-line overflow-y-auto">
            {versions.data!.items.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => setViewing(v.id)} className="w-full px-5 py-3 text-left hover:bg-surface-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="num text-[13px]">{formatDateTime(v.created_at)}</span>
                    {v.id === latestId && <span className="text-[11px] font-medium text-ok">{t.solution.current}</span>}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    {v.author_name} · {fmt(t.solution.chars, { n: formatNumber(v.length) })}
                    <ViaBadge via={v.via} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title={version.data ? fmt(t.solution.version, { date: formatDateTime(version.data.created_at) }) : t.app.loading}
        full
        footer={
          editable && viewing && viewing !== latestId ? (
            <Button
              variant="primary"
              icon={<RotateCcw className="size-4" />}
              loading={restore.isPending}
              onClick={async () => {
                if (await confirm(t.solution.restoreConfirm)) restore.mutate(viewing)
              }}
            >
              {t.solution.restore}
            </Button>
          ) : undefined
        }
      >
        {version.isPending ? (
          <Loading />
        ) : version.data?.body?.trim() ? (
          <Markdown>{version.data.body}</Markdown>
        ) : (
          <EmptyState text={t.solution.empty} />
        )}
      </Modal>
    </div>
  )
}
