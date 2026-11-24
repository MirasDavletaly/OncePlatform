import { useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download, FileDown, Pencil, Plus, Printer, RefreshCw, ScanText, ShieldCheck, Trash2, X } from 'lucide-react'
import { fmt, language, t } from '../../i18n'
import { ApiError, api, errorMessage } from '../../lib/api'
import { formatDate, formatDateTime, formatSize } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { Candidate, CvMeta, CvProfile } from '../../lib/types'
import { cityLabel, countryLabel, degreeLabel, langLabel, levelLabel, localProfile, ProfileView, profLabel, useCvMeta, years } from '../../components/cv'
import { Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Loading, Modal, Select, Textarea, buttonClass, useConfirm, useToast } from '../../components/ui'
import { NotFoundPage } from '../NotFoundPage'
import { StatusBadge } from './CvListPage'
import { CandidateDocuments } from './documents'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

const blankProfile = (): CvProfile => ({
  basics: { name: null, label: null, email: null, phone: null, location: { city: null } },
  work: [],
  projects: [],
  education: [],
  skills: [],
  languages: [],
  certificates: [],
  meta: {},
})

/** Small "list of rows" editor helper. */
function Rows<T>({ items, onChange, render, add, addLabel }: {
  items: T[]
  onChange: (v: T[]) => void
  render: (item: T, set: (patch: Partial<T>) => void) => ReactNode
  add: () => T
  addLabel: string
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg border border-line p-2">
          <div className="min-w-0 flex-1">{render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}</div>
          <IconButton label={t.cv.remove} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X className="size-4" />
          </IconButton>
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...items, add()])}>
          {addLabel}
        </Button>
      </div>
    </div>
  )
}

function ProfileEditor({ c, meta, onClose }: { c: Candidate; meta?: CvMeta; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState(c.full_name ?? '')
  const [referral, setReferral] = useState(c.referred_by ?? '')
  const [p, setP] = useState<CvProfile>(() => structuredClone(c.profile ?? blankProfile()))
  const [skills, setSkills] = useState(() => (c.profile?.skills ?? []).map((s) => s.name).join(', '))
  const basics = (patch: Partial<CvProfile['basics']>) => setP({ ...p, basics: { ...p.basics, ...patch } })
  const save = useMutation({
    mutationFn: () =>
      api.patch<Candidate>(`/cv/candidates/${c.id}`, {
        full_name: name,
        referred_by: referral,
        profile: { ...p, skills: skills.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ name: s })) },
      }),
    onSuccess: (next) => {
      qc.setQueryData(['candidate', c.id], next)
      void qc.invalidateQueries({ queryKey: ['candidates'] })
      toast(t.cv.saved)
      onClose()
    },
  })
  const langs = meta?.languages ?? Object.keys(t.cv.lang)
  const levels = meta?.levels ?? []
  return (
    <Modal
      open
      onClose={onClose}
      title={`${t.cv.edit} ${c.code}`}
      full
      footer={
        <>
          {save.error && <p className="mr-auto self-center text-[13px] text-danger">{errorMessage(save.error)}</p>}
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.cv.f.name}><Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t.cv.f.label}><Input value={p.basics.label ?? ''} onChange={(e) => basics({ label: e.target.value })} /></Field>
          <Field label={t.cv.f.email}><Input value={p.basics.email ?? ''} onChange={(e) => basics({ email: e.target.value })} /></Field>
          <Field label={t.cv.f.phone}><Input value={p.basics.phone ?? ''} onChange={(e) => basics({ phone: e.target.value })} /></Field>
          <Field label={t.cv.f.city}>
            <Input value={p.basics.location.city ?? ''} onChange={(e) => basics({ location: { ...p.basics.location, city: e.target.value } })} />
          </Field>
          <Field label={t.cv.referredBy}>
            <Input value={referral} maxLength={200} placeholder={t.cv.referredByPlaceholder} onChange={(e) => setReferral(e.target.value)} />
          </Field>
        </div>
        <Field label={t.cv.summary}>
          <Textarea rows={3} maxLength={2000} value={p.basics.summary ?? ''} onChange={(e) => basics({ summary: e.target.value || null })} />
        </Field>
        <Field label={t.cv.experience}>
          <Rows
            items={p.work}
            onChange={(work) => setP({ ...p, work })}
            add={() => ({ name: '', position: '', startDate: null, endDate: null, summary: '' })}
            addLabel={t.cv.addJob}
            render={(w, set) => (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input aria-label={t.cv.f.position} placeholder={t.cv.f.position} value={w.position ?? ''} onChange={(e) => set({ position: e.target.value })} />
                <Input aria-label={t.cv.f.company} placeholder={t.cv.f.company} value={w.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
                <Select
                  aria-label={t.cv.f.country}
                  value={w.location?.country ?? ''}
                  onChange={(e) => set({ location: { ...w.location, country: e.target.value || null, inferred: false } })}
                >
                  <option value="">{t.cv.f.country}: —</option>
                  {meta?.countries.map((c) => <option key={c.code} value={c.code}>{countryLabel(meta, c.code)}</option>)}
                </Select>
                <Input
                  aria-label={t.cv.f.cityName}
                  placeholder={t.cv.f.cityName}
                  list="cv-cities"
                  value={cityLabel(meta, w.location?.city)}
                  onChange={(e) => set({ location: { country: w.location?.country ?? null, city: e.target.value || null } })}
                />
                <Field label={t.cv.f.start}>
                  <Input type="month" value={w.startDate ?? ''} onChange={(e) => set({ startDate: e.target.value || null })} />
                </Field>
                <Field label={t.cv.f.end}>
                  <Input type="month" value={w.endDate ?? ''} onChange={(e) => set({ endDate: e.target.value || null })} />
                </Field>
                <Textarea className="sm:col-span-2" rows={2} aria-label={t.cv.f.summary} placeholder={t.cv.f.summary} value={w.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} />
              </div>
            )}
          />
        </Field>
        <Field label={t.cv.education}>
          <Rows
            items={p.education}
            onChange={(education) => setP({ ...p, education })}
            add={() => ({ institution: '', area: null, endDate: null, degree: null })}
            addLabel={t.cv.addEducation}
            render={(e, set) => (
              <div className="grid gap-2 sm:grid-cols-[90px_1fr_1fr_150px]">
                <Input aria-label={t.cv.f.year} placeholder={t.cv.f.year} value={e.endDate ?? ''} onChange={(ev) => set({ endDate: ev.target.value || null })} />
                <Input aria-label={t.cv.f.institution} placeholder={t.cv.f.institution} value={e.institution} onChange={(ev) => set({ institution: ev.target.value })} />
                <Input aria-label={t.cv.f.area} placeholder={t.cv.f.area} value={e.area ?? ''} onChange={(ev) => set({ area: ev.target.value || null })} />
                <Select aria-label={t.cv.f.degree} value={e.degree ?? ''} onChange={(ev) => set({ degree: ev.target.value || null })}>
                  <option value="">{t.cv.f.degree}: —</option>
                  {(meta?.degrees ?? []).map((d) => <option key={d} value={d}>{degreeLabel(d)}</option>)}
                </Select>
              </div>
            )}
          />
        </Field>
        <Field label={t.cv.projects}>
          <Rows
            items={p.projects ?? []}
            onChange={(projects) => setP({ ...p, projects })}
            add={() => ({ name: '', role: null, customer: null, startDate: null, endDate: null, summary: '' })}
            addLabel={t.cv.addProject}
            render={(x, set) => (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input className="sm:col-span-2" aria-label={t.cv.f.project} placeholder={t.cv.f.project} value={x.name} onChange={(e) => set({ name: e.target.value })} />
                <Input aria-label={t.cv.f.role} placeholder={t.cv.f.role} value={x.role ?? ''} onChange={(e) => set({ role: e.target.value || null })} />
                <Input aria-label={t.cv.f.customer} placeholder={t.cv.f.customer} value={x.customer ?? ''} onChange={(e) => set({ customer: e.target.value || null })} />
                <Field label={t.cv.f.start}>
                  <Input type="month" value={x.startDate ?? ''} onChange={(e) => set({ startDate: e.target.value || null })} />
                </Field>
                <Field label={t.cv.f.end}>
                  <Input type="month" value={x.endDate ?? ''} onChange={(e) => set({ endDate: e.target.value || null })} />
                </Field>
                <Textarea className="sm:col-span-2" rows={2} aria-label={t.cv.f.summary} placeholder={t.cv.f.summary} value={x.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} />
              </div>
            )}
          />
        </Field>
        <datalist id="cv-cities">{meta?.cities.map((c) => <option key={c.id} value={cityLabel(meta, c.id)} />)}</datalist>
        <Field label={t.cv.f.skills} hint={t.cv.f.skillsHint}>
          <Textarea rows={3} value={skills} onChange={(e) => setSkills(e.target.value)} />
        </Field>
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label={t.cv.languages}>
            <Rows
              items={p.languages}
              onChange={(languages) => setP({ ...p, languages })}
              add={() => ({ language: langs[0], fluency: null })}
              addLabel={t.cv.addLanguage}
              render={(l, set) => (
                <div className="grid grid-cols-2 gap-2">
                  <Select aria-label={t.cv.f.language} value={l.language} onChange={(e) => set({ language: e.target.value })}>
                    {langs.map((x) => <option key={x} value={x}>{langLabel(x)}</option>)}
                  </Select>
                  <Select aria-label={t.cv.f.level} value={l.fluency ?? ''} onChange={(e) => set({ fluency: e.target.value || null })}>
                    <option value="">—</option>
                    {levels.map((x) => <option key={x} value={x}>{levelLabel(x)}</option>)}
                  </Select>
                </div>
              )}
            />
          </Field>
          <Field label={t.cv.certificates}>
            <Rows
              items={p.certificates}
              onChange={(certificates) => setP({ ...p, certificates })}
              add={() => ({ name: '', date: null })}
              addLabel={t.cv.addCertificate}
              render={(x, set) => (
                <div className="grid grid-cols-[1fr_80px] gap-2">
                  <Input aria-label={t.cv.f.certificate} placeholder={t.cv.f.certificate} value={x.name} onChange={(e) => set({ name: e.target.value })} />
                  <Input aria-label={t.cv.f.year} placeholder={t.cv.f.year} value={x.date ?? ''} onChange={(e) => set({ date: e.target.value || null })} />
                </div>
              )}
            />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

export function CvPage() {
  const { id = '' } = useParams()
  const { can } = useSession()
  const meta = useCvMeta()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const consentInput = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [showText, setShowText] = useState(false)
  const manage = can('cv.manage')

  const q = useQuery({
    queryKey: ['candidate', id],
    queryFn: () => api.get<Candidate>(`/cv/candidates/${id}`),
    refetchInterval: (query) => {
      const c = query.state.data
      return c?.status === 'pending' || c?.documents?.some((d) => d.status === 'pending') ? 3000 : false
    },
  })
  const text = useQuery({
    queryKey: ['candidate-text', id],
    queryFn: () => api.get<{ text: string }>(`/cv/candidates/${id}/text`),
    enabled: showText,
  })
  const refresh = (c: Candidate) => {
    qc.setQueryData(['candidate', id], c)
    void qc.invalidateQueries({ queryKey: ['candidates'] })
  }
  const reparse = useMutation({
    mutationFn: () => api.post<Candidate>(`/cv/candidates/${id}/reparse`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const remove = useMutation({
    mutationFn: () => api.del(`/cv/candidates/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['candidates'] })
      toast(t.cv.deleted)
      navigate('/cv')
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const consent = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append('file', file, file.name)
      return api.post<Candidate>(`/cv/candidates/${id}/consent-file`, fd)
    },
    onSuccess: (c) => {
      refresh(c)
      toast(t.cv.consentFileSaved)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })

  if (q.isPending) return <Loading />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage />
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  }
  const c = q.data
  const p = localProfile(c) // shown in the interface language; the editor works on the original
  const title = p?.meta.title?.prof ? profLabel(meta.data, p.meta.title.prof) : ''
  const translation = p?.meta.lang && p.meta.lang !== language ? c.translation_status?.[language] : 'ok'

  return (
    <>
      <div className="mb-4">
        <Link to="/cv" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> {t.cv.back}
        </Link>
      </div>
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-sm font-semibold text-accent">{c.code}</span>
            <StatusBadge c={c} />
          </div>
          <h1 className="mt-2 font-display text-[21px] leading-snug font-semibold tracking-tight break-words sm:text-[24px]">
            {c.full_name || p?.basics.label || c.code}
          </h1>
          {p && (
            <p className="mt-1 text-sm text-muted">
              {[c.full_name ? p.basics.label : '', title && p.meta.title?.approx ? `${title} (${t.cv.approx})` : title, p.basics.location.city]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)} disabled={c.status === 'pending'}>
              {t.cv.edit}
            </Button>
            {p && (
              <>
                <a className={buttonClass('secondary', 'sm')} href={`/api/v1/cv/candidates/${c.id}/export.docx?lang=en`}>
                  <FileDown className="size-3.5" /> {fmt(t.cv.exportDocx, { lang: 'EN' })}
                </a>
                <a className={buttonClass('secondary', 'sm')} href={`/api/v1/cv/candidates/${c.id}/export.docx?lang=ru`}>
                  <FileDown className="size-3.5" /> {fmt(t.cv.exportDocx, { lang: 'RU' })}
                </a>
                <a className={buttonClass('secondary', 'sm')} href={`/cv/${c.id}/print`} target="_blank" rel="noopener noreferrer">
                  <Printer className="size-3.5" /> {t.cv.print}
                </a>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="size-3.5" />}
              loading={reparse.isPending}
              disabled={c.status === 'pending'}
              onClick={async () => {
                if (await confirm(t.cv.reparseConfirm)) reparse.mutate()
              }}
            >
              {t.cv.reparse}
            </Button>
            {can('cv.delete') && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  if (await confirm(fmt(t.cv.deleteConfirm, { code: c.code }), { danger: true, confirmLabel: t.common.delete })) remove.mutate()
                }}
              >
                {t.cv.delete}
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="min-w-0 p-5">
          {c.status === 'pending' && !p ? (
            <p className="text-sm text-muted">{t.cv.pendingHint}</p>
          ) : c.status === 'failed' && !p ? (
            <EmptyState text={fmt(t.cv.failedHint, { error: c.error ?? '' })} />
          ) : p ? (
            <>
              {c.status === 'failed' && <p className="mb-4 text-[13px] text-danger">{fmt(t.cv.failedHint, { error: c.error ?? '' })}</p>}
              {translation && translation !== 'ok' && (
                <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-muted print:hidden">
                  {fmt(t.cv.translation[translation], { lang: t.cv.translation.langName[language] })}
                </p>
              )}
              <ProfileView profile={p} meta={meta.data} />
            </>
          ) : null}
        </Card>

        <aside className="order-first xl:order-none">
          <Card className="p-5">
            <dl className="divide-y divide-line">
              {p && <Row label={t.cv.totalExperience}>{years(p.meta.totalYears)}</Row>}
              {manage && p && (p.basics.email || p.basics.phone) && (
                <Row label={t.cv.contacts}>
                  {p.basics.email && <span className="block">{p.basics.email}</span>}
                  {p.basics.phone && <span className="num block">{p.basics.phone}</span>}
                </Row>
              )}
              <Row label={t.cv.consent}>
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck className="size-4 text-ok" /> {fmt(t.cv.consentOn, { date: formatDate(c.consent_date + 'T12:00:00Z') })}
                </span>
                {c.consent_note && <span className="mt-0.5 block text-[13px] text-muted">{c.consent_note}</span>}
                {manage && (
                  <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px]">
                    {c.has_consent_file ? (
                      <a href={`/api/v1/cv/candidates/${c.id}/consent-file`} className="inline-flex items-center gap-1 text-accent hover:underline">
                        <Download className="size-3.5" /> {t.cv.consentFile}
                      </a>
                    ) : (
                      <span className="text-muted">{t.cv.noConsentFile}</span>
                    )}
                    <button type="button" className="text-accent hover:underline" onClick={() => consentInput.current?.click()}>
                      {t.cv.consentFileAttach}
                    </button>
                    <input
                      ref={consentInput}
                      type="file"
                      hidden
                      accept=".pdf,.png,.jpg,.jpeg,.docx"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) consent.mutate(f)
                        e.target.value = ''
                      }}
                    />
                  </span>
                )}
              </Row>
              {manage && c.file_name && (
                <Row label={t.cv.sourceFile}>
                  <a href={`/api/v1/cv/candidates/${c.id}/file`} className="block truncate text-accent hover:underline" title={c.file_name}>
                    {c.file_name}
                  </a>
                  <span className="num text-[12px] text-muted">{formatSize(c.size ?? 0)}</span>
                  {c.ocr && <span className="ml-2 text-[12px] text-muted">· {t.cv.ocr}</span>}
                  <button type="button" onClick={() => setShowText(true)} className="mt-1 flex items-center gap-1 text-[13px] text-accent hover:underline">
                    <ScanText className="size-3.5" /> {t.cv.text}
                  </button>
                </Row>
              )}
              {manage && c.referred_by && <Row label={t.cv.referredBy}>{c.referred_by}</Row>}
              <Row label={t.cv.uploadedBy}>
                {c.uploaded_by_name}
                <span className="num block text-[12px] text-muted">{formatDateTime(c.created_at)}</span>
              </Row>
            </dl>
            {p?.meta.sensitiveDetected && p.meta.sensitiveDetected.length > 0 && (
              <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-muted">
                {fmt(t.cv.sensitive, { fields: p.meta.sensitiveDetected.map((f) => t.cv.sensitiveFields[f] ?? f).join(', ') })}
              </p>
            )}
            {c.anonymized && (
              <p className="mt-3 flex items-center gap-2 text-[12px] text-muted">
                <ShieldCheck className="size-4 text-accent" /> {t.cv.anonymized}
              </p>
            )}
          </Card>
          {manage && (
            <Card className="mt-4 p-5">
              <h2 className="mb-3 text-sm font-semibold">{t.cv.docs.title}</h2>
              <CandidateDocuments docs={c.documents ?? []} />
            </Card>
          )}
        </aside>
      </div>

      {editing && <ProfileEditor c={c} meta={meta.data} onClose={() => setEditing(false)} />}
      <Modal open={showText} onClose={() => setShowText(false)} title={`${t.cv.text}: ${c.code}`} full>
        {text.isPending ? (
          <Loading />
        ) : text.data?.text ? (
          <pre className="max-h-[70vh] overflow-auto rounded-lg bg-surface-2 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{text.data.text}</pre>
        ) : (
          <EmptyState text={t.cv.noText} />
        )}
      </Modal>
    </>
  )
}
