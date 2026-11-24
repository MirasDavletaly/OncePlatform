import { ShortlistSummary } from '../../components/Shortlist'
import { submissionPending } from '../../lib/shortlist'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ExternalLink, Pencil, Trash2, Undo2 } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { ApiError, api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Ticket } from '../../lib/types'
import { DeadlineBadge, PriorityBadge, StatusBadge } from '../../components/badges'
import { useStatusChange } from '../../components/StatusChange'
import { TicketForm, payloadFromValues, valuesFromTicket, type TicketFormValues } from '../../components/TicketForm'
import { Button, Card, ErrorState, Loading, Modal, Tabs, useConfirm, useToast } from '../../components/ui'
import { NotFoundPage } from '../NotFoundPage'
import { DescriptionTab } from './DescriptionTab'
import { SolutionTab } from './SolutionTab'
import { FilesTab } from './FilesTab'
import { CommentsTab } from './CommentsTab'
import { HistoryTab } from './HistoryTab'
import { CandidatesTab } from './CandidatesTab'

type Tab = 'description' | 'solution' | 'files' | 'candidates' | 'comments' | 'history'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export function TicketPage() {
  const { ref = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'description'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const { can } = useSession()
  const { change, dialog } = useStatusChange()
  const [editing, setEditing] = useState(false)

  const q = useQuery({ queryKey: ['ticket', ref], queryFn: () => api.get<Ticket>(`/tickets/${ref}`) })

  const update = useMutation({
    mutationFn: (v: TicketFormValues) => api.patch<Ticket>(`/tickets/${ref}`, payloadFromValues(v, false)),
    onSuccess: (tk) => {
      qc.setQueryData(['ticket', ref], tk)
      void qc.invalidateQueries({ queryKey: ['history', ref] })
      void qc.invalidateQueries({ queryKey: ['tickets'] })
      void qc.invalidateQueries({ queryKey: ['board'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      setEditing(false)
      toast(t.ticket.updated)
    },
  })

  const remove = useMutation({
    mutationFn: () => api.del(`/tickets/${ref}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets'] })
      void qc.invalidateQueries({ queryKey: ['board'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast(t.ticket.deleted)
      navigate('/tickets')
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })

  if (q.isPending) return <Loading />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage />
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  }
  const tk = q.data
  const setTab = (id: Tab) => {
    const next = new URLSearchParams(params)
    if (id === 'description') next.delete('tab')
    else next.set('tab', id)
    setParams(next, { replace: true })
  }

  return (
    <>
      <div className="mb-4">
        <Link to="/tickets" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> {t.nav.tickets}
        </Link>
      </div>

      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-sm font-semibold text-accent">{tk.number}</span>
            <StatusBadge status={tk.status} result={tk.close_result} />
            <PriorityBadge priority={tk.priority} compact />
          </div>
          <h1 className="mt-2 font-display text-[21px] leading-snug font-semibold tracking-tight break-words sm:text-[24px]">
            {tk.title}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {(tk.transitions ?? []).map((tr) => (
            <Button
              key={tr.to}
              size="sm"
              variant={tr.backward ? 'secondary' : 'primary'}
              icon={tr.backward ? <Undo2 className="size-3.5" /> : <ArrowRight className="size-3.5" />}
              onClick={() => change(tk, tr.to)}
            >
              {tr.backward ? `${t.common.back}: ${t.status[tr.to]}` : t.statusVerb[tr.to]}
            </Button>
          ))}
          {can('ticket.edit') && (
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
              {t.common.edit}
            </Button>
          )}
          {can('delete') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="size-3.5" />}
              onClick={async () => {
                if (await confirm(fmt(t.ticket.deleteConfirm, { number: tk.number }), { danger: true, confirmLabel: t.common.delete }))
                  remove.mutate()
              }}
            >
              <span className="sr-only">{t.ticket.delete}</span>
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'description', label: t.ticket.tabs.description },
              { id: 'solution', label: t.ticket.tabs.solution },
              { id: 'files', label: t.ticket.tabs.files, count: tk.attachments_count },
              ...(can('cv.view') ? [{ id: 'candidates' as const, label: t.ticket.tabs.candidates }] : []),
              { id: 'comments', label: t.ticket.tabs.comments, count: tk.comments_count },
              { id: 'history', label: t.ticket.tabs.history },
            ]}
          />
          <div className="pt-5">
            {tab === 'description' && <DescriptionTab ticket={tk} />}
            {tab === 'solution' && <SolutionTab ticket={tk} />}
            {tab === 'files' && <FilesTab ticket={tk} />}
            {tab === 'candidates' && can('cv.view') && <CandidatesTab ticket={tk} />}
            {tab === 'comments' && <CommentsTab ticket={tk} />}
            {tab === 'history' && <HistoryTab ticket={tk} />}
          </div>
        </div>

        <aside className="xl:order-none order-first">
          <Card className="p-5">
            <div className="mb-3 border-b border-line pb-4">
              <p className="mb-1 text-[12px] text-muted">{t.ticket.deadline}</p>
              <DeadlineBadge deadline={tk.deadline} closed={!submissionPending(tk.status)} size="lg" />
            </div>
            <div className="mb-3 border-b border-line pb-4"><ShortlistSummary ticket={tk} full /></div>
            <dl className="divide-y divide-line">
              {tk.close_result === 'lost' && <Row label={t.shortlist.lossReason}>{t.lossReasons[tk.loss_reason || 'unknown']}</Row>}
              <Row label={t.ticket.assignee}>
                {tk.assignee_name ?? <span className="font-medium text-accent">{t.common.everyone}</span>}
              </Row>
              <Row label={t.ticket.priority}>
                <PriorityBadge priority={tk.priority} />
              </Row>
              <Row label={t.ticket.sourceUrl}>
                {tk.source_url ? (
                  <a href={tk.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
                    {t.ticket.openSource} <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  <span className="text-muted">{t.common.none}</span>
                )}
              </Row>
              <Row label={t.ticket.createdBy}>
                {tk.created_by_name}
                <span className="num block text-[12px] text-muted">{formatDateTime(tk.created_at)}</span>
              </Row>
              <Row label={t.ticket.updatedAt}>
                <span className="num text-[13px]">{formatDateTime(tk.updated_at)}</span>
              </Row>
              {tk.closed_at && (
                <Row label={t.ticket.closedAt}>
                  <span className="num text-[13px]">{formatDateTime(tk.closed_at)}</span>
                </Row>
              )}
            </dl>
          </Card>
        </aside>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title={`${t.ticket.editTitle} ${tk.number}`} wide>
        <TicketForm
          ticketId={tk.id}
          initial={valuesFromTicket(tk)}
          submitLabel={t.common.save}
          busy={update.isPending}
          error={update.error ? errorMessage(update.error) : undefined}
          onSubmit={(v) => update.mutate(v)}
          onCancel={() => setEditing(false)}
          showDescription={false}
        />
      </Modal>
      {dialog}
    </>
  )
}
