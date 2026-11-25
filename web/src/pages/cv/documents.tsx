import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, FileText, GraduationCap, IdCard, Loader2, RefreshCw, ScanText, Trash2 } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Candidate, CvDocument } from '../../lib/types'
import { cn } from '../../lib/utils'
import { degreeLabel } from '../../components/cv'
import { Dropzone } from '../../components/inputs'
import { Badge, Button, Card, IconButton, Modal, Select, useConfirm, useToast } from '../../components/ui'

const DOC_ACCEPT = '.pdf,.docx,.txt,.png,.jpg,.jpeg'

/** "PMP — Project Management Institute (PMI)", "Диплом (бакалавр) — Евразийский университет". */
export function docTitle(d: CvDocument): string {
  const i = d.info
  if (!i) return d.file_name
  if (i.kind === 'id') return t.cv.docs.idTitle[i.title ?? ''] ?? i.title ?? t.cv.docs.kind.id
  const what = i.kind === 'diploma' ? `${t.cv.docs.kind.diploma}${i.degree ? ` (${degreeLabel(i.degree)})` : ''}` : i.title || t.cv.docs.kind.certificate
  return [what, i.kind === 'diploma' ? i.institution : i.issuer].filter(Boolean).join(' — ')
}

function DocFacts({ d }: { d: CvDocument }) {
  const i = d.info
  if (d.status === 'pending') {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-accent">
        <Loader2 className="size-3 animate-spin" /> {t.cv.docs.pending}
      </span>
    )
  }
  if (d.status === 'failed') return <span className="text-[12px] text-danger">{fmt(t.cv.docs.failed, { error: d.error ?? '' })}</span>
  if (!i) return null
  const facts = [
    i.kind === 'diploma' && i.area,
    i.date && fmt(t.cv.docs.issued, { date: i.date }),
    i.expires && fmt(t.cv.docs.expires, { date: i.expires }),
    i.number && fmt(t.cv.docs.number, { n: i.number }),
  ].filter(Boolean)
  return facts.length ? <span className="text-[12px] text-muted">{facts.join(' · ')}</span> : null
}

function DocIcon({ d }: { d: CvDocument }) {
  const Icon = d.info?.kind === 'diploma' ? GraduationCap : d.info?.kind === 'id' ? IdCard : d.info ? Award : FileText
  return <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-label={d.info ? t.cv.docs.kind[d.info.kind] : undefined} />
}

/** Candidate picker: the candidates the document names come first. */
function AssignControl({ d, candidates, label }: { d: CvDocument; candidates: Candidate[]; label: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const hits = new Map((d.info?.suggestions ?? []).map((s) => [s.id, s.hits]))
  const options = candidates
    .filter((c) => c.id !== d.candidate_id)
    .sort((a, b) => (hits.get(b.id) ?? 0) - (hits.get(a.id) ?? 0) || (a.full_name || a.code).localeCompare(b.full_name || b.code))
  const [pick, setPick] = useState(() => (d.candidate_id ? '' : (d.info?.suggestions?.[0]?.id ?? '')))
  const assign = useMutation({
    mutationFn: () => api.post<CvDocument>(`/cv/documents/${d.id}/assign`, { candidate_id: pick }),
    onSuccess: (next) => {
      toast(fmt(t.cv.docs.assigned, { name: next.candidate_name || next.candidate_code || '' }))
      void qc.invalidateQueries({ queryKey: ['cv-documents'] })
      void qc.invalidateQueries({ queryKey: ['candidates'] })
      void qc.invalidateQueries({ queryKey: ['candidate'] })
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  return (
    <div className="flex items-center gap-2">
      <Select aria-label={t.cv.docs.pick} className="h-8 w-64 text-[13px]" value={pick} onChange={(e) => setPick(e.target.value)}>
        <option value="">{t.cv.docs.pick}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.full_name || c.code} ({c.code}){hits.has(c.id) ? ` · ${t.cv.docs.suggested}` : ''}
          </option>
        ))}
      </Select>
      <Button size="sm" variant={d.candidate_id ? 'secondary' : 'primary'} disabled={!pick || d.status === 'pending'} loading={assign.isPending} onClick={() => assign.mutate()}>
        {label}
      </Button>
    </div>
  )
}

function DeleteDoc({ d }: { d: CvDocument }) {
  const { can } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const remove = useMutation({
    mutationFn: () => api.del(`/cv/documents/${d.id}`),
    onSuccess: () => {
      toast(t.cv.docs.deleted)
      void qc.invalidateQueries({ queryKey: ['cv-documents'] })
      void qc.invalidateQueries({ queryKey: ['candidates'] })
      void qc.invalidateQueries({ queryKey: ['candidate'] })
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  if (!can('cv.delete')) return null // deleting is for good: administrators and coordinators
  return (
    <IconButton
      label={t.common.delete}
      className="size-8"
      disabled={remove.isPending}
      onClick={async () => {
        if (await confirm(fmt(t.cv.docs.deleteConfirm, { name: d.file_name }), { danger: true, confirmLabel: t.common.delete })) remove.mutate()
      }}
    >
      <Trash2 className="size-4" />
    </IconButton>
  )
}

function ReprocessDoc({ d }: { d: CvDocument }) {
  const qc = useQueryClient()
  const toast = useToast()
  const run = useMutation({
    mutationFn: () => api.post<CvDocument>(`/cv/documents/${d.id}/reprocess`),
    onSuccess: () => {
      toast(t.cv.docs.reprocessing)
      void qc.invalidateQueries({ queryKey: ['cv-documents'] })
      void qc.invalidateQueries({ queryKey: ['candidate'] })
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  return (
    <IconButton label={t.cv.docs.reprocess} className="size-8" disabled={run.isPending || d.status === 'pending'} onClick={() => run.mutate()}>
      <RefreshCw className="size-4" />
    </IconButton>
  )
}

function FileLink({ d }: { d: CvDocument }) {
  return (
    <a href={`/api/v1/cv/documents/${d.id}/file`} className="min-w-0 truncate text-[13px] text-accent hover:underline" title={d.file_name}>
      {d.file_name}
    </a>
  )
}

type UploadResult = { items: unknown[]; failed: { name: string; error: string }[]; skipped?: { name: string; error: string }[] }

/** Upload results: new files, files already in the portal (not an error), failures. */
export function useUploadToasts() {
  const toast = useToast()
  return (res: UploadResult, uploaded: string) => {
    if (res.items.length) toast(fmt(uploaded, { n: res.items.length }))
    res.skipped?.forEach((f) => toast(fmt(t.cv.skipped, { name: f.name, reason: f.error })))
    res.failed.forEach((f) => toast(fmt(t.files.failed, { name: f.name, error: f.error }), 'error'))
  }
}

export function DocUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { meta } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const report = useUploadToasts()
  const [busy, setBusy] = useState(false)
  const onFiles = async (files: File[]) => {
    const fd = new FormData()
    files.forEach((f) => fd.append('file', f, f.name))
    setBusy(true)
    try {
      const res = await api.post<UploadResult>('/cv/documents', fd)
      report(res, t.cv.docs.uploaded)
      void qc.invalidateQueries({ queryKey: ['cv-documents'] })
      if (res.failed.length === 0) onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t.cv.docs.upload} wide>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">{t.cv.docs.hint}</p>
        <Dropzone onFiles={onFiles} maxMb={meta.upload_max_mb} accept={DOC_ACCEPT} disabled={busy} title={t.cv.docs.drop} hint={fmt(t.cv.docs.uploadHint, { mb: meta.upload_max_mb })} />
        {busy && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> {t.common.saving}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** Documents waiting for a candidate, and those attached during the last day. */
export function DocumentsPanel({ candidates }: { candidates: Candidate[] }) {
  const q = useQuery({
    queryKey: ['cv-documents'],
    queryFn: () => api.get<{ items: CvDocument[] }>('/cv/documents'),
    refetchInterval: (query) => (query.state.data?.items.some((d) => d.status === 'pending') ? 3000 : false),
  })
  const qc = useQueryClient()
  const items = q.data?.items ?? []
  const inbox = items.filter((d) => !d.candidate_id)
  const recent = items.filter((d) => d.candidate_id)
  // a document attached in the background changes a profile in the list
  const attached = recent.map((d) => d.id).join()
  useEffect(() => {
    if (attached) void qc.invalidateQueries({ queryKey: ['candidates'] })
  }, [attached, qc])
  if (items.length === 0) return null
  return (
    <Card className="mb-4 p-4">
      {inbox.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">
            {t.cv.docs.inbox} <span className="num text-muted">{inbox.length}</span>
          </h2>
          <ul className="divide-y divide-line">
            {inbox.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 gap-2.5">
                  <DocIcon d={d} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{docTitle(d)}</span>
                    <DocFacts d={d} />
                    <span className="text-[12px]">
                      <span className="text-muted">{t.cv.docs.holder}: </span>
                      {d.info?.holder ? <span className="font-medium">{d.info.holder}</span> : <span className="text-muted">{t.cv.docs.noHolder}</span>}
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] text-muted">
                      <FileLink d={d} />
                      {d.ocr && <ScanText className="size-3.5" aria-label={t.cv.ocr} />}
                      {d.delete_after && <span>{fmt(t.cv.docs.deleteAfter, { date: formatDate(d.delete_after) })}</span>}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 pl-6 lg:pl-0">
                  <AssignControl d={d} candidates={candidates} label={t.cv.docs.assign} />
                  <ReprocessDoc d={d} />
                  <DeleteDoc d={d} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recent.length > 0 && (
        <section className={cn(inbox.length > 0 && 'mt-3 border-t border-line pt-3')}>
          <h2 className="mb-1 text-[13px] font-medium text-muted">{t.cv.docs.recent}</h2>
          <ul className="flex flex-col gap-1.5">
            {recent.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <DocIcon d={d} />
                <span className="font-medium">{docTitle(d)}</span>
                <span className="text-muted">→</span>
                <Link to={`/cv/${d.candidate_id}`} className="text-accent hover:underline">
                  {d.candidate_name || d.candidate_code}
                </Link>
                <Badge className="bg-surface-2 text-muted">{d.assigned === 'auto' ? t.cv.docs.auto : t.cv.docs.manual}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  )
}

/** The documents of one candidate (candidate page, cv.manage). */
export function CandidateDocuments({ docs }: { docs: CvDocument[] }) {
  if (docs.length === 0) return <span className="text-[13px] text-muted">{t.cv.docs.none}</span>
  return (
    <ul className="flex flex-col gap-2">
      {docs.map((d) => (
        <li key={d.id} className="flex items-start gap-2">
          <DocIcon d={d} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium">{docTitle(d)}</span>
            <DocFacts d={d} />
            <span className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
              <FileLink d={d} />
              <span className="shrink-0">· {d.assigned === 'auto' ? t.cv.docs.auto : t.cv.docs.manual}</span>
            </span>
          </div>
          <ReprocessDoc d={d} />
          <DeleteDoc d={d} />
        </li>
      ))}
    </ul>
  )
}
