import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { Button, Checkbox, ErrorState, Modal, useToast } from '../../components/ui'

interface Counts {
  jobs: number
  titles: number
  companies: number
  education: number
  name: boolean
}
interface Improvements {
  items: { id: string; code: string; before: Counts; after: Counts }[]
  same: number
  kept: number
  other: number
}

/** Administrators: apply the better parsing of the engine to CVs parsed earlier, never to profiles completed by hand. */
export function ImproveParsing() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon={<Sparkles className="size-4" />} onClick={() => setOpen(true)}>
        {t.cv.improve.button}
      </Button>
      {open && <ImproveModal onClose={() => setOpen(false)} />}
    </>
  )
}

function ImproveModal({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['cv-improvements'], queryFn: () => api.get<Improvements>('/cv/improvements'), gcTime: 0, retry: false })
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const picked = (q.data?.items ?? []).filter((x) => !skip.has(x.id)).map((x) => x.id)
  const apply = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/cv/improvements', { ids: picked }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['candidates'] })
      void qc.invalidateQueries({ queryKey: ['candidate'] })
      toast(fmt(t.cv.improve.done, { n: r.updated }))
      onClose()
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const d = q.data
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t.cv.improve.title}
      footer={
        <>
          <Button onClick={onClose}>{t.common.close}</Button>
          {!!d?.items.length && (
            <Button variant="primary" loading={apply.isPending} disabled={!picked.length} onClick={() => apply.mutate()}>
              {fmt(t.cv.improve.apply, { n: picked.length })}
            </Button>
          )}
        </>
      }
    >
      {q.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t.cv.improve.checking}
        </p>
      )}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">{d.items.length ? t.cv.improve.intro : t.cv.improve.none}</p>
          {d.items.map((x) => (
            <div key={x.id} className="flex flex-col gap-0.5 rounded-lg border border-line px-3 py-2">
              <Checkbox
                label={x.code}
                checked={!skip.has(x.id)}
                onChange={(on) => setSkip((s) => { const n = new Set(s); if (on) n.delete(x.id); else n.add(x.id); return n })}
              />
              <span className="pl-6 text-[13px] text-muted">
                {fmt(t.cv.improve.line, {
                  j1: x.before.jobs, j2: x.after.jobs, t1: x.before.titles, t2: x.after.titles,
                  c1: x.before.companies, c2: x.after.companies, e1: x.before.education, e2: x.after.education,
                })}
              </span>
            </div>
          ))}
          <p className="text-[13px] text-muted">{fmt(t.cv.improve.rest, { same: d.same, kept: d.kept, other: d.other })}</p>
        </div>
      )}
    </Modal>
  )
}
