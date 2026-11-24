import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, IdCard, Loader2, ScanText, ShieldCheck, Upload } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { dayKey, formatDate } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Candidate, CvProfile } from '../../lib/types'
import { cn } from '../../lib/utils'
import {
  countryLabel, DEGREE_ORDER, degreeLabel, isLangCode, langLabel, localProfile, placeLabel, positionLabel, profLabel, topEducation, useCvMeta, years,
} from '../../components/cv'
import { Dropzone } from '../../components/inputs'
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, useToast } from '../../components/ui'
import { DocUploadModal, DocumentsPanel, useUploadToasts } from './documents'

const CV_ACCEPT = '.pdf,.docx,.txt,.png,.jpg,.jpeg'

export function StatusBadge({ c }: { c: Candidate }) {
  return (
    <Badge
      className={cn(
        c.status === 'ready' && 'bg-ok-soft text-ok',
        c.status === 'pending' && 'bg-accent-soft text-accent',
        c.status === 'failed' && 'bg-danger-soft text-danger',
      )}
      title={c.error || undefined}
    >
      {c.status === 'pending' && <Loader2 className="size-3 animate-spin" />}
      {t.cv.status[c.status]}
    </Badge>
  )
}

function UploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { meta } = useSession()
  const qc = useQueryClient()
  const toast = useToast()
  const report = useUploadToasts()
  const [date, setDate] = useState(() => dayKey(new Date()))
  const [note, setNote] = useState('')
  const [referral, setReferral] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const onFiles = async (files: File[]) => {
    if (!confirmed) {
      toast(t.cv.consentRequired, 'error')
      return
    }
    const fd = new FormData()
    fd.append('consent_date', date)
    fd.append('consent_note', note)
    fd.append('referred_by', referral)
    files.forEach((f) => fd.append('file', f, f.name))
    setBusy(true)
    try {
      const res = await api.post<{ items: Candidate[]; failed: { name: string; error: string }[]; skipped: { name: string; error: string }[] }>('/cv/candidates', fd)
      report(res, t.cv.uploaded)
      void qc.invalidateQueries({ queryKey: ['candidates'] })
      if (res.failed.length === 0) onClose()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t.cv.upload} wide>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
          <Field label={t.cv.consentDate} htmlFor="consent-date">
            <Input id="consent-date" type="date" value={date} max={dayKey(new Date())} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={`${t.cv.consentNote} (${t.common.optional})`} htmlFor="consent-note">
            <Input id="consent-note" value={note} maxLength={1000} placeholder={t.cv.consentNotePlaceholder} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Field label={`${t.cv.referredBy} (${t.common.optional})`} htmlFor="referred-by">
          <Input id="referred-by" value={referral} maxLength={200} placeholder={t.cv.referredByPlaceholder} onChange={(e) => setReferral(e.target.value)} />
        </Field>
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <Checkbox label={t.cv.consentConfirm} checked={confirmed} onChange={setConfirmed} />
        </div>
        <Dropzone
          onFiles={onFiles}
          maxMb={meta.upload_max_mb}
          accept={CV_ACCEPT}
          disabled={busy || !confirmed || !date}
          title={t.cv.drop}
          hint={fmt(t.cv.uploadHint, { mb: meta.upload_max_mb })}
        />
        {busy && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> {t.common.saving}
          </p>
        )}
      </div>
    </Modal>
  )
}

interface Filters {
  prof: string
  country: string
  degree: string
  years: number
  lang: string
  cert: string
  referrer: string
  verified: boolean
}
const NO_FILTERS: Filters = { prof: '', country: '', degree: '', years: 0, lang: '', cert: '', referrer: '', verified: false }
const certKey = (s: string) => s.trim().toLowerCase()
const uniq = (list: (string | null | undefined)[]) => [...new Set(list.filter((x): x is string => !!x))]

// positions: professions of the taxonomy ("p:pm") and job titles the candidates held ("t:civil engineer"), so a new
// kind of position shows up in the filter as soon as a CV with it is parsed
function positionsOf(p: CvProfile): string[] {
  return uniq([
    ...[...(p.meta.positions ?? []).map((x) => x.prof), p.meta.title?.prof, ...p.work.map((w) => w.prof)].map((x) => x && `p:${x}`),
    ...[...(p.meta.positions ?? []).map((x) => x.title), ...p.work.map((w) => w.position)].map((x) => x && `t:${x.trim().toLowerCase()}`),
  ])
}

function passes(c: Candidate, f: Filters): boolean {
  if (f.referrer && c.referred_by !== f.referrer) return false
  const p = c.profile
  if (!p) return !(f.prof || f.country || f.degree || f.years || f.lang || f.cert || f.verified)
  if (f.prof && !positionsOf(p).includes(f.prof)) return false
  if (f.country && !(p.meta.countries ?? []).some((x) => x.country === f.country)) return false
  if (f.degree && !p.education.some((e) => DEGREE_ORDER.indexOf(e.degree ?? '') >= DEGREE_ORDER.indexOf(f.degree))) return false
  if (f.years && (p.meta.totalYears ?? 0) < f.years) return false
  if (f.lang && !p.languages.some((l) => l.language === f.lang) && p.meta.lang !== f.lang) return false // a CV written in it counts
  if (f.cert && !p.certificates.some((x) => certKey(x.name) === f.cert)) return false
  if (f.verified && !p.certificates.some((x) => x.doc) && !p.education.some((x) => x.doc)) return false
  return true
}

export function CvListPage() {
  const { can } = useSession()
  const meta = useCvMeta()
  const [q, setQ] = useState('')
  const [f, setF] = useState<Filters>(NO_FILTERS)
  const set = (patch: Partial<Filters>) => setF({ ...f, ...patch })
  const [uploading, setUploading] = useState(false)
  const [addingDocs, setAddingDocs] = useState(false)
  const list = useQuery({
    queryKey: ['candidates'],
    queryFn: () => api.get<{ items: Candidate[] }>('/cv/candidates'),
    refetchInterval: (query) => (query.state.data?.items.some((c) => c.status === 'pending') ? 3000 : false),
  })
  // every profile in the interface language (Claude's translation when there is one)
  const all = useMemo(() => (list.data?.items ?? []).map((c) => ({ ...c, profile: localProfile(c) })), [list.data])

  // filter choices: only values some candidate has
  const options = useMemo(() => {
    const profiles = all.map((c) => c.profile).filter((p): p is CvProfile => !!p)
    const certs = new Map<string, string>()
    for (const p of profiles) for (const x of p.certificates) if (!certs.has(certKey(x.name))) certs.set(certKey(x.name), x.name)
    // the professions and the job titles the candidates' positions suggest (up to four per CV), as written
    const positions = new Map<string, string>()
    for (const p of profiles) {
      for (const x of p.meta.positions ?? []) {
        if (x.prof) positions.set(`p:${x.prof}`, profLabel(meta.data, x.prof))
        else if (x.title && !positions.has(`t:${x.title.trim().toLowerCase()}`)) positions.set(`t:${x.title.trim().toLowerCase()}`, x.title.trim())
      }
    }
    return {
      positions: [...positions.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      countries: uniq(profiles.flatMap((p) => (p.meta.countries ?? []).map((x) => x.country))).sort((a, b) => countryLabel(meta.data, a).localeCompare(countryLabel(meta.data, b))),
      langs: uniq(profiles.flatMap((p) => [...p.languages.map((l) => l.language), p.meta.lang]).filter(isLangCode)).sort((a, b) => langLabel(a).localeCompare(langLabel(b))),
      certs: [...certs.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      referrers: uniq(all.map((c) => c.referred_by)).sort((a, b) => a.localeCompare(b)),
    }
  }, [all, meta.data])

  const items = useMemo(() => {
    const s = q.trim().toLowerCase()
    return all.filter((c) => {
      if (!passes(c, f)) return false
      if (!s) return true
      const p = c.profile
      return [
        c.code, c.full_name, c.referred_by, p?.basics.label, profLabel(meta.data, p?.meta.title?.prof),
        ...(p?.skills.map((x) => x.name) ?? []),
        p?.basics.summary,
        ...(p?.meta.positions?.map((x) => positionLabel(meta.data, x)) ?? []),
        ...(p?.work.map((w) => placeLabel(meta.data, w.location)) ?? []),
        ...(p?.projects?.flatMap((x) => [x.name, x.customer]) ?? []),
        ...(p?.certificates.map((x) => x.name) ?? []),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s))
    })
  }, [all, q, f, meta.data])
  const filtering = JSON.stringify(f) !== JSON.stringify(NO_FILTERS)
  const filtered = filtering || q.trim() !== ''

  return (
    <>
      <PageHeader
        title={t.cv.title}
        subtitle={t.cv.subtitle}
        actions={
          can('cv.manage') && (
            <>
              <Button icon={<Award className="size-4" />} onClick={() => setAddingDocs(true)}>
                {t.cv.docs.upload}
              </Button>
              <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setUploading(true)}>
                {t.cv.upload}
              </Button>
            </>
          )
        }
      />
      {can('cv.manage') && <DocumentsPanel candidates={list.data?.items ?? []} />}
      {!can('cv.manage') && (
        <p className="mb-4 flex items-center gap-2 text-[13px] text-muted">
          <ShieldCheck className="size-4 text-accent" /> {t.cv.anonymized}
        </p>
      )}
      <div className="mb-4 flex flex-col gap-3">
        <div className="max-w-md">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.cv.search} aria-label={t.common.search} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <FilterSelect label={t.cv.filter.position} value={f.prof} onChange={(prof) => set({ prof })} options={options.positions} />
          <FilterSelect label={t.cv.filter.country} value={f.country} onChange={(country) => set({ country })}
            options={options.countries.map((x) => [x, countryLabel(meta.data, x)])} />
          <FilterSelect label={t.cv.filter.degree} value={f.degree} onChange={(degree) => set({ degree })}
            options={DEGREE_ORDER.map((x) => [x, degreeLabel(x)])} />
          <FilterSelect label={t.cv.filter.years} value={f.years ? String(f.years) : ''} onChange={(v) => set({ years: Number(v) || 0 })}
            options={[1, 3, 5, 10].map((n) => [String(n), fmt(t.cv.filter.yearsN, { n })])} />
          <FilterSelect label={t.cv.filter.language} value={f.lang} onChange={(lang) => set({ lang })}
            options={options.langs.map((x) => [x, langLabel(x)])} />
          <FilterSelect label={t.cv.filter.certificate} value={f.cert} onChange={(cert) => set({ cert })} options={options.certs} />
          {can('cv.manage') && options.referrers.length > 0 && (
            <FilterSelect label={t.cv.filter.referrer} value={f.referrer} onChange={(referrer) => set({ referrer })}
              options={options.referrers.map((x) => [x, x])} />
          )}
          <Checkbox label={t.cv.filter.verified} checked={f.verified} onChange={(verified) => set({ verified })} />
          {filtered && (
            <>
              <span className="text-muted">{fmt(t.cv.filter.shown, { n: items.length, total: all.length })}</span>
              <Button size="sm" variant="ghost" onClick={() => { setF(NO_FILTERS); setQ('') }}>
                {t.cv.filter.reset}
              </Button>
            </>
          )}
        </div>
      </div>
      <Card className="overflow-hidden">
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={<IdCard className="size-8" />} text={q.trim() ? fmt(t.cv.nothing, { q }) : filtering ? t.cv.filter.nothing : t.cv.empty} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-muted">
                  <th className="px-4 py-2.5 font-medium">{t.cv.col.candidate}</th>
                  <th className="px-4 py-2.5 font-medium">{t.cv.col.title}</th>
                  <th className="px-4 py-2.5 font-medium">{t.cv.col.experience}</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">{t.cv.col.education}</th>
                  <th className="hidden px-4 py-2.5 font-medium lg:table-cell">{t.cv.col.skills}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => {
                  const p = c.profile
                  const edu = p ? topEducation(p) : null
                  const certs = p?.certificates ?? []
                  const skills = p?.skills ?? []
                  return (
                    <tr key={c.id} className="align-top hover:bg-surface-2">
                      <td className="px-4 py-3">
                        <Link to={`/cv/${c.id}`} className="font-medium hover:text-accent">
                          {c.full_name || c.code}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                          <span className="num">{c.code}</span>
                          <StatusBadge c={c} />
                          {c.ocr && (
                            <span title={t.cv.ocr}>
                              <ScanText className="size-3.5" aria-label={t.cv.ocr} />
                            </span>
                          )}
                        </div>
                        {c.referred_by && <div className="mt-0.5 text-[12px] text-muted">{fmt(t.cv.referredShort, { name: c.referred_by })}</div>}
                        <div className="num mt-0.5 text-[11px] text-muted" title={t.cv.col.added}>{formatDate(c.created_at)}</div>
                      </td>
                      <td className="max-w-72 px-4 py-3">
                        <span className="block truncate font-medium" title={p?.basics.label ?? undefined}>{p?.basics.label || '—'}</span>
                        {p?.meta.positions?.length ? (
                          <ul className="mt-1 flex flex-col gap-0.5 text-[12px] text-muted" title={t.cv.positions}>
                            {p.meta.positions.slice(0, 3).map((x) => (
                              <li key={x.prof ?? x.title} className="truncate">
                                {positionLabel(meta.data, x)} · {t.cv.seniority[x.level]}, {years(x.years)}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          p?.meta.title?.prof && <span className="text-[12px] text-muted">{profLabel(meta.data, p.meta.title.prof)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="num font-medium">{p ? years(p.meta.totalYears) : '—'}</span>
                        {p?.meta.countries?.map((x) => (
                          <span key={x.country} className="block text-[12px] text-muted" title={t.cv.countries}>
                            {countryLabel(meta.data, x.country)} {years(x.years)}
                          </span>
                        ))}
                        {(p?.projects?.length ?? 0) > 0 && (
                          <span className="block text-[12px] text-muted">{t.cv.projects}: {p!.projects!.length}</span>
                        )}
                      </td>
                      <td className="hidden max-w-64 px-4 py-3 text-[13px] md:table-cell">
                        {edu ? (
                          <span className="block truncate first-letter:uppercase" title={edu.institution}>
                            {edu.degree && <span className="font-medium">{degreeLabel(edu.degree)}</span>}
                            {edu.degree && edu.institution && ' · '}
                            {edu.institution}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                        {certs.length > 0 && (
                          <span className="mt-1 block text-[12px] text-muted" title={certs.map((x) => x.name).join('\n')}>
                            {certs.slice(0, 2).map((x) => x.name).join('; ')}
                            {certs.length > 2 && ` ${fmt(t.cv.more, { n: certs.length - 2 })}`}
                          </span>
                        )}
                      </td>
                      <td className="hidden max-w-80 px-4 py-3 lg:table-cell">
                        <div className="flex flex-wrap gap-1" title={skills.map((s) => s.name).join(', ')}>
                          {skills.slice(0, 8).map((s) => (
                            <Badge key={s.name} className="bg-surface-2 text-ink">{s.name}</Badge>
                          ))}
                          {skills.length > 8 && <Badge className="text-muted">{fmt(t.cv.more, { n: skills.length - 8 })}</Badge>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {can('cv.manage') && <UploadModal open={uploading} onClose={() => setUploading(false)} />}
      {can('cv.manage') && <DocUploadModal open={addingDocs} onClose={() => setAddingDocs(false)} />}
    </>
  )
}

function FilterSelect({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: [string, string][]
}) {
  if (options.length === 0) return null
  return (
    <Select
      aria-label={label}
      title={label}
      className={cn('h-9 w-auto max-w-60 text-[13px]', value ? 'border-accent text-accent' : 'text-muted')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </Select>
  )
}
