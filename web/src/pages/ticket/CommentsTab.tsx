import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Pencil, Trash2 } from 'lucide-react'
import { t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime, timeAgo } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Comment, Ticket } from '../../lib/types'
import { ViaBadge } from '../../components/badges'
import { MentionTextarea } from '../../components/inputs'
import { Markdown } from '../../components/markdown'
import { Button, Card, EmptyState, IconButton, Loading, useConfirm, useToast } from '../../components/ui'

function Avatar({ name, claude }: { name: string; claude?: boolean }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className={
        'flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ' +
        (claude ? 'bg-info-soft text-info' : 'bg-accent-soft text-accent')
      }
      aria-hidden
    >
      {initials}
    </span>
  )
}

export function CommentsTab({ ticket }: { ticket: Ticket }) {
  const { me, can } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const key = ['comments', ticket.number]
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: Comment[] }>(`/tickets/${ticket.number}/comments`),
    refetchInterval: 30_000,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['ticket', ticket.number] })
    void qc.invalidateQueries({ queryKey: ['history', ticket.number] })
  }
  const add = useMutation({
    mutationFn: (text: string) => api.post<Comment>(`/tickets/${ticket.number}/comments`, { body: text }),
    onSuccess: () => {
      setBody('')
      refresh()
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const edit = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.patch<Comment>(`/comments/${id}`, { body: text }),
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/comments/${id}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  })

  const submit = () => {
    if (body.trim()) add.mutate(body)
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        {list.isPending ? (
          <Loading />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState icon={<MessageSquare className="size-6" />} text={t.comments.empty} />
        ) : (
          <ol className="flex flex-col gap-5">
            {list.data!.items.map((c) => {
              const own = c.author_id === me.user.id
              return (
                <li key={c.id} className="flex gap-3">
                  <Avatar name={c.author_name} claude={c.via === 'mcp'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold">{c.author_name}</span>
                      <span className="text-[12px] text-muted" title={formatDateTime(c.created_at)}>
                        {timeAgo(c.created_at)}
                      </span>
                      {c.edited_at && <span className="text-[12px] text-muted">· {t.comments.edited}</span>}
                      <ViaBadge via={c.via} />
                      <span className="ml-auto flex">
                        {own && editing?.id !== c.id && (
                          <IconButton label={t.common.edit} onClick={() => setEditing({ id: c.id, body: c.body })} className="size-7">
                            <Pencil className="size-3.5" />
                          </IconButton>
                        )}
                        {(own || can('delete')) && (
                          <IconButton
                            label={t.common.delete}
                            className="size-7"
                            onClick={async () => {
                              if (await confirm(t.comments.deleteConfirm, { danger: true, confirmLabel: t.common.delete }))
                                remove.mutate(c.id)
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </IconButton>
                        )}
                      </span>
                    </div>
                    {editing?.id === c.id ? (
                      <div className="mt-2 flex flex-col gap-2">
                        <MentionTextarea
                          value={editing.body}
                          onChange={(v) => setEditing({ id: c.id, body: v })}
                          onSubmit={() => edit.mutate({ id: c.id, text: editing.body })}
                          rows={4}
                        />
                        <div className="flex justify-end gap-2">
                          <Button size="sm" onClick={() => setEditing(null)}>
                            {t.common.cancel}
                          </Button>
                          <Button size="sm" variant="primary" loading={edit.isPending} onClick={() => edit.mutate({ id: c.id, text: editing.body })}>
                            {t.common.save}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1 rounded-lg bg-surface-2 px-3.5 py-2.5">
                        <Markdown>{c.body}</Markdown>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Card>

      {can('ticket.files') && (
        <div className="flex flex-col gap-2">
          <MentionTextarea value={body} onChange={setBody} onSubmit={submit} placeholder={t.comments.placeholder} rows={4} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted">Ctrl+Enter — {t.comments.send.toLowerCase()}</span>
            <Button variant="primary" loading={add.isPending} disabled={!body.trim()} onClick={submit}>
              {add.isPending ? t.comments.sending : t.comments.send}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
