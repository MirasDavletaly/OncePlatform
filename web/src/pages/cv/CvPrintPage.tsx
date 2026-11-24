import { useEffect } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { t } from '../../i18n'
import { api } from '../../lib/api'
import type { Candidate } from '../../lib/types'
import { localProfile, ProfileView, useCvMeta, years } from '../../components/cv'
import { Button, ErrorState, Loading } from '../../components/ui'

/** CV on a clean page for the browser's "Save as PDF" (contacts left out, like the Word export). */
export function CvPrintPage() {
  const { id = '' } = useParams()
  const meta = useCvMeta()
  const q = useQuery({ queryKey: ['candidate', id], queryFn: () => api.get<Candidate>(`/cv/candidates/${id}`) })
  const ready = !!q.data?.profile && !meta.isPending
  // paper is white: the page opens in its own tab, so the dark theme is simply switched off here
  useEffect(() => document.documentElement.classList.remove('dark'), [])
  useEffect(() => {
    if (!ready) return
    document.title = `${q.data!.code} ${q.data!.full_name ?? ''}`.trim()
    const timer = window.setTimeout(() => window.print(), 300)
    return () => window.clearTimeout(timer)
  }, [ready, q.data])

  if (q.isPending) return <Loading className="min-h-screen" />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const c = q.data
  const p = localProfile(c)
  if (!p) return <ErrorState error={new Error(t.cv.pendingHint)} />
  return (
    <div className="min-h-screen bg-white text-[#111] print:min-h-0">
      <div className="mx-auto max-w-[800px] px-8 py-10 print:p-0">
        <div className="mb-6 flex justify-end print:hidden">
          <Button variant="primary" icon={<Printer className="size-4" />} onClick={() => window.print()}>
            {t.cv.print}
          </Button>
        </div>
        <h1 className="font-display text-[26px] font-semibold">{c.full_name || c.code}</h1>
        {p.basics.label && <p className="mt-1 text-[15px] text-[#444]">{p.basics.label}</p>}
        <p className="mt-2 mb-8 text-sm">
          <span className="font-semibold">{t.cv.totalExperience}:</span> {years(p.meta.totalYears)}
        </p>
        <ProfileView profile={p} meta={meta.data} />
      </div>
    </div>
  )
}
