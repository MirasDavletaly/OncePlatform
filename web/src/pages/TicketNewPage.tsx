import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { fmt, t } from '../i18n'
import { api, errorMessage, uploadFile } from '../lib/api'
import type { Ticket } from '../lib/types'
import { TicketForm, payloadFromValues, valuesFromTicket, type TicketFormValues } from '../components/TicketForm'
import { Card, PageHeader, useToast } from '../components/ui'

export function TicketNewPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')

  // Create the task first, then upload the specification files into it
  // (category "tz"). A failed file does not undo the task.
  const submit = async (v: TicketFormValues, files: File[]) => {
    setBusy(true)
    setError('')
    setProgress(t.ticket.creating)
    let tk: Ticket
    try {
      tk = await api.post<Ticket>('/tickets', payloadFromValues(v))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      return
    }
    let failed = 0
    for (let i = 0; i < files.length; i++) {
      setProgress(fmt(t.ticket.uploadingFiles, { done: i, total: files.length }))
      try {
        await uploadFile(`/tickets/${tk.number}/attachments`, files[i], 'tz')
      } catch (e) {
        failed++
        toast(fmt(t.files.failed, { name: files[i].name, error: errorMessage(e) }), 'error')
      }
    }
    void qc.invalidateQueries({ queryKey: ['tickets'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
    void qc.invalidateQueries({ queryKey: ['board'] })
    if (failed > 0) {
      toast(fmt(t.ticket.createdWithErrors, { number: tk.number }), 'error')
      navigate(`/tickets/${tk.number}?tab=files`)
    } else {
      toast(fmt(t.ticket.created, { number: tk.number }))
      navigate(`/tickets/${tk.number}${files.length ? '?tab=files' : ''}`)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.tickets.new} />
      <Card className="p-5 sm:p-6">
        <TicketForm
          initial={valuesFromTicket()}
          submitLabel={t.ticket.create}
          busy={busy}
          error={error || undefined}
          progress={progress}
          withFiles
          onSubmit={submit}
          onCancel={() => navigate(-1)}
        />
      </Card>
    </div>
  )
}