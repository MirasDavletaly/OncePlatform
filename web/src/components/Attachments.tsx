import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, FileText, FileType2, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react'
import { fmt, t } from '../i18n'
import { api, errorMessage, uploadFile } from '../lib/api'
import { formatDateTime, formatNumber, formatSize } from '../lib/format'
import { useSession } from '../lib/session'
import type { Attachment, TextChunk } from '../lib/types'
import { cn } from '../lib/utils'
import { ViaBadge } from './badges'
import { Dropzone } from './inputs'
import { Badge, Button, Card, EmptyState, IconButton, Loading, Modal, Select, buttonClass, useConfirm, useToast } from './ui'

interface Upload {
  id: number
  name: string
  progress: number
  error?: string
}

function fileIcon(a: Attachment) {
  if (a.mime.startsWith('image/')) return <ImageIcon className="size-5" />
  if (a.mime === 'application/pdf') return <FileType2 className="size-5" />
  return <FileText className="size-5" />
}

/**
 * Attachment manager for a ticket or a KB article: drag-and-drop upload of
 * several files with progress, category, PDF/image preview, extracted text,
 * download and (admin) deletion.
 */
export function Attachments({
  listPath,
  uploadPath,
  queryKey,
  onChanged,
}: {
  listPath: string
  uploadPath: string
  queryKey: unknown[]
  onChanged?: () => void
}) {
  const { meta, can } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [category, setCategory] = useState('tz')
  const [uploads, setUploads] = useState<Upload[]>([])
  const [preview, setPreview] = useState<Attachment | null>(null)
  const [textOf, setTextOf] = useState<Attachment | null>(null)

  const list = useQuery({
    queryKey,
    queryFn: () => api.get<{ items: Attachment[] }>(listPath),
    refetchInterval: (q) => (q.state.data?.items.some((a) => a.extraction_status === 'pending') ? 3000 : false),
  })

  const text = useQuery({
    queryKey: ['attachment-text', textOf?.id],
    queryFn: () => api.get<TextChunk>(`/attachments/${textOf!.id}/text?limit=200000`),
    enabled: !!textOf,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey })
    onChanged?.()
  }

  const setCat = useMutation({
    mutationFn: ({ id, category }: { id: string; category: string }) => api.patch(`/attachments/${id}`, { category }),
    onSuccess: invalidate,
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/attachments/${id}`),
    onSuccess: () => {
      invalidate()
      toast(t.files.deleted)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })

  const onFiles = async (files: File[]) => {
    const maxBytes = meta.upload_max_mb * 1024 * 1024
    let ok = 0
    for (const file of files) {
      const id = Date.now() + Math.random()
      if (file.size > maxBytes) {
        toast(fmt(t.files.failed, { name: file.name, error: fmt(t.files.sizeLimit, { mb: meta.upload_max_mb }) }), 'error')
        continue
      }
      setUploads((u) => [...u, { id, name: file.name, progress: 0 }])
      try {
        await uploadFile(uploadPath, file, category, (p) =>
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))),
        )
        ok++
      } catch (e) {
        toast(fmt(t.files.failed, { name: file.name, error: errorMessage(e) }), 'error')
      } finally {
        setUploads((u) => u.filter((x) => x.id !== id))
      }
    }
    if (ok > 0) {
      toast(fmt(t.files.uploaded, { n: ok }))
      invalidate()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {can('ticket.files') && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            {t.files.categoryForUpload}
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 w-auto">
              {Object.entries(t.category).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </label>
          <Dropzone onFiles={onFiles} maxMb={meta.upload_max_mb} />
          {uploads.map((u) => (
            <div key={u.id} className="rounded-lg border border-line bg-surface px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span className="truncate">{fmt(t.files.uploading, { name: u.name })}</span>
                <span className="num text-muted">{Math.round(u.progress * 100)}%</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${u.progress * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        {list.isPending ? (
          <Loading />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState text={t.files.empty} />
        ) : (
          <ul className="divide-y divide-line">
            {list.data!.items.map((a) => {
              const inline = a.mime === 'application/pdf' || a.mime.startsWith('image/')
              return (
                <li key={a.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="mt-0.5 text-accent">{fileIcon(a)}</span>
                    <div className="min-w-0">
                      <a
                        href={`/api/v1/attachments/${a.id}/download`}
                        className="block truncate text-sm font-medium hover:text-accent"
                        title={a.original_name}
                      >
                        {a.original_name}
                      </a>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                        <span className="num">{formatSize(a.size)}</span>
                        <span>·</span>
                        <span>{fmt(t.files.uploadedBy, { name: a.uploaded_by_name, date: formatDateTime(a.created_at) })}</span>
                        <ViaBadge via={a.via} />
                        <Badge
                          className={cn(
                            a.extraction_status === 'done' && 'bg-ok-soft text-ok',
                            a.extraction_status === 'pending' && 'bg-accent-soft text-accent',
                            a.extraction_status === 'failed' && 'bg-danger-soft text-danger',
                            a.extraction_status === 'unsupported' && 'bg-surface-2 text-muted',
                          )}
                          title={a.extraction_error || undefined}
                        >
                          {a.extraction_status === 'pending' && <Loader2 className="size-3 animate-spin" />}
                          {t.files.extraction[a.extraction_status]}
                          {a.extraction_status === 'done' && a.text_length > 0 && ` · ${formatNumber(a.text_length)}`}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 pl-8 sm:pl-0">
                    {can('ticket.files') ? (
                      <Select
                        aria-label={t.ticket.fields}
                        value={a.category}
                        onChange={(e) => setCat.mutate({ id: a.id, category: e.target.value })}
                        className="h-8 w-auto text-[13px]"
                      >
                        {Object.entries(t.category).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge className="bg-surface-2 text-muted">{t.category[a.category]}</Badge>
                    )}
                    {inline && (
                      <IconButton label={t.files.preview} onClick={() => setPreview(a)}>
                        <Eye className="size-4" />
                      </IconButton>
                    )}
                    {a.extraction_status === 'done' && (
                      <IconButton label={t.files.textTitle} onClick={() => setTextOf(a)}>
                        <FileText className="size-4" />
                      </IconButton>
                    )}
                    <a
                      href={`/api/v1/attachments/${a.id}/download`}
                      aria-label={t.common.download}
                      title={t.common.download}
                      className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
                    >
                      <Download className="size-4" />
                    </a>
                    {can('delete') && (
                      <IconButton
                        label={t.common.delete}
                        onClick={async () => {
                          if (await confirm(fmt(t.files.deleteConfirm, { name: a.original_name }), { danger: true, confirmLabel: t.common.delete }))
                            remove.mutate(a.id)
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.original_name ?? ''}
        full
        footer={
          preview && (
            <a
              href={`/api/v1/attachments/${preview.id}/download?inline=1`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass('secondary', 'md')}
            >
              {t.files.openNewTab}
            </a>
          )
        }
      >
        {preview &&
          (preview.mime === 'application/pdf' ? (
            <iframe
              title={preview.original_name}
              src={`/api/v1/attachments/${preview.id}/download?inline=1`}
              className="h-[70vh] w-full rounded-lg border border-line bg-white"
            />
          ) : (
            <img
              src={`/api/v1/attachments/${preview.id}/download?inline=1`}
              alt={preview.original_name}
              className="mx-auto max-h-[70vh] rounded-lg"
            />
          ))}
      </Modal>

      <Modal open={!!textOf} onClose={() => setTextOf(null)} title={`${t.files.textTitle}: ${textOf?.original_name ?? ''}`} full>
        {text.isPending ? (
          <Loading />
        ) : text.data && text.data.text ? (
          <pre className="max-h-[70vh] overflow-auto rounded-lg bg-surface-2 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {text.data.text}
          </pre>
        ) : (
          <EmptyState text={t.files.noText} />
        )}
      </Modal>

      {list.isError && (
        <p className="text-sm text-danger">
          {errorMessage(list.error)}{' '}
          <Button size="sm" variant="ghost" onClick={() => list.refetch()}>
            {t.app.retry}
          </Button>
        </p>
      )}
    </div>
  )
}
