import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { useSession } from '../../lib/session'
import type { Ticket } from '../../lib/types'
import { Markdown, MarkdownEditor } from '../../components/markdown'
import { Button, Card, EmptyState, useToast } from '../../components/ui'

export function DescriptionTab({ ticket }: { ticket: Ticket }) {
  const { can } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const [draft, setDraft] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (description: string) => api.patch<Ticket>(`/tickets/${ticket.number}`, { description }),
    onSuccess: (tk) => {
      qc.setQueryData(['ticket', ticket.number], tk)
      void qc.invalidateQueries({ queryKey: ['history', ticket.number] })
      setDraft(null)
      toast(t.common.saved)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })

  if (draft !== null) {
    return (
      <div className="flex flex-col gap-3">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onSave={() => save.mutate(draft)}
          placeholder={t.ticket.descriptionPlaceholder}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDraft(null)}>{t.common.cancel}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(draft)}>
            {t.common.save}
          </Button>
        </div>
      </div>
    )
  }

  const text = ticket.description ?? ''
  return (
    <Card className="p-5 sm:p-6">
      {can('ticket.edit') && (
        <div className="-mt-1 mb-2 flex justify-end">
          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDraft(text)}>
            {t.ticket.editDescription}
          </Button>
        </div>
      )}
      {text.trim() ? <Markdown>{text}</Markdown> : <EmptyState text={t.ticket.noDescription} />}
    </Card>
  )
}
