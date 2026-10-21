import { useQueryClient } from '@tanstack/react-query'
import type { Ticket } from '../../lib/types'
import { Attachments } from '../../components/Attachments'

export function FilesTab({ ticket }: { ticket: Ticket }) {
  const qc = useQueryClient()
  return (
    <Attachments
      listPath={`/tickets/${ticket.number}/attachments`}
      uploadPath={`/tickets/${ticket.number}/attachments`}
      queryKey={['attachments', ticket.number]}
      onChanged={() => {
        void qc.invalidateQueries({ queryKey: ['ticket', ticket.number] })
        void qc.invalidateQueries({ queryKey: ['history', ticket.number] })
      }}
    />
  )
}
