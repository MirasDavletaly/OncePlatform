import { useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { fmt, t } from '../i18n'
import { api, errorMessage } from '../lib/api'
import type { CloseResult, Status, Ticket } from '../lib/types'
import { cn } from '../lib/utils'
import { Button, Field, Modal, Textarea, useToast } from './ui'

const ORDER: Status[] = ['new', 'analysis', 'solution', 'sent', 'closed']
const RESULTS: CloseResult[] = ['won', 'lost', 'cancelled', 'no_bid']

interface Pending {
  ticket: Pick<Ticket, 'number' | 'status'>
  to: Status
  needResult: boolean
  needComment: boolean
  resolve: (t: Ticket | null) => void
}

/**
 * Status change flow shared by the kanban and the ticket page. Closing asks
 * for a result; moving back asks for a comment. The server re-validates the
 * transition and its error message is shown when it refuses.
 */
export function useStatusChange(): {
  change: (ticket: Pick<Ticket, 'number' | 'status'>, to: Status) => Promise<Ticket | null>
  dialog: ReactNode
} {
  const qc = useQueryClient()
  const toast = useToast()
  const [pending, setPending] = useState<Pending | null>(null)
  const [result, setResult] = useState<CloseResult | ''>('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pendingRef = useRef<Pending | null>(null)

  const send = async (ticket: Pick<Ticket, 'number' | 'status'>, to: Status, res: string, cm: string) => {
    const updated = await api.post<Ticket>(`/tickets/${ticket.number}/status`, { status: to, result: res, comment: cm })
    qc.setQueryData(['ticket', ticket.number], updated)
    void qc.invalidateQueries({ queryKey: ['tickets'] })
    void qc.invalidateQueries({ queryKey: ['board'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
    void qc.invalidateQueries({ queryKey: ['history', ticket.number] })
    toast(fmt(t.ticket.statusChanged, { status: t.status[to] }))
    return updated
  }

  const change = (ticket: Pick<Ticket, 'number' | 'status'>, to: Status): Promise<Ticket | null> => {
    const needResult = to === 'closed'
    const needComment = ORDER.indexOf(to) < ORDER.indexOf(ticket.status)
    if (!needResult && !needComment) {
      return send(ticket, to, '', '').catch((err) => {
        toast(errorMessage(err), 'error')
        return null
      })
    }
    return new Promise<Ticket | null>((resolve) => {
      const p = { ticket, to, needResult, needComment, resolve }
      pendingRef.current = p
      setResult('')
      setComment('')
      setError('')
      setPending(p)
    })
  }

  const close = (value: Ticket | null) => {
    pendingRef.current?.resolve(value)
    pendingRef.current = null
    setPending(null)
    setBusy(false)
  }

  const submit = async () => {
    if (!pending) return
    setBusy(true)
    setError('')
    try {
      const updated = await send(pending.ticket, pending.to, result, comment)
      close(updated)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const valid = (!pending?.needResult || result !== '') && (!pending?.needComment || comment.trim().length >= 3)

  const dialog = (
    <Modal
      open={!!pending}
      onClose={() => close(null)}
      title={
        pending?.needResult
          ? `${t.ticket.closeTitle} ${pending.ticket.number}`
          : fmt(t.ticket.backTitle, { status: pending ? t.status[pending.to] : '' })
      }
      footer={
        <>
          <Button onClick={() => close(null)}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>
            {pending?.needResult ? t.statusVerb.closed : t.common.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {pending?.needResult && (
          <div>
            <p className="mb-3 text-sm text-muted">{t.ticket.closeText}</p>
            <div role="radiogroup" aria-label={t.ticket.resultLabel} className="grid grid-cols-2 gap-2">
              {RESULTS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={result === r}
                  onClick={() => setResult(r)}
                  className={cn(
                    'rounded-lg border px-3 py-3 text-left text-sm font-medium transition-colors',
                    result === r
                      ? r === 'won'
                        ? 'border-ok bg-ok-soft text-ok'
                        : 'border-accent bg-accent-soft text-accent'
                      : 'border-line hover:border-line-strong',
                  )}
                >
                  {t.result[r]}
                </button>
              ))}
            </div>
          </div>
        )}
        {pending?.needComment && <p className="text-sm text-muted">{t.ticket.backText}</p>}
        {(pending?.needComment || pending?.needResult) && (
          <Field label={pending?.needComment ? t.ticket.commentLabel : t.ticket.commentOptional} htmlFor="status-comment">
            <Textarea id="status-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        )}
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )

  return { change, dialog }
}
